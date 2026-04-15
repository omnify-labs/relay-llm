# CLAUDE.md

This repository hosts **Relay LLM** — a thin, transparent LLM proxy that forwards requests directly to providers (OpenAI, Anthropic, Google) with zero format translation. Built with TypeScript, Hono, and deployed on Cloud Run.

## Project Awareness & Context
- **Always check the project structure** at the start of a new conversation to understand the architecture, patterns, and conventions in use.
- **Never assume missing context**. Ask questions if requirements are unclear or contradict existing code.
- **Always confirm file paths and module names** exist before referencing them in code or tests.
- **Never hallucinate libraries or functions** – only use known, verified packages documented in package.json.

## Core Development Philosophy

### Zero Format Translation (Sacred Rule)
- **NEVER parse, modify, or reconstruct request bodies.** The proxy forwards raw bytes to the upstream provider.
- **NEVER parse, modify, or reconstruct response bodies.** Stream responses byte-for-byte back to the client.
- The ONLY place we read response content is for **async token usage extraction** — and this is done on a tee'd copy, never on the client stream.
- This rule exists because format translation causes tool call corruption. LiteLLM, One-API, CoAI, and Plano all break tool calls by translating between API formats. Relay does not.

### Fail-Closed on Budget, Fail-Open on Logging
- If the budget check DB query fails → **reject the request** (prevent runaway spend)
- If usage logging fails → **request still succeeds** (log async, don't block)
- Never sacrifice billing safety for availability.

### Type-Safe, Modular Boundaries
- Type everything (requests, responses, configs). Use strict TypeScript — no `any` unless absolutely necessary with a comment explaining why.
- Keep modules small and single-purpose. Each file in `src/` has one job.
- Use named exports. No default exports.

### Security First
- Provider API keys are **server-side only** — never in responses, logs, or error messages.
- Client authenticates via JWT — never sees provider keys.
- Request/response bodies are **never logged** (privacy). Only metadata: tokens, model, timestamp, latency.
- Redact secrets before any `console.log`.

## Code Structure & Modularity

### Layout
```
src/
  index.ts              # Server entry point (Hono)
  proxy/
    handler.ts          # Request forwarding + SSE streaming passthrough
    providers.ts        # Provider route config + upstream URL mapping
  auth/
    jwt.ts              # JWT validation middleware (HS256)
  admin/
    handler.ts          # Budget management endpoints (PUT/DELETE)
    middleware.ts       # Admin secret auth (timing-safe)
  billing/
    budget.ts           # Per-user budget enforcement middleware
    usage.ts            # Async token usage logging with retry
    pricing.ts          # Model pricing table for cost calculation
  config/
    env.ts              # Environment variable loading + validation
  db/
    client.ts           # Postgres connection (postgres.js)
    queries.ts          # Usage log inserts, budget queries
  __tests__/
    *.test.ts           # Unit tests (Vitest)
scripts/
  test-local.sh         # Integration test script (curl-based)
docs/
  requirements.md       # Full requirements + architectural decisions
  schema.sql            # Database migration
```

### Size & Structure Guidelines
- **Never create a file longer than 500 lines of code**. Keep files ≤ 400 lines, functions ≤ 40 lines. Split before it gets hard to scan.
- **Organize code into clearly separated modules**, grouped by feature or responsibility.
- Use named exports. No barrel files — explicit imports only.

## Coding Standards
- Use `pnpm` as the package manager.
- Format with Prettier (2 spaces, 100 char line width).
- Use `async/await` everywhere. No callbacks.
- **Write JSDoc comments for every exported function** describing parameters, return types, and purpose.
- **Comment non-obvious code** and ensure everything is understandable to a mid-level developer.
- When writing complex logic, **add an inline `// Reason:` comment** explaining the why, not just the what.

## Build & Tooling
- Node.js ≥ 20. Use `pnpm`.
- `tsup` bundles the server; output targets `es2022`.
- Key scripts:
  ```bash
  pnpm install            # install dependencies
  pnpm dev                # run server in watch mode (tsx)
  pnpm build              # production build (tsup)
  pnpm start              # run production build
  pnpm typecheck          # tsconfig strict mode verification
  pnpm lint               # eslint verification
  pnpm test               # unit tests (Vitest)
  ```
- Keep `tsconfig.json` strict. Enable `noImplicitAny`, `strictNullChecks`, `moduleResolution: "bundler"`.
- Use `.env` for local development. Never commit secrets. Document required keys in `.env.example`.

## Testing & QA
- **Always create unit tests for new features** (functions, modules, middleware).
- **After updating any logic**, check whether existing unit tests need to be updated.
- **Unit tests**: Place in `src/__tests__/` using Vitest. Co-locate integration tests in `scripts/`.
- **Test coverage should include**:
  - At least 1 test for expected use case
  - At least 1 edge case test
  - At least 1 failure/error case test
- **Smoke checklist** (run before PR merge):
  1. `pnpm typecheck` passes
  2. `pnpm lint` passes
  3. `pnpm test` — all unit tests pass
  4. `pnpm build` — production build succeeds
  5. `./scripts/test-local.sh <jwt>` — integration tests pass against all 3 providers

## Debugging & Observability
- Use structured `console.log`/`console.error` with `[Relay]` prefix.
- Log every request with: `user_id`, `provider`, `model`, `latency_ms`, `status`, `tokens`.
- Never log request/response bodies.
- Use `x-relay-request-id` header for request tracing.

## Deployment
- **Target: Google Cloud Run** (or any container platform with long-lived connections).
- Docker multi-stage build: `node:22-slim` for builder + runner.
- Cloud Run config: `--timeout 3600 --memory 256Mi --cpu 1`.
- Scale to zero enabled (cost efficiency).

## GitHub Flow Workflow

main (protected) ←── PR (squash merge only) ←── feature/your-feature

1. `git checkout main && git pull origin main`
2. `git worktree add .worktrees/<name> -b feature/<feature-name>` (or `git checkout -b feature/new-feature`)
3. Make changes + run `pnpm lint && pnpm typecheck && pnpm test`
4. `git push origin feature/new-feature`
5. Open PR → review → **squash & merge via GitHub UI or `gh pr merge --squash`**

### Merge Rules
- **NEVER push directly to main.** All changes must go through a PR with squash merge.
- **NEVER merge PRs via command line** (`git merge`). Always use GitHub's squash merge button or `gh pr merge --squash`.
- **NEVER use `git rebase` or `git merge` locally to integrate feature branches into main.**

### Commit Messages
- Do not add `Co-Authored-By` lines to commit messages.

## Search Command Requirements

**Always prefer ripgrep (`rg`) when searching the codebase.**

```bash
# ❌ Avoid
grep -r "pattern" .

# ✅ Use
rg "pattern"
```

## Task Management
- **Create task lists** for complex multi-step tasks to track progress.
- **Mark tasks as completed immediately** after finishing them.
- **Add newly discovered sub-tasks or TODOs** during development.

## Important Notes
- Never guess. Ask for clarification when requirements conflict or are unclear.
- Keep this CLAUDE.md updated when tooling, commands, or architecture changes.
- Always run `pnpm typecheck` and `pnpm lint` prior to opening a PR.
- **Never delete or overwrite existing code** unless explicitly instructed to.
- **Update README.md** when new features are added, dependencies change, or setup steps are modified.

## Useful References
- Hono Docs: https://hono.dev
- jose (JWT): https://github.com/panva/jose
- postgres.js: https://github.com/porsager/postgres
- Cloud Run Docs: https://cloud.google.com/run/docs
- Vitest Docs: https://vitest.dev
- tsup Docs: https://tsup.egoist.dev

---

_This document is living guidance. Update it as the project evolves and new conventions land._
