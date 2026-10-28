# Cloudflare edge MVP

Browser → Cloudflare Worker → Gemini / DeepSeek. The Worker validates the existing
Supabase JWT locally, makes one admission query through Hyperdrive, then forwards the
native provider request. Responses stream unchanged. An independent tee extracts usage
incrementally and sends metadata to Cloudflare Queues. The consumer atomically inserts
usage, charges credit, and marks the request settled.

One global deployment serves all users. Cloudflare selects ingress; this does not
guarantee an East Asia location or mainland China latency. Validate from the affected
network before making a performance claim.

## Behavior

- Routes: `POST /v1/google/v1beta/models/:model:streamGenerateContent?alt=sse`,
  `POST /v1/google/v1beta/models/:model:generateContent`, and
  `POST /v1/deepseek/chat/completions`.
- Existing provider-native JWT headers, raw bodies, tool signatures, reasoning,
  images, query parameters, run IDs, keepalive and end signals work unchanged.
- Fixed provider hosts only. Browser credentials/cookies are stripped; server keys
  are injected. Redirects are rejected. Requests are never automatically replayed.
- Postgres holds shared admission state. Paid runs may finish beyond credit; trial
  runs retain the existing $2 bounded overrun; untagged calls remain strict. Database
  errors deny access. Admin budget resets revoke admissions across Workers.
- Hyperdrive caching **must be disabled**. Admission reads and modifies billing state.
  Each invocation owns its postgres.js client; Hyperdrive pools origin connections.
- Queue delivery is at least once. Request IDs plus transactions prevent duplicate
  charges. Failed settlements retry, then enter the dead-letter queue.
- Cancellation aborts the provider. Missing final usage is recorded as interrupted or
  unavailable, without fabricating a zero-token charge. Queues protect events after
  successful enqueue; abrupt termination before enqueue can leave a `started` row.
  This MVP does not reconstruct missing provider usage. Inspect unresolved rows and
  the dead-letter queue. Never automatically replay an LLM call after streamed output.

## Deployment

Use a staging database and test account first. Production requires the existing billing
schema/functions plus [`20261027_edge_admission.sql`](migrations/20261027_edge_admission.sql).
Apply as the billing-table owner. This adds private tables/functions and revocation
triggers, without replacing the billing tables. The Worker role needs private-schema
usage, private-table SELECT/INSERT/UPDATE/DELETE, private-function execution, and the
same public billing permissions as Node. Budget writers need permission to run the
revocation trigger and delete private admissions.

1. Create both queues named in `wrangler.jsonc`.
2. Create Hyperdrive for a TLS-enabled Postgres endpoint with `--caching-disabled`.
   For a private database, use a Cloudflare Tunnel and TCP Workers VPC service, then
   create Hyperdrive with `--service-id`. This only changes the billing connection;
   provider streams still travel directly between the Worker and the provider.
3. Copy `wrangler.jsonc` to ignored `wrangler.staging.json`. Set `account_id`, add
   `hyperdrive: [{ "binding": "HYPERDRIVE", "id": "..." }]`, and set
   `vars.ALLOWED_USER_IDS` to the test UUID. `*` enables general access.
4. Upload `JWT_SECRET`, `GOOGLE_API_KEY`, and `DEEPSEEK_API_KEY` using
   `wrangler secret bulk <private-json-file> --config wrangler.staging.json`.
   The JWT secret must match the issuing Supabase instance. Keep secret files private.
5. `pnpm deploy:worker`. Health confirms runtime reachability; authenticated model
   smoke tests confirm actual bindings, admission and provider access.

Staging uses [`edge-billing.sql`](../scripts/fixtures/edge-billing.sql), then the real
edge migration, with a synthetic paid credit account. Fixture schema is **not** a
production migration. Production cutover requires the real billing database and its
migration; never route general traffic to a fixture DB. Only migrate clients using
the supported managed providers. Retain the Node admin/billing endpoints and other
provider routes; this Worker does not replace those APIs.

