# Design: Source model pricing from LiteLLM via git submodule + Dependabot

**Date:** 2026-06-18
**Status:** Proposed — awaiting review
**Branch:** `feature/litellm-pricing-submodule`

## Goal

Stop hand-maintaining the pricing table in `src/billing/pricing.ts`. Instead, source per-model
prices from LiteLLM's canonical `model_prices_and_context_window.json`, and have that source update
**automatically** (a dependency bot opens a PR when upstream changes; on merge the change auto-deploys).

## Why a git submodule (not an npm dependency)

Verified facts that drove the choice:

- **LiteLLM cannot be added as a pnpm dependency.** `BerriAI/litellm`'s root `package.json` has **no
  `name` field`**, so both `pnpm add github:BerriAI/litellm` and the tarball-URL form fail with
  `ERR_PNPM_MISSING_PACKAGE_NAME`. There is also **no official npm package** that ships the JSON
  (the npm `litellm` package is an unrelated third-party JS client).
- **A `file:` vendored tarball (the dassi pi-ai pattern) is not bot-trackable.** A dependency bot
  cannot tell whether a local file has a newer upstream version, so it can't auto-PR.
- **A git submodule is natively supported by Dependabot** (`package-ecosystem: gitsubmodule`). It
  bumps the submodule to the latest upstream commit and opens a PR — exactly the "dependency bot in
  push mode" behavior requested. A submodule is *not* an npm dependency, so the missing-`name`
  blocker does not apply; we simply read the JSON file out of the checked-out submodule.

## Architecture

```
relay-llm/
  vendor/
    litellm/                         # git submodule -> BerriAI/litellm (pinned SHA)
      model_prices_and_context_window.json   # the only file we read
  src/billing/
    litellm-pricing.ts   # NEW: load JSON -> normalize to ModelPricing table
    pricing.ts           # calculateCost() now consumes the normalized table
```

### Data flow

1. Build time: `src/billing/litellm-pricing.ts` does `import raw from '../../vendor/litellm/model_prices_and_context_window.json'`.
   tsup + `resolveJsonModule: true` inlines the JSON into `dist/index.js` — **no runtime file dependency**.
2. `litellm-pricing.ts` transforms the raw LiteLLM map into relay's existing `ModelPricing` shape and
   exports a `Record<string, ModelPricing>` (the same shape `calculateCost` already uses).
3. `calculateCost()` is unchanged in logic — it just reads the generated table instead of the hardcoded one.

### Field mapping (LiteLLM per-token → relay per-million, ×1_000_000)

| relay `ModelPricing` field | LiteLLM field |
|---|---|
| `inputPerMillion` | `input_cost_per_token` |
| `outputPerMillion` | `output_cost_per_token` |
| `cachedInputPerMillion` | `cache_read_input_token_cost` |
| `cacheCreationPerMillion` | `cache_creation_input_token_cost` |
| `inputPerMillionAbove200k` | `input_cost_per_token_above_200k_tokens` |
| `outputPerMillionAbove200k` | `output_cost_per_token_above_200k_tokens` |
| `cachedInputPerMillionAbove200k` | `cache_read_input_token_cost_above_200k_tokens` |

All other LiteLLM fields (priority tiers, batch, search-context, `supports_*`, `max_tokens`, the
`sample_spec` doc entry) are **ignored**.

### Model-key alias map (safety-critical)

relay keys models by the provider-returned model ID. 11/13 match LiteLLM keys exactly; 2 do not:

| relay model ID | LiteLLM key |
|---|---|
| `gemini-2.5-pro-preview` | `gemini-2.5-pro` |
| `deepseek-v3.2` | `deepseek-chat` |

A small explicit `ALIASES: Record<string,string>` maps these before lookup. Lookup order:
exact key → alias → `DEFAULT_PRICING`.

### Unknown-model fallback (unchanged, conservative)

`DEFAULT_PRICING` stays (`$3 in / $15 out`, cache at full input rate). Reason: budget enforcement is
**fail-closed** — an unrecognized model must *overestimate* cost, never undercharge. A startup
assertion logs (loudly) any model relay is configured to serve that is missing from the table after
alias resolution, so we notice coverage gaps instead of silently defaulting.

## Build & deploy changes

- **`.gitmodules`**: add `vendor/litellm` → `https://github.com/BerriAI/litellm` (track `main`).
- **Dockerfile**: add `COPY vendor/litellm/model_prices_and_context_window.json ./vendor/litellm/`
  before `pnpm build` (copy the single file, not the whole submodule).
- **Build context**: the build host (manual blue-green on the droplet) and CI must run
  `git submodule update --init --depth 1` before `docker build`. Document in `scripts/deploy.sh`.

## Automation (the "dependency bot, push mode")

- **`.github/dependabot.yml`**: `package-ecosystem: gitsubmodule`, **daily** schedule (Dependabot's
  smallest reliable predefined interval; pricing changes are infrequent so daily is ample). Dependabot
  opens a PR bumping `vendor/litellm` to upstream's latest commit.
- **Noise guard** (`.github/workflows/litellm-pricing-diff.yml`): on Dependabot submodule PRs, diff
  *only* `model_prices_and_context_window.json` between base and PR SHA. If unchanged, auto-close the
  PR with a comment. Reason: LiteLLM's repo commits many times/day, mostly unrelated to pricing.
- **Phase 1 (ship first):** auto-PR + noise guard. A human reviews the price diff and merges; merge to
  `main` triggers deploy. This keeps a human gate on prices entering the fail-closed billing path.
- **Phase 2 (flip when trusted):** enable GitHub auto-merge on the guarded PRs (`enable-pull-request-automerge`)
  for full hands-off "push mode". This is a one-line config flip, deferred by default.
- **Auto-deploy:** relay currently has **no CD** (`scripts/deploy.sh` is manual). A `deploy.yml`
  workflow that builds the image and runs the blue-green deploy on merge to `main` is **in scope** —
  it is what makes "auto-deploy on update" real. (Out of scope: changing the blue-green mechanics.)

## Testing

- `litellm-pricing.test.ts`: conversion math (per-token → per-million), alias resolution, that the 13
  served models all resolve to a non-default price, tiered/above-200k field mapping, and the
  `sample_spec` entry is excluded.
- Existing `pricing.test.ts`: keep all cases. Because real LiteLLM numbers may differ from today's
  hardcoded values, assertions that pinned exact dollar amounts are re-derived from the table (or
  relaxed to relative checks) — documented per-case.

## Out of scope / non-goals

- Moving pricing to a Postgres `model_pricing` table (the old TODO) — superseded by this approach.
- Changing blue-green deploy mechanics.
- Auto-merge enabled by default (Phase 2, opt-in).

## Open risks

1. **Upstream bad price** lands automatically. Mitigated by Phase 1 human gate; Phase 2 only when trusted.
2. **Submodule is a full clone** of a large repo in CI/build. Mitigated with `--depth 1` and copying
   only the single JSON into the Docker context.
3. **LiteLLM renames/removes a key** relay serves → falls to DEFAULT_PRICING. Mitigated by the
   loud startup coverage assertion.
