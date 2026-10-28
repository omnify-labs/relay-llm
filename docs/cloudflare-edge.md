# Cloudflare edge MVP

Browser → Cloudflare Worker → Gemini / DeepSeek. The Worker validates the existing
Supabase JWT locally, checks a durable account counter, then forwards the native provider
request. Responses stream unchanged. An independent tee extracts usage, debits the
account counter and persists an outbox event. Cloudflare Queues carries that metadata to
a consumer that atomically inserts usage, charges central credit, and marks it settled.

One global deployment serves all users. Cloudflare selects ingress; this does not
guarantee an East Asia location or mainland China latency. Validate from the affected
network before making a performance claim. The current prototype is staging-only.

## Removing the synchronous origin read

Each payer (personal account or shared workspace pool) has one SQLite Durable Object.
It serializes run admissions and pending usage, so multiple Workers do not independently
spend a cached balance. A snapshot includes the central balance, active members' caps,
paid eligibility, and IDs of already settled local events. Refresh and local reconciliation
are atomic. New outbox sends wait for an in-flight snapshot to finish, preventing a newly
settled charge from appearing in both the snapshot balance and pending debits.

The Worker caches user-to-payer routing for at most 30 seconds. Active account objects
refresh snapshots every 10 seconds; snapshots older than 30 seconds require a successful
origin refresh before admission. Cold users and idle accounts therefore still wait for
origin reads. The steady-state path is JWT → cached payer → durable admission → provider.
Provider streams bypass the account object.

This is an explicit staging experiment with **up to 30 seconds of delay** for external
subscription, membership, budget or legacy-relay spend changes. Edge observations debit
the local counter immediately. It does not preserve the production policy of immediate
admin revocation. Production adoption of that window remains a product decision.