The validation deployment uses an outbound QUIC tunnel to a loopback-only isolated
Postgres container. Its self-signed development certificate uses VPC certificate
verification mode `disabled`; traffic is encrypted by TLS and the tunnel. Use a
trusted origin certificate and `verify_full` for production.

## Nonlive tests

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test --run
pnpm test:worker
TEST_DATABASE_URL=postgres://user:password@127.0.0.1:5432/postgres pnpm test:database
pnpm build
pnpm build:worker
```

Database tests require a local Postgres role allowed to create/drop disposable DBs.
Remote URLs are rejected. Each run creates a unique DB and drops it on completion.
Worker tests execute in workerd with mocked external I/O. They cover auth, credit
denial, DB failure, byte preservation, progressive SSE/Unicode, tools, images, errors,
redirects, cancellation and queue retries. SQL tests exercise actual locks, concurrent
admissions, paid/trial limits, lifecycle, revocation and concurrent duplicate settlement.
CI runs both suites.

## Live tests

`EDGE_URL=https://<staging-worker> pnpm test:live` uses real providers and a real
Supabase test-account session. The three managed models each get Chinese streaming,
a native tool call and follow-up, an image, cancellation, and a successful next request.
The harness checks CORS, waits for the actual Queue consumer, compares provider token
metadata with the ledger, and checks one charge per completion and matching account spend.

Private setup files (ignored): `.cache/live-env.json` containing `token`, `userId`,
`dbHost`, `dbPort`, `dbPassword`; and `.cache/staging-ca.pem`. The red-square image
fixture is included in `scripts/fixtures/`. Use database `relay_edge_staging`, role
`edge_staging`.
Results go to `.cache/live-results.json`. Refresh expired tokens before rerunning.
These tests incur provider charges.

For provider smoke tests in the local runtime, set `EDGE_LOCAL_RUNTIME=1` and
`EDGE_URL=http://127.0.0.1:8788`. An SSH-forwarded ledger can set `dbTlsServerName`
to its certificate identity. Results explicitly identify local versus Cloudflare
execution. Local execution uses emulated Queues and Hyperdrive and does not prove
deployed service integration.

This is an API smoke harness, not an extension UI test or a mainland latency benchmark.
Run an actual extension conversation on the affected network before claiming the
reported slowdown is fixed. No comparative control deployment is needed.

## Regional speed comparison

`pnpm benchmark:relay` runs the existing production relay and this staging Worker from
the same machine. `BENCH_CONFIG` points to a private JSON file containing a valid test
account `token`, a `location` label and `pairs: 20`. The default is
`.cache/latency-env.json`; `BENCH_OUTPUT` defaults to `.cache/latency-results.json`.
Only the short-lived user session is required, not provider keys or database access.

Each managed model gets one separately reported warmup per endpoint, then 20 matched
pairs: ten short Chinese replies and ten synthetic longer-context summaries. Each pair
sends identical bytes with the same output limit and temperature. Endpoint order is
randomized and balanced per scenario. Requests are sequential; every result records
its request ID, body hash, endpoint order, model version, token/cache metadata and
Cloudflare ingress code when supplied. DeepSeek thinking is disabled; Gemini Flash
uses `low` and Flash-Lite uses `minimal`, with a 4,096-token output allowance. This
measures these settings, not all agent workloads.

First answer timing ignores headers, empty deltas, reasoning and usage-only events.
Total duration, streaming gaps and failures are retained. Failed or incomplete pairs
are excluded from matched speed calculations and explicitly counted as failures.
Warmups are excluded from the measured sample. `pnpm test:benchmark` checks these
measurement boundaries without live requests. The benchmark incurs real model charges.

