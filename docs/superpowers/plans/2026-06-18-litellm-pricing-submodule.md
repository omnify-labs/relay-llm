# LiteLLM Pricing via Submodule + Dependabot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Source relay's model pricing from LiteLLM's `model_prices_and_context_window.json` (vendored as a git submodule, auto-bumped by Dependabot) instead of a hand-maintained table.

**Architecture:** Add `BerriAI/litellm` as a git submodule under `vendor/litellm`. A new `src/billing/litellm-pricing.ts` imports the JSON (tsup inlines it at build), converts LiteLLM's per-token rates to relay's per-million `ModelPricing` shape, applies a small alias map, and exports the `PRICING` table that `calculateCost()` already consumes. Dependabot (`gitsubmodule`) opens a PR on upstream changes; a noise-guard workflow auto-closes PRs where the price JSON is unchanged; a deploy workflow ships merges to `main`.

**Tech Stack:** TypeScript (ESM), tsup/esbuild, Vitest, pnpm 10.20.0, git submodules, GitHub Actions, Dependabot.

## Global Constraints

- Node `node:22-slim`; pnpm pinned `10.20.0` (`corepack prepare pnpm@10.20.0`).
- All billing math is **fail-closed**: an unrecognized/uncovered model must overestimate cost via `DEFAULT_PRICING`, never undercharge.
- LiteLLM stores cost **per token**; relay uses **per million** — convert with `× 1_000_000`.
- Commit messages: **no `Co-Authored-By` lines** (repo rule, CLAUDE.md).
- Keep `calculateCost()`'s signature and tiering/clamping logic unchanged — only its data source changes.
- The 13 served model IDs and their LiteLLM keys (verified 2026-06-18, all numerically identical to today's hardcoded table):
  - exact match: `gpt-5.4`, `gpt-4.1`, `gpt-4o`, `o4-mini`, `claude-opus-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`, `gemini-3.5-flash`, `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, `gemini-2.0-flash`
  - aliased: `gemini-2.5-pro-preview` → `gemini-2.5-pro`; `deepseek-v3.2` → `deepseek-chat`

---

### Task 1: Add LiteLLM as a git submodule

**Files:**
- Create: `.gitmodules`
- Create: `vendor/litellm/` (submodule checkout)

**Interfaces:**
- Produces: the file `vendor/litellm/model_prices_and_context_window.json`, importable from `src/billing/`.

- [ ] **Step 1: Add the submodule (shallow)**

```bash
cd <repo-root>
git submodule add --depth 1 https://github.com/BerriAI/litellm vendor/litellm
git -C vendor/litellm config core.sparseCheckout false
```

- [ ] **Step 2: Verify the price file resolves**

Run:
```bash
test -f vendor/litellm/model_prices_and_context_window.json && \
  node -e "const d=require('./vendor/litellm/model_prices_and_context_window.json'); console.log('models:', Object.keys(d).length)"
```
Expected: prints `models: <a few thousand>` (non-zero), no error.

- [ ] **Step 3: Verify our served keys are present**

Run:
```bash
node -e "const d=require('./vendor/litellm/model_prices_and_context_window.json'); for (const k of ['gpt-5.4','claude-sonnet-4-5','gemini-2.5-pro','deepseek-chat']) console.log(k, k in d)"
```
Expected: every line ends `true`.

- [ ] **Step 4: Commit**

```bash
git add .gitmodules vendor/litellm
git commit -m "build: add BerriAI/litellm as git submodule for model pricing"
```

---

### Task 2: Normalizer — `litellm-pricing.ts` (TDD)

**Files:**
- Create: `src/billing/litellm-pricing.ts`
- Test: `src/__tests__/litellm-pricing.test.ts`

**Interfaces:**
- Produces:
  - `interface ModelPricing` (moved here; same fields as today's pricing.ts).
  - `const SERVED_MODELS: readonly string[]`
  - `const ALIASES: Record<string, string>`
  - `function normalizeEntry(entry): ModelPricing`
  - `function lookupRaw(model: string): LiteLLMEntry | null`
  - `function missingServedModels(): string[]`
  - `const PRICING: Record<string, ModelPricing>` (keyed by relay model id)

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/litellm-pricing.test.ts
import { describe, it, expect } from 'vitest';
import {
  PRICING, SERVED_MODELS, ALIASES, normalizeEntry, lookupRaw, missingServedModels,
} from '../billing/litellm-pricing.js';

describe('litellm-pricing', () => {
  it('converts per-token to per-million (×1e6)', () => {
    const p = normalizeEntry({ input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 });
    expect(p.inputPerMillion).toBeCloseTo(3.0, 6);
    expect(p.outputPerMillion).toBeCloseTo(15.0, 6);
  });

  it('maps cache and above-200k fields', () => {
    const p = normalizeEntry({
      input_cost_per_token: 2e-6,
      cache_read_input_token_cost: 2e-7,
      input_cost_per_token_above_200k_tokens: 4e-6,
      output_cost_per_token_above_200k_tokens: 1.8e-5,
      cache_read_input_token_cost_above_200k_tokens: 4e-7,
    });
    expect(p.cachedInputPerMillion).toBeCloseTo(0.2, 6);
    expect(p.inputPerMillionAbove200k).toBeCloseTo(4.0, 6);
    expect(p.outputPerMillionAbove200k).toBeCloseTo(18.0, 6);
    expect(p.cachedInputPerMillionAbove200k).toBeCloseTo(0.4, 6);
  });

  it('omits above-200k fields when absent', () => {
    const p = normalizeEntry({ input_cost_per_token: 2e-6, output_cost_per_token: 8e-6 });
    expect(p.inputPerMillionAbove200k).toBeUndefined();
  });

  it('resolves aliases for non-matching keys', () => {
    expect(lookupRaw('gemini-2.5-pro-preview')).not.toBeNull();
    expect(lookupRaw('deepseek-v3.2')).not.toBeNull();
    expect(ALIASES['gemini-2.5-pro-preview']).toBe('gemini-2.5-pro');
  });

  it('covers every served model with a non-default price', () => {
    expect(missingServedModels()).toEqual([]);
    for (const m of SERVED_MODELS) {
      expect(PRICING[m]).toBeDefined();
      expect(PRICING[m].inputPerMillion).toBeGreaterThan(0);
    }
  });

  it('does not include the sample_spec doc entry as a served model', () => {
    expect(SERVED_MODELS).not.toContain('sample_spec');
    expect(PRICING['sample_spec']).toBeUndefined();
  });

  it('matches known anthropic rates end-to-end (claude-sonnet-4-5)', () => {
    expect(PRICING['claude-sonnet-4-5'].inputPerMillion).toBeCloseTo(3.0, 4);
    expect(PRICING['claude-sonnet-4-5'].outputPerMillion).toBeCloseTo(15.0, 4);
    expect(PRICING['claude-sonnet-4-5'].cachedInputPerMillion).toBeCloseTo(0.3, 4);
    expect(PRICING['claude-sonnet-4-5'].cacheCreationPerMillion).toBeCloseTo(3.75, 4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run src/__tests__/litellm-pricing.test.ts`
Expected: FAIL — cannot resolve `../billing/litellm-pricing.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/billing/litellm-pricing.ts
/**
 * Loads model pricing from the vendored LiteLLM price table and normalizes it
 * into relay's per-million ModelPricing shape.
 *
 * Source of truth: vendor/litellm/model_prices_and_context_window.json
 * (a git submodule of BerriAI/litellm, auto-bumped by Dependabot). tsup inlines
 * the JSON at build time, so there is no runtime file dependency.
 *
 * Reason: LiteLLM stores cost PER TOKEN; relay bills PER MILLION tokens (×1e6).
 */
import rawPrices from '../../vendor/litellm/model_prices_and_context_window.json';

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion: number;
  cacheCreationPerMillion: number;
  inputPerMillionAbove200k?: number;
  outputPerMillionAbove200k?: number;
  cachedInputPerMillionAbove200k?: number;
}

/** Only the LiteLLM fields relay consumes; the file has many more we ignore. */
interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
}

const RAW = rawPrices as unknown as Record<string, LiteLLMEntry>;
const M = 1_000_000;

/**
 * Model IDs relay serves (as returned by the provider in responses).
 * Every entry MUST resolve to a real LiteLLM price — missingServedModels() enforces it.
 */
export const SERVED_MODELS: readonly string[] = [
  'gpt-5.4', 'gpt-4.1', 'gpt-4o', 'o4-mini',
  'claude-opus-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5',
  'gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview',
  'gemini-2.5-pro-preview', 'gemini-2.0-flash', 'deepseek-v3.2',
];

/** relay model id -> LiteLLM key, for the few that don't match exactly. */
export const ALIASES: Record<string, string> = {
  'gemini-2.5-pro-preview': 'gemini-2.5-pro',
  'deepseek-v3.2': 'deepseek-chat',
};

function toMillion(perToken: number | undefined): number {
  return perToken != null ? perToken * M : 0;
}

/** Convert one LiteLLM entry to relay's per-million ModelPricing. */
export function normalizeEntry(entry: LiteLLMEntry): ModelPricing {
  const pricing: ModelPricing = {
    inputPerMillion: toMillion(entry.input_cost_per_token),
    outputPerMillion: toMillion(entry.output_cost_per_token),
    cachedInputPerMillion: toMillion(entry.cache_read_input_token_cost),
    cacheCreationPerMillion: toMillion(entry.cache_creation_input_token_cost),
  };
  if (entry.input_cost_per_token_above_200k_tokens != null) {
    pricing.inputPerMillionAbove200k = toMillion(entry.input_cost_per_token_above_200k_tokens);
  }
  if (entry.output_cost_per_token_above_200k_tokens != null) {
    pricing.outputPerMillionAbove200k = toMillion(entry.output_cost_per_token_above_200k_tokens);
  }
  if (entry.cache_read_input_token_cost_above_200k_tokens != null) {
    pricing.cachedInputPerMillionAbove200k = toMillion(entry.cache_read_input_token_cost_above_200k_tokens);
  }
  return pricing;
}

/** Resolve a relay model id to its LiteLLM entry (via alias), or null. */
export function lookupRaw(model: string): LiteLLMEntry | null {
  const key = ALIASES[model] ?? model;
  return RAW[key] ?? null;
}

/** Served models that have no usable LiteLLM price (input cost missing). */
export function missingServedModels(): string[] {
  return SERVED_MODELS.filter((m) => {
    const e = lookupRaw(m);
    return !e || e.input_cost_per_token == null;
  });
}

/** Build the served-model pricing table, keyed by relay model id. */
function buildPricingTable(): Record<string, ModelPricing> {
  const table: Record<string, ModelPricing> = {};
  for (const model of SERVED_MODELS) {
    const entry = lookupRaw(model);
    if (entry && entry.input_cost_per_token != null) {
      table[model] = normalizeEntry(entry);
    }
  }
  const missing = missingServedModels();
  if (missing.length > 0) {
    // Reason: a missing served model falls to DEFAULT_PRICING (conservative) in
    // calculateCost — log loud so coverage gaps surface instead of silently mischarging.
    console.error(
      `[Relay] LiteLLM pricing MISSING for served models: ${missing.join(', ')} — falling back to DEFAULT_PRICING.`,
    );
  }
  return table;
}

export const PRICING: Record<string, ModelPricing> = buildPricingTable();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- --run src/__tests__/litellm-pricing.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. (If tsc complains about importing a large JSON, confirm `resolveJsonModule: true` is set — it is.)

- [ ] **Step 6: Commit**

```bash
git add src/billing/litellm-pricing.ts src/__tests__/litellm-pricing.test.ts
git commit -m "feat(billing): normalize LiteLLM price table into ModelPricing"
```

---

### Task 3: Point `calculateCost` at the LiteLLM table

**Files:**
- Modify: `src/billing/pricing.ts`
- Modify: `src/__tests__/pricing.test.ts`

**Interfaces:**
- Consumes: `PRICING`, `ModelPricing` from `./litellm-pricing.js`.
- Produces: `calculateCost(model, inputTokens, outputTokens, cachedInputTokens, cacheCreationTokens): number` (unchanged signature).

- [ ] **Step 1: Update the test to derive magnitudes from the table**

Replace the pinned-dollar magnitude assertions so the test verifies the *formula and mapping*, robust to future upstream price changes. Add this import and replace the three "calculates cost for known X" cases plus the `gemini-3.5-flash` case:

```ts
// src/__tests__/pricing.test.ts — top
import { describe, it, expect } from 'vitest';
import { calculateCost } from '../billing/pricing.js';
import { PRICING } from '../billing/litellm-pricing.js';

// helper: expected simple in+out cost from the live table
const io = (m: string, inTok: number, outTok: number) =>
  (inTok / 1e6) * PRICING[m].inputPerMillion + (outTok / 1e6) * PRICING[m].outputPerMillion;
```

```ts
  it('calculates cost for known OpenAI model', () => {
    expect(calculateCost('gpt-5.4', 1000, 500, 0, 0)).toBeCloseTo(io('gpt-5.4', 1000, 500), 6);
  });

  it('calculates cost for known Anthropic model', () => {
    expect(calculateCost('claude-sonnet-4-5', 2000, 1000, 0, 0))
      .toBeCloseTo(io('claude-sonnet-4-5', 2000, 1000), 6);
  });

  it('calculates cost for known Google model', () => {
    expect(calculateCost('gemini-2.0-flash', 10000, 5000, 0, 0))
      .toBeCloseTo(io('gemini-2.0-flash', 10000, 5000), 6);
  });

  it('gemini-3.5-flash resolves to a real (non-default) price', () => {
    const cost = calculateCost('gemini-3.5-flash', 1_000_000, 1_000_000, 0, 0);
    expect(cost).toBeCloseTo(io('gemini-3.5-flash', 1_000_000, 1_000_000), 4);
    expect(cost).not.toBeCloseTo(3.0 + 15.0, 4); // not the DEFAULT_PRICING fallback
  });
```

Keep every other test in the file **unchanged** — the structural cache/tier/clamp cases still hold because the verified LiteLLM numbers equal today's hardcoded ones. (If any pinned-dollar cache/tier case fails because an upstream number drifted, convert that case to the same `PRICING[m]`-derived style; do NOT loosen the structural assertion.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- --run src/__tests__/pricing.test.ts`
Expected: FAIL — `pricing.ts` still defines its own `PRICING`/`ModelPricing`; the import of `PRICING` from `litellm-pricing.js` is unused or duplicated. (Confirms we're about to rewire the source.)

- [ ] **Step 3: Rewire `pricing.ts`**

In `src/billing/pricing.ts`: delete the local `interface ModelPricing`, the hardcoded `const PRICING`, and the source-comment block; import from the normalizer. Keep `DEFAULT_PRICING` and the entire body of `calculateCost` exactly as-is.

```ts
// src/billing/pricing.ts — replace the interface + PRICING table with:
import { PRICING, type ModelPricing } from './litellm-pricing.js';

/**
 * Default pricing for unknown models — intentionally conservative (overestimates cost)
 * so we never undercharge for unrecognized models.
 */
// Reason: charge cached tokens at the full input rate (no discount) for unknown models.
const DEFAULT_PRICING: ModelPricing = {
  inputPerMillion: 3.0, outputPerMillion: 15.0,
  cachedInputPerMillion: 3.0, cacheCreationPerMillion: 3.0,
};
```

Leave `export function calculateCost(...)` and its `const pricing = PRICING[model] || DEFAULT_PRICING;` line untouched.

- [ ] **Step 4: Run the full suite + typecheck**

Run: `pnpm test -- --run && pnpm typecheck`
Expected: all tests PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/billing/pricing.ts src/__tests__/pricing.test.ts
git commit -m "refactor(billing): source calculateCost pricing from LiteLLM table"
```

---

### Task 4: Wire the submodule into build & deploy

**Files:**
- Modify: `Dockerfile`
- Modify: `scripts/deploy.sh`

**Interfaces:**
- Consumes: `vendor/litellm/model_prices_and_context_window.json` must exist in the Docker build context before `pnpm build`.

- [ ] **Step 1: Copy the price file into the Docker build stage**

In `Dockerfile`, in the `builder` stage, add the COPY **before** `RUN pnpm build` (after `COPY src/ ./src/`):

```dockerfile
COPY tsconfig.json ./
COPY src/ ./src/
COPY vendor/litellm/model_prices_and_context_window.json ./vendor/litellm/
RUN pnpm build
```

- [ ] **Step 2: Init the submodule before building, in deploy.sh**

Read `scripts/deploy.sh`. Near the top, before the `docker build`, add:

```bash
# Ensure the LiteLLM pricing submodule is present for the build context.
git submodule update --init --depth 1 vendor/litellm
```

- [ ] **Step 3: Verify a clean build inlines the JSON**

Run:
```bash
rm -rf dist && pnpm install --frozen-lockfile && pnpm build && \
  grep -q "input_cost_per_token" dist/index.js && echo "JSON inlined OK"
```
Expected: prints `JSON inlined OK` (the price data is baked into the bundle).

- [ ] **Step 4: Commit**

```bash
git add Dockerfile scripts/deploy.sh
git commit -m "build: include LiteLLM price submodule in docker build + deploy"
```

---

### Task 5: Dependabot + noise-guard (auto-PR on upstream change)

**Files:**
- Create: `.github/dependabot.yml`
- Create: `.github/workflows/litellm-pricing-diff.yml`

**Interfaces:**
- Produces: a daily Dependabot PR bumping `vendor/litellm`; the guard auto-closes PRs whose price JSON did not change.

- [ ] **Step 1: Add Dependabot config**

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "gitsubmodule"
    directory: "/"
    schedule:
      interval: "daily"
    labels:
      - "submodule"
      - "litellm-pricing"
    commit-message:
      prefix: "build"
```

- [ ] **Step 2: Add the noise-guard workflow**

```yaml
# .github/workflows/litellm-pricing-diff.yml
name: LiteLLM pricing diff guard
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  guard:
    # Only Dependabot submodule PRs for the price table.
    if: ${{ github.actor == 'dependabot[bot]' && contains(github.event.pull_request.labels.*.name, 'litellm-pricing') }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
          fetch-depth: 0
      - name: Check whether the price JSON actually changed
        id: diff
        run: |
          BASE="${{ github.event.pull_request.base.sha }}"
          FILE="vendor/litellm/model_prices_and_context_window.json"
          # Resolve the submodule-pinned blob on base vs. PR head and compare.
          base_blob=$(git ls-tree "$BASE" vendor/litellm | awk '{print $3}')
          head_blob=$(git ls-tree HEAD vendor/litellm | awk '{print $3}')
          if [ "$base_blob" = "$head_blob" ]; then
            echo "changed=false" >> "$GITHUB_OUTPUT"
          else
            # Submodule moved; compare the actual price file content across the two submodule commits.
            git -C vendor/litellm fetch --depth 50 origin "$head_blob" "$base_blob" || true
            if git -C vendor/litellm diff --quiet "$base_blob" "$head_blob" -- model_prices_and_context_window.json; then
              echo "changed=false" >> "$GITHUB_OUTPUT"
            else
              echo "changed=true" >> "$GITHUB_OUTPUT"
            fi
          fi
      - name: Auto-close if price table unchanged
        if: ${{ steps.diff.outputs.changed == 'false' }}
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh pr comment "${{ github.event.pull_request.number }}" \
            --body "Submodule bump does not change \`model_prices_and_context_window.json\` — auto-closing (pricing unchanged)."
          gh pr close "${{ github.event.pull_request.number }}"
```

- [ ] **Step 3: Validate workflow YAML locally**

Run: `python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in ['.github/dependabot.yml','.github/workflows/litellm-pricing-diff.yml']]; print('YAML OK')"`
Expected: `YAML OK`.

- [ ] **Step 4: Commit**

```bash
git add .github/dependabot.yml .github/workflows/litellm-pricing-diff.yml
git commit -m "ci: dependabot auto-PR for LiteLLM pricing + unchanged-diff guard"
```

---

### Task 6: Auto-deploy on merge to main (Phase 1)

> **Verified facts (controller checked 2026-06-19):**
> - `scripts/deploy.sh <docker-image>` deploys a **pre-built image** (blue-green, auto-rollback on health-check fail). It does NOT build — CI must produce an image and pass its ref.
> - The box (`137.184.14.182`) has **no git checkout** and `git archive` excludes submodule contents — so building on the box is NOT viable for the submodule. **Build in CI**, where `actions/checkout` checks out the submodule. `ubuntu-latest` is amd64 = prod arch.
> - The box is already `docker login`'d to `ghcr.io` and runs `ghcr.io/omnify-labs/relay-llm:<sha>`. Image scheme: `ghcr.io/omnify-labs/relay-llm:<full-git-sha>`.
> - **Required repo secrets (controller adds/confirms with user):** `DROPLET_HOST` = `137.184.14.182`, `DROPLET_SSH_KEY` = the `id_ed25519_do_new_jianming` private key. `GITHUB_TOKEN` (automatic) pushes to GHCR via `permissions: packages: write`.

**Files:**
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Produces: pushes `ghcr.io/omnify-labs/relay-llm:${{ github.sha }}`, then runs `/srv/relay-llm/deploy.sh <that image>` on the box.

- [ ] **Step 1: Add the deploy workflow**

```yaml
# .github/workflows/deploy.yml
name: Deploy relay
on:
  push:
    branches: [main]
    paths:
      - "src/**"
      - "vendor/litellm"
      - ".gitmodules"
      - "Dockerfile"
      - "package.json"
      - "pnpm-lock.yaml"

concurrency:
  group: deploy-relay
  cancel-in-progress: false

permissions:
  contents: read
  packages: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Build and push image
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ghcr.io/omnify-labs/relay-llm:${{ github.sha }}
      - name: Deploy over SSH (pull + blue-green)
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.DROPLET_HOST }}
          username: root
          key: ${{ secrets.DROPLET_SSH_KEY }}
          script: |
            set -euo pipefail
            docker pull "ghcr.io/omnify-labs/relay-llm:${{ github.sha }}"
            /srv/relay-llm/deploy.sh "ghcr.io/omnify-labs/relay-llm:${{ github.sha }}"
```

- [ ] **Step 2: Validate YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml')); print('YAML OK')"`
Expected: `YAML OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: auto-deploy relay on merge to main (CI build+push GHCR, blue-green on box)"
```

- [ ] **Step 4 (controller, post-merge — NOT this task):** ensure secrets `DROPLET_HOST` + `DROPLET_SSH_KEY` exist before the first merge to main. The workflow only triggers on push to `main`, so it no-ops on the feature branch.

---

## Self-Review

- **Spec coverage:** submodule (T1) ✓; normalizer + field map + alias + conservative fallback + loud coverage log (T2) ✓; calculateCost rewire (T3) ✓; Dockerfile/deploy.sh build wiring (T4) ✓; Dependabot + noise guard (T5) ✓; Phase-1 auto-deploy (T6) ✓. Phase-2 auto-merge is intentionally deferred (one-line flip, noted in spec, not a task).
- **Placeholder scan:** all code blocks are concrete; T6 is explicitly secrets-gated with a read-first step rather than a guessed deploy contract.
- **Type consistency:** `ModelPricing` defined once in `litellm-pricing.ts` and imported by `pricing.ts` and tests; `PRICING`, `SERVED_MODELS`, `ALIASES`, `normalizeEntry`, `lookupRaw`, `missingServedModels` names match across tasks.
- **Known risk:** the noise-guard's submodule blob comparison (T5 Step 2) depends on fetch depth; if the two submodule commits aren't fetchable at depth 50, it conservatively treats the diff as changed (PR stays open for human review) — acceptable fail-safe.