On first access, East Asian users supply the `apac-ne` location hint, and Southeast/South
Asian users supply `apac-se`. A payer still has one object location, not a copy in every
edge. Hints are best effort; shared global teams or traveling users can be far from their
account object. See [Cloudflare placement semantics](https://developers.cloudflare.com/durable-objects/reference/data-location/).

## Behavior

- Routes: `POST /v1/google/v1beta/models/:model:streamGenerateContent?alt=sse`,
  `POST /v1/google/v1beta/models/:model:generateContent`, and
  `POST /v1/deepseek/chat/completions`.
- Existing provider-native JWT headers, raw bodies, tool signatures, reasoning,
  images, query parameters, run IDs, keepalive and end signals work unchanged.
- Fixed provider hosts only. Browser credentials/cookies are stripped; server keys
  are injected. Redirects are rejected. Requests are never automatically replayed.
- Durable Objects hold shared admission state. Paid runs may finish beyond credit;
  trial runs retain the existing $2 bounded overrun; untagged calls remain strict.
  Failed mandatory refreshes deny access. Budget revisions revoke runs when refreshed.
- Hyperdrive caching **must be disabled** so snapshot age has a defined bound.
  Each invocation owns its postgres.js client; Hyperdrive pools origin connections.
- Queue delivery is at least once. Request IDs plus transactions prevent duplicate
  charges. Failed settlements retry, then enter the dead-letter queue.
- Cancellation aborts the provider. Missing final usage is recorded as interrupted or
  unavailable, without fabricating a zero-token charge. Queues protect events after
  successful enqueue; the account outbox retries failed sends with durable alarms.
  Abrupt termination before observation can leave an unresolved local request row.
  This MVP does not reconstruct missing provider usage. Inspect unresolved rows and
  the dead-letter queue. Never automatically replay an LLM call after streamed output.

## Deployment

Use **Workers Paid**. The Free plan's 10 ms CPU limit terminated longer native streams
in the sustained test; network wait does not count toward this limit, but stream
handling and usage parsing do. `wrangler.jsonc` explicitly caps CPU at 1,000 ms per
invocation. This is a processing ceiling, not a one-second response delay or a reserved
charge. The account must be upgraded before deploying that setting. See
[Cloudflare CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time).

Use a staging database and test account first. Production requires the existing billing
schema/functions plus [`20261027_edge_admission.sql`](migrations/20261027_edge_admission.sql)
and [`20261028_edge_snapshots.sql`](migrations/20261028_edge_snapshots.sql), in that order.
Apply as the billing-table owner. This adds private tables/functions and revocation
triggers, without replacing the billing tables. The Worker role needs private-schema
usage, private-table SELECT/INSERT/UPDATE/DELETE, private-function execution, and the
same public billing permissions as Node. Budget writers need permission to run the
revocation trigger, delete private admissions, and update private budget versions.

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
5. Keep the `ACCOUNTS` Durable Object binding and `account-gate-v1` SQLite migration.
   `pnpm deploy:worker`. Health confirms runtime reachability; authenticated model
   smoke tests confirm actual bindings, admission and provider access.

Staging uses [`edge-billing.sql`](../scripts/fixtures/edge-billing.sql), then the real
edge migrations, with a synthetic paid credit account. Fixture schema is **not** a
production migration. Production cutover requires the real billing database and its
migration; never route general traffic to a fixture DB. Only migrate clients using
the supported managed providers. Retain the Node admin/billing endpoints and other
provider routes; this Worker does not replace those APIs.

### Google Cloud global endpoint evaluation

DeepSeek continues to use `https://api.deepseek.com/chat/completions` directly.
For Gemini, the Worker optionally maps the existing native client route to:

```text
https://aiplatform.googleapis.com/v1/projects/PROJECT/locations/global/publishers/google/models/MODEL:streamGenerateContent?alt=sse
```

`generateContent` uses the same prefix. Only the URL and provider authentication change;
request/response bytes, model IDs, tools, thought signatures, and the payer/usage path
remain the same. This does not call a second relay or introduce another Dassi charge.
Google Cloud charges the configured project's billing account. See Google's
[global endpoint documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations).

For the bounded staging experiment, supply these Worker bindings:

- `GOOGLE_VERTEX_PROJECT`: Google Cloud project ID with the AI Platform API enabled.
- `GOOGLE_VERTEX_ACCESS_TOKEN`: secret, short-lived **service-account** access token.
- `GOOGLE_VERTEX_TOKEN_EXPIRES_AT`: ISO expiry timestamp, accounting for clock margin.

The test VM uses the existing Vertex test identity; its metadata service supplies an
expiring token. No permanent service-account key or human OAuth token is deployed.
Upload the token as a Wrangler secret, never a plain-text config value. Refresh it before
the test if it cannot cover the complete run and five-minute margin. Remove the temporary
bindings after the experiment, and delete the test VM.

All three bindings must be valid. Expired, nearly expired (60 seconds), incomplete, or
invalid Cloud configuration returns 503 before account admission. It never silently
falls back to AI Studio. With all three absent, the original `GOOGLE_API_KEY` route
remains available. Production requires automatic credential renewal and a sustained
deployed test; this manually provisioned token is deliberately evaluation-only.

The usage observer includes `thoughtsTokenCount` in billable Google output alongside
`candidatesTokenCount`, using the final cumulative snapshot once. Both Gemini APIs
report those counts separately; Google bills thinking tokens. See
[Google thinking pricing](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking#pricing).

### Follow-up checks — 2026-10-28 UTC

The Cloudflare dashboard confirmed this account is on Workers Free, establishing the
10 ms effective CPU limit behind the matched Hong Kong `exceededCpu` failures.
The 1,000 ms configuration is prepared; a Paid-plan upgrade is still pending.

Direct Google Cloud API checks from a temporary GCP VM in Hong Kong passed all 12
scenarios across `gemini-3.8-flash` and `gemini-3.5-flash-lite`: Chinese streaming,
tool call, tool-result follow-up, image input, cancellation, and a subsequent request.
Both models also passed a non-streaming preflight. These are functional checks, not
a sustained speed result or proof of Cloudflare-to-provider behavior. The previous
20-minute results below remain the latest completed deployed comparison.

The updated local workerd relay also passed all 18 real-provider scenarios across the
two Gemini models and DeepSeek. All 18 observations settled in the isolated staging
ledger; the 15 completed requests each had exactly one charge, the three interrupted
requests had none, and the account balance matched recorded usage. This validates the
new route and billing integration locally, not the deployed Cloudflare CPU setting.
Nonlive validation passed 237 unit tests, 39 workerd tests, typecheck, lint and both
builds. The temporary credential and local runtime are removed after evaluation.

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
Account tests use actual Durable Object SQLite storage/RPC/alarms with mocked external
I/O: warm requests without SQL, simultaneous members, local debits, snapshot expiry,
reconciliation, retained outbox events, revocation and object reconstruction. Routing
tests exercise the actual Cache API with mocked payer lookup. Expected exceptions are
asserted inside the object because this pinned test pool cannot clean up SQLite after
an RPC rejection; the Worker HTTP 503 behavior is tested separately.
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

### Sustained regional comparison

`pnpm benchmark:soak` keeps all three models active throughout a 10, 15 or 20 minute
measurement window. Run it on the regional client machine, with Node 20+ and the
repository dependencies installed. Create a mode-0600 private JSON file containing
`token`, `location`, `minutes: 20` and the unchanged staging `edgeVersion`. The user
session must remain valid for the entire run plus five minutes.

```bash
BENCH_CONFIG=.cache/soak-env.json BENCH_OUTPUT=.cache/hk-soak-results.json pnpm benchmark:soak
```

Each model has an independent sequential lane. A matched pair starts every 20 seconds,
or when the previous pair finishes if it took longer. There is no catch-up burst. The
lanes alternate short Chinese replies, synthetic longer-context summaries and roughly
600-character stories that exercise streaming. Identical request bytes and model
settings go to both endpoints; their order alternates within each workload. The last
pair may finish after the scheduling window, and actual duration is recorded.
Six warmups occur before that window and remain separate from measured results.

The pinned Undici client uses one HTTP/1.1 keep-alive pool per model and endpoint,
with a 60-second idle allowance. Native socket diagnostics record actual reuse and
reconnection, including cases where the server closes an idle connection. This tests
repeated requests and longer streams over a sustained session; it does not force one
LLM response to remain open for 20 minutes. It also does not reproduce browser HTTP/2
or HTTP/3 behavior.

The private report includes first-answer and completion p50/p95, maximum answer and
raw-byte gaps, counts of answer pauses of at least two and five seconds, failures,
mid-stream errors, and connection reuse. Results are split by model, workload and
two-minute windows. Failed pairs remain visible and are excluded only from matched
speed calculations. HTTP 401/402/403 stops the session, including during warmup; other warmup failures
remain separate and do not prevent measuring persistent provider errors for the full
window. Measured requests have no automatic LLM retries. Bodies, headers and credentials are never
written to the report. `pnpm test:benchmark` verifies timing, scheduling, failure
accounting and actual TCP reuse against a local server without provider calls.

For regional comparisons, leave both deployments and account placement unchanged,
record the VM zone and staging revision, and retain the full run even if the edge
loses. Compare latency, stalls and failures across the entire period before drawing a
conclusion. A cloud VM result supports only that network and observation window; it
does not establish mainland customer performance. The result summaries below distinguish locations and provider failures.

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

## Durable account prototype result — 2026-10-28 UTC

Worker version `e777c325-3e93-4283-9501-43eb040f7648` uses the account architecture
described above. All 224 shared unit tests, 37 workerd tests, 16 PostgreSQL integration
tests and five benchmark tests passed, along with typecheck, lint and builds.

The first live warmup exposed a PostgreSQL array-encoding error with `fetch_types:false`.
That run stopped before measured pairs. Snapshot parameters now use the driver's native
JSON binding; SQL tests use the same driver setting as Hyperdrive. The corrected run
restarted all pairs and completed without failures.

The same Tokyo runner and benchmark settings ran 07:19:49–07:24:03 UTC: 120 measured
requests and six excluded warmups, all successful. Both paths reported `NRT`. Body
hashes and balanced endpoint order were verified again. DeepSeek cache hits were
balanced at five requests per endpoint.

| Model | Current first answer | Edge first answer | Current completion | Edge completion |
| --- | ---: | ---: | ---: | ---: |
| Gemini 3.8 Flash | 2,486 ms | 2,480 ms | 2,569 ms | 2,671 ms |
| Gemini 3.5 Flash-Lite | 706 ms | 795 ms | 820 ms | 1,064 ms |
| DeepSeek Flash | 817 ms | 726 ms | 1,063 ms | 1,004 ms |

These are sample medians. Within-pair first-answer savings were **-475 ms, -91 ms,
and +66 ms** respectively, with the edge winning 7/20, 5/20 and 12/20 pairs. Gemini
Flash's similar overall medians conceal variable, often slower paired results. This
supports a modest DeepSeek improvement in this sample, not a consistent Gemini gain
or a global speed guarantee. Different deployed provider credentials remain an
unverified comparison factor.

Sixteen measured request IDs matched captured admission logs: median **37 ms**, range
31–129 ms, versus the prior origin-query sample's 245 ms median. The separately captured
cold warmup required 856 ms for admission. The warm billing wait is substantially
reduced; first-use and expired-state refreshes still cross to the origin. Removing
the billing wait alone does not make every provider path faster.

The corrected deployed gateway also passed all 18 live functional scenarios across
the three models. All 18 observations settled: 15 unique completed charges and three
interruptions. Token metadata and account spend reconciled with the ledger. This live
suite ran after the regional benchmark to avoid overlapping provider traffic.

The temporary Tokyo VM, disk and project SSH key were removed. Production routing and
billing remain unchanged. The prototype is ready for review; a blanket Gemini cutover
is not supported by these latency results. The 30-second external-policy update window
also remains staging-only pending the product decision described above.

## Sustained Singapore and Hong Kong results — 2026-10-28 UTC

The unchanged Worker `e777c325-3e93-4283-9501-43eb040f7648` was compared with
`relay.dassi.ai` using the sustained protocol above. DigitalOcean `sgp1` ran
17:39:06–17:59:10 UTC (1,204 seconds, 360 measured requests); Google Cloud
`asia-east2-b` ran 17:45:22–18:05:22 UTC (1,200 seconds, 354 measured requests).
Both used Node 22.23.4 and Undici 6.29.1. Each location excluded six warmups.
Every completed pair had matching body hashes. All models were sampled throughout;
endpoint order differed by at most one pair within each model/workload. Variable
response durations and the scheduling deadline produced 59/61/60 Singapore pairs
and 57/60/60 Hong Kong pairs for Flash/Flash-Lite/DeepSeek respectively.

Times below are successful-request first-answer p50/p95 in milliseconds; errors
are counted separately and never treated as fast replies. Percentiles use nearest rank.

| Location | Model | Current p50 / p95 | Edge p50 / p95 | Current failures | Edge failures |
| --- | --- | ---: | ---: | ---: | ---: |
| Singapore | Gemini 3.8 Flash | 2,169 / 7,759 | 2,366 / 11,321 | 0/59 | 1/59 |
| Singapore | Gemini 3.5 Flash-Lite | 869 / 1,274 | 1,095 / 1,350 | 0/61 | 1/61 |
| Singapore | DeepSeek Flash | 1,057 / 1,300 | 667 / 938 | 0/60 | 6/60 |
| Hong Kong | Gemini 3.8 Flash | 2,209 / 11,418 | No successful responses | 1/57 | 57/57 |
| Hong Kong | Gemini 3.5 Flash-Lite | 794 / 1,245 | No successful responses | 0/60 | 60/60 |
| Hong Kong | DeepSeek Flash | 793 / 1,069 | 650 / 862 | 0/60 | 14/60 |

DeepSeek's median within-pair first-answer savings were **327 ms (34.7%) in
Singapore**, winning 52/54 completed pairs, and **145 ms (20.6%) in Hong Kong**,
winning 33/46 completed pairs. Savings were positive across all three workloads
in each location. Singapore had positive paired medians in all ten two-minute
windows, although the 8–10 minute window retained only one complete pair after
failures. Hong Kong had positive paired medians in seven of ten windows; later
windows had few complete pairs because streams failed. This is a speed benefit
among completed requests, not a reliable-service improvement.

Singapore Gemini Flash and Flash-Lite had median paired penalties of **349 ms
and 223 ms**; the edge won only 22/58 and 13/60 completed pairs. Both penalties
persisted across all three workloads. Successful completion p50/p95 were:

| Location / model | Current completion | Edge completion |
| --- | ---: | ---: |
| Singapore / Flash | 5,512 / 11,262 ms | 3,284 / 11,598 ms |
| Singapore / Flash-Lite | 1,115 / 2,824 ms | 1,442 / 2,990 ms |
| Singapore / DeepSeek | 1,496 / 5,687 ms | 1,062 / 5,082 ms |
| Hong Kong / Flash | 4,037 / 11,956 ms | No successful responses |
| Hong Kong / Flash-Lite | 1,094 / 2,986 ms | No successful responses |
| Hong Kong / DeepSeek | 1,177 / 4,769 ms | 958 / 4,974 ms |

The sustained run exposed two distinct deployment problems:

- All 117 Hong Kong edge Gemini requests returned HTTP 400. Separate diagnostic
  calls for both models confirmed `FAILED_PRECONDITION` with an unsupported-location
  error. [Google's Gemini API region list](https://ai.google.dev/gemini-api/docs/available-regions)
  excludes Hong Kong. The initial Hong Kong preflight stopped before measurement;
  its two requests and two diagnostic calls remain separate. The runner then retained
  non-access warmup errors and measured the complete 20-minute window without a relay change.
- All **14 Hong Kong DeepSeek stream failures** matched request IDs with Cloudflare
  outcome `exceededCpu`. Every one had already delivered some answer text. Cloudflare
  documents this as [CPU-limit termination](https://developers.cloudflare.com/workers/platform/limits/#cpu-time).
  The effective account CPU budget was not verified; the script has no explicit
  `limits` setting. Singapore had eight empty/incomplete/unreadable stream failures
  on the edge, but capture started after that cluster, so their exact cause is unconfirmed.
  The current relay had one Hong Kong Flash timeout before headers at the 90-second limit.

Persistent connections were actually exercised. After warmup, Singapore reused
connections for 180/180 current and 177/180 edge requests; Hong Kong reused them
for 176/177 current and 175/177 edge requests. Some sockets spanned the entire
session. Both paths reported local Cloudflare ingress (`SIN` or `HKG`). There were
no measured gaps of two seconds between received answer events, but this does not
negate truncated streams or the pre-answer timeout. Client cancellation of failed
responses can also close a socket, so reconnect counts alone are not network-failure counts.

Matched admission logs captured after the Singapore failure cluster showed median
admission of 106 ms for 88 Singapore requests and 73 ms for 145 Hong Kong requests.
The production relay container's Google and DeepSeek keys matched the saved staging
provisioning file in a private comparison; live Worker secrets cannot be read back.

These runs support a DeepSeek latency opportunity and reject a blanket customer
cutover of this staging deployment. Provider-region compatibility and CPU-limit
terminations need resolution before repeating the same sustained test. These are
cloud VM HTTP/1.1 sessions, not browser HTTP/2/3 or mainland residential/mobile tests.
The runs partly overlapped using one test account, with up to three active model
requests per location; they are not independent measurements of whole-region performance.

The reusable runner passed 12 nonlive benchmark tests, 224 unit tests, typecheck,
lint and the Node build. Raw results, sanitized Worker evidence and the time-series
chart remain in ignored local storage. Both temporary VMs and disks were removed;
the existing SSH key was reused, with Hong Kong access scoped to that instance.
Production routing, provider configuration, billing architecture and Worker deployment
were unchanged throughout the experiment.