The comparison includes the staging billing database and production billing database,
so it measures the deployed paths and cannot attribute all differences to Cloudflare.
A regional cloud VM establishes performance from that data-center network. It does not
measure browser rendering, residential/mobile networks or mainland China routing.

## Incomplete usage

```sql
SELECT request_id, provider, outcome, started_at, settled_at
FROM relay_internal.requests
WHERE outcome <> 'complete'
ORDER BY started_at DESC LIMIT 50;
```

Retain request records while queue/dead-letter replay is possible. Retry settlement
with the same request ID. Remove staging resources when finished: Worker, Hyperdrive,
VPC service, tunnel and its connector, both queues, isolated database container and volume.

## Validation on 2026-10-27

The deployed Worker passed all 18 real-provider scenarios: six each for
`gemini-3.8-flash`, `gemini-3.5-flash-lite`, and `deepseek-flash`. Actual Hyperdrive,
Workers VPC, Cloudflare Queues and the isolated Postgres ledger were used with a real
Supabase test-account session. All 18 requests settled: 15 unique completed charges
and three explicit interruptions. Provider token metadata matched the ledger, and
account spend matched the sum of usage charges. The same scenarios passed locally.

Nonlive validation passed 224 existing/shared unit tests, 18 workerd tests and 12
real PostgreSQL integration tests, plus typecheck, lint, Node build and Worker bundle.
The deployed queue entrypoint is covered by a regression test, including the runtime
ExecutionContext argument.

Staging: `https://dassi-relay-edge-mvp.kklt92.workers.dev` (test-account access only).
Worker version: `539522d7-4977-4307-804d-8f0057285541`.
Production routing/billing were not switched. This run did not test the extension UI
or a mainland China network and establishes no before/after latency improvement.

## Tokyo latency result — 2026-10-28 UTC

The regional comparison ran from a temporary Google Cloud VM in `asia-northeast1-b`
(Tokyo), 06:01–06:06 UTC, using Node 18.20.4. It completed 20 matched pairs per model:
120 measured requests plus six separately excluded warmups. All completed successfully.
Body hashes confirmed identical requests within each pair; each scenario had five
current-first and five edge-first pairs. Both paths reported Cloudflare ingress `NRT`.

| Model                 | Current first answer | Edge first answer | Current completion | Edge completion |
| --------------------- | -------------------: | ----------------: | -----------------: | --------------: |
| Gemini 3.8 Flash      |             1,959 ms |          2,210 ms |           2,016 ms |        2,642 ms |
| Gemini 3.5 Flash-Lite |               656 ms |            881 ms |             818 ms |        1,200 ms |
| DeepSeek Flash        |               794 ms |            860 ms |           1,003 ms |        1,083 ms |

These are sample medians across both scenarios. Median within-pair first-answer
penalties for the edge were 328, 215 and 86 ms respectively; it won 7/20, 1/20 and
7/20 pairs. This run demonstrates **no consistent speed improvement from Tokyo**.
Gemini Flash's longer-context timings were variable; a small sample is not a reliable
tail-latency estimate. Do not infer a universal regression or an East Asia-wide result.

Existing Worker logs matched 51 measured requests. Admission took a median 245 ms
(237–399 ms), including the query through Hyperdrive to the staging database in
DigitalOcean `sfo3`. This is a candidate source of overhead, not a demonstrated
explanation of the entire difference. The current relay origin location and matching
provider credentials were not independently verified; this compares the deployed
end-to-end paths rather than isolating Cloudflare as the sole variable.

An earlier pilot used default Gemini thinking and a 1,024-token cap, causing truncated
longer-context replies on both paths. It was stopped and retained separately. The
reported run restarted all pairs with the explicit thinking settings and larger
allowance documented above; no pilot measurements enter this table.

Timing parser tests, typecheck and lint passed. The temporary VM, disk and project SSH
key were removed after collecting results. Raw measurements remain in ignored local
storage; the reusable runner and measurement tests are in `scripts/benchmark-relay*`.
