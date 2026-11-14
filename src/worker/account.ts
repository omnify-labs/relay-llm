/** One durable counter per payer; the central ledger is refreshed outside the hot path. */
import { DurableObject } from 'cloudflare:workers';
import type { Hyperdrive, Queue, DurableObjectState } from '@cloudflare/workers-types';
import type { UsageObservation } from '../proxy/handler.js';
import {
  DEFAULT_ADMISSION_TTL_MS,
  MAX_ADMITTED_RUNS_PER_USER,
  FREE_TIER_PLAN_BASE_CEILING,
  TRIAL_RUN_OVERRUN_USD,
} from '../billing/policy.js';
import * as database from './database.js';

export const SNAPSHOT_MAX_AGE_MS = 30_000;
export const SNAPSHOT_REFRESH_MS = 10_000;
export interface AccountEnv {
  HYPERDRIVE: Hyperdrive;
  USAGE_QUEUE: Queue<UsageObservation>;
}
export interface AdmissionInput {
  accountId: string;
  userId: string;
  runId: string | null;
  provider: string;
  requestId: string;
}
type StateRow = {
  account_id: string;
  snapshot: string | null;
  read_at: number;
  last_active: number;
};

/** Own admission, local debits, and an outbox that survives queue send failures. */
export class AccountGate extends DurableObject<AccountEnv> {
  private refreshing: Promise<void> | null = null;
  private flushing: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: AccountEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK(id=1), account_id TEXT NOT NULL,
        snapshot TEXT, read_at INTEGER NOT NULL DEFAULT 0, last_active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS actors (user_id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (user_id TEXT, run_id TEXT, expires_at INTEGER NOT NULL,
        overrun INTEGER, PRIMARY KEY(user_id,run_id));
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL,
        started_at INTEGER NOT NULL, observation TEXT, cost INTEGER NOT NULL DEFAULT 0,
        included INTEGER NOT NULL DEFAULT 0, enqueued INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS request_outbox ON requests(enqueued) WHERE observation IS NOT NULL;
    `);
  }

  private state(): StateRow {
    const row = this.ctx.storage.sql
      .exec<StateRow>('SELECT * FROM account WHERE id=1')
      .toArray()[0];
    if (!row) throw new Error('Account is not initialized');
    return row;
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const started = Date.now();
      const state = this.state();
      const actors = this.ctx.storage.sql
        .exec<{ user_id: string }>(
          `SELECT user_id FROM actors WHERE seen_at >= ? UNION SELECT user_id FROM requests WHERE included=0 AND observation IS NOT NULL`,
          started - 60_000,
        )
        .toArray()
        .map((row) => row.user_id);
      if (!actors.length) return;
      const pending = this.ctx.storage.sql
        .exec<{ id: string }>(
          'SELECT id FROM requests WHERE included=0 AND observation IS NOT NULL',
        )
        .toArray()
        .map((row) => row.id);
      const sql = database.connect(this.env.HYPERDRIVE);
      try {
        const value = await database.snapshot(sql, state.account_id, actors, pending);
        this.ctx.storage.transactionSync(() => {
          const previous = this.state().snapshot;
          if (previous && JSON.parse(previous).revision !== value.revision)
            this.ctx.storage.sql.exec('DELETE FROM runs');
          for (const id of value.settled)
            this.ctx.storage.sql.exec('UPDATE requests SET included=1 WHERE id=?', id);
          this.ctx.storage.sql.exec(
            'UPDATE account SET snapshot=?, read_at=? WHERE id=1',
            JSON.stringify(value),
            started,
          );
        });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        const invariant =
          error instanceof Error &&
          ['Incomplete account amount', 'Invalid account amount', 'Incomplete snapshot'].includes(
            error.message,
          )
            ? error.message
            : undefined;
        console.error('[Relay] Account snapshot failed', {
          code: typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined,
          invariant,
        });
        throw error;
      } finally {
        await sql.end({ timeout: 1 });
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async fresh(userId: string): Promise<database.AccountSnapshot> {
    let row = this.state();
    let snapshot = row.snapshot ? (JSON.parse(row.snapshot) as database.AccountSnapshot) : null;
    if (!snapshot?.actors[userId] || Date.now() - row.read_at >= SNAPSHOT_MAX_AGE_MS) {
      // A different member may have started the shared refresh before this actor arrived.
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.refresh();
        row = this.state();
        snapshot = row.snapshot ? (JSON.parse(row.snapshot) as database.AccountSnapshot) : null;
        if (snapshot?.actors[userId]) break;
      }
    } else if (Date.now() - row.read_at >= SNAPSHOT_REFRESH_MS) {
      this.ctx.waitUntil(
        this.refresh().catch(() => {
          console.error('[Relay] Account refresh failed');
        }),
      );
    }
    if (!snapshot?.actors[userId] || Date.now() - row.read_at >= SNAPSHOT_MAX_AGE_MS)
      throw new Error('Account snapshot expired');
    return snapshot;
  }

  /** Check the shared account balance and persist a request before provider access. */
  async authorize(input: AdmissionInput): Promise<string> {
    let now = Date.now();
    this.ctx.storage.sql.exec(
      'INSERT INTO account(id,account_id,last_active) VALUES(1,?,?) ON CONFLICT(id) DO NOTHING',
      input.accountId,
      now,
    );
    if (this.state().account_id !== input.accountId) throw new Error('Account mismatch');
    this.ctx.storage.sql.exec(
      'INSERT INTO actors VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET seen_at=excluded.seen_at',
      input.userId,
      now,
    );
    this.ctx.storage.sql.exec('UPDATE account SET last_active=? WHERE id=1', now);
    await this.fresh(input.userId);
    now = Date.now();
    // A background refresh may have completed while fresh() yielded. Its balance and
    // included-usage flags must be read together, with no asynchronous gap.
    const value = JSON.parse(this.state().snapshot!) as database.AccountSnapshot;
    const actor = value.actors[input.userId];
    if (!actor) throw new Error('Missing account actor');
    if (actor.payer !== input.accountId) {
      this.ctx.storage.sql.exec('DELETE FROM runs WHERE user_id=?', input.userId);
      return 'payer_changed';
    }
    if (input.provider === 'deepseek' && !actor.paid) return 'paid_required';
    if (value.budget === null) return 'missing_budget';
    const result = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM runs WHERE expires_at<=?', now);
      const run = input.runId
        ? this.ctx.storage.sql
            .exec<{
              overrun: number | null;
            }>('SELECT overrun FROM runs WHERE user_id=? AND run_id=?', input.userId, input.runId)
            .toArray()[0]
        : undefined;
      if (!run || run.overrun !== null) {
        const pending = this.ctx.storage.sql
          .exec<{
            total: number;
            member: number;
          }>(
            'SELECT coalesce(sum(cost),0) AS total, coalesce(sum(CASE WHEN user_id=? THEN cost ELSE 0 END),0) AS member FROM requests WHERE included=0',
            input.userId,
          )
          .one();
        if (value.spend + pending.total >= value.budget! + (run?.overrun ?? 0))
          return 'budget_exceeded';
        if (actor.memberLimit !== null && actor.memberSpend + pending.member >= actor.memberLimit)
          return 'member_limit';
      }
      if (input.runId) {
        const count = this.ctx.storage.sql
          .exec<{
            count: number;
          }>('SELECT count(*) AS count FROM runs WHERE user_id=?', input.userId)
          .one().count;
        if (run || count < MAX_ADMITTED_RUNS_PER_USER)
          this.ctx.storage.sql.exec(
            `INSERT INTO runs VALUES(?,?,?,?) ON CONFLICT(user_id,run_id) DO UPDATE SET expires_at=excluded.expires_at`,
            input.userId,
            input.runId,
            now + DEFAULT_ADMISSION_TTL_MS,
            value.planBase > FREE_TIER_PLAN_BASE_CEILING * 1e6 ? null : TRIAL_RUN_OVERRUN_USD * 1e6,
          );
      }
      this.ctx.storage.sql.exec(
        'INSERT INTO requests(id,user_id,provider,started_at) VALUES(?,?,?,?)',
        input.requestId,
        input.userId,
        input.provider,
        now,
      );
      return 'allowed';
    });
    await this.schedule();
    return result;
  }

  /** End a run or extend its idle window without granting a new admission. */
  async lifecycle(userId: string, runId: string, action: string): Promise<boolean> {
    if (action === 'end') {
      this.ctx.storage.sql.exec('DELETE FROM runs WHERE user_id=? AND run_id=?', userId, runId);
      return true;
    }
    if (action !== 'keepalive') throw new Error('Invalid lifecycle action');
    this.ctx.storage.sql.exec(
      'UPDATE runs SET expires_at=? WHERE user_id=? AND run_id=? AND expires_at>?',
      Date.now() + DEFAULT_ADMISSION_TTL_MS,
      userId,
      runId,
      Date.now(),
    );
    const alive =
      this.ctx.storage.sql.exec<{ count: number }>('SELECT changes() AS count').one().count > 0;
    if (alive) {
      this.ctx.storage.sql.exec('UPDATE actors SET seen_at=? WHERE user_id=?', Date.now(), userId);
      this.ctx.storage.sql.exec('UPDATE account SET last_active=? WHERE id=1', Date.now());
      await this.schedule();
    }
    return alive;
  }

  /** Debit once and retain the observation until the durable queue accepts it. */
  async observe(event: UsageObservation): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<{
        user_id: string;
        provider: string;
        observation: string | null;
      }>('SELECT user_id,provider,observation FROM requests WHERE id=?', event.requestId)
      .toArray()[0];
    if (!row || row.user_id !== event.userId || row.provider !== event.provider)
      throw new Error('Unknown usage request');
    if (!row.observation)
      this.ctx.storage.sql.exec(
        'UPDATE requests SET observation=?,cost=? WHERE id=?',
        JSON.stringify(event),
        database.observationCost(event),
        event.requestId,
      );
    await this.schedule();
    this.ctx.waitUntil(
      this.flush().catch(() => {
        console.error('[Relay] Usage enqueue failed; retained in account outbox');
      }),
    );
  }

  private async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      // Keep newly observed charges out of the ledger until an in-flight snapshot
      // finishes. Otherwise its balance could include an ID absent from its pending list.
      if (this.refreshing) await this.refreshing.catch(() => {});
      const rows = this.ctx.storage.sql
        .exec<{
          id: string;
          observation: string;
        }>(
          'SELECT id,observation FROM requests WHERE enqueued=0 AND observation IS NOT NULL LIMIT 100',
        )
        .toArray();
      if (!rows.length) return;
      await this.env.USAGE_QUEUE.sendBatch(
        rows.map((row) => ({
          body: JSON.parse(row.observation) as UsageObservation,
        })),
      );
      this.ctx.storage.transactionSync(() => {
        for (const row of rows)
          this.ctx.storage.sql.exec('UPDATE requests SET enqueued=1 WHERE id=?', row.id);
      });
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async schedule(): Promise<void> {
    const next = Date.now() + SNAPSHOT_REFRESH_MS;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > next) await this.ctx.storage.setAlarm(next);
  }

  /** Refresh active accounts and retry retained observations without blocking streams. */
  async alarm(): Promise<void> {
    const active = Date.now() - this.state().last_active < 60_000;
    const tasks: Promise<unknown>[] = [this.flush()];
    if (active) tasks.push(this.refresh());
    const results = await Promise.allSettled(tasks);
    if (results.some((result) => result.status === 'rejected'))
      console.error('[Relay] Account background work failed');
    this.ctx.storage.sql.exec(
      'DELETE FROM requests WHERE included=1 AND enqueued=1 AND started_at<?',
      Date.now() - 86_400_000,
    );
    const pending = this.ctx.storage.sql
      .exec<{
        count: number;
      }>('SELECT count(*) AS count FROM requests WHERE enqueued=0 AND observation IS NOT NULL')
      .one().count;
    if (active || pending) await this.schedule();
  }
}
