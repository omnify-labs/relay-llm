#!/usr/bin/env tsx
/**
 * litellm-prices-check.ts
 *
 * Fetches the upstream LiteLLM price table and refreshes the vendored copy at
 * vendor/litellm/model_prices_and_context_window.json — but only signals a change
 * when a price WE actually use moves. Mirrors the dassi `pi-mono-version-check.sh`
 * pattern: a lightweight single-file fetch (no giant submodule clone), so it works
 * regardless of how large the upstream repo is.
 *
 * Why "served only": the upstream file holds ~2800 models and is edited many times a
 * week. Relay only bills the handful in SERVED_MODELS. Comparing the normalized
 * served-model prices keeps the sync low-noise — a PR is opened only when a price we
 * charge for changes, never for the thousands of models we ignore.
 *
 * Output: prints `changed=true|false` to stdout and, in GitHub Actions, appends the
 * same line to $GITHUB_OUTPUT. Writes the refreshed vendored file ONLY when changed.
 *
 * Testability override:
 *   LITELLM_PRICES_URL  - override the upstream URL (used by local tests)
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { SERVED_MODELS, ALIASES, normalizeEntry } from '../src/billing/litellm-pricing.js';

const RAW_URL =
  process.env.LITELLM_PRICES_URL ??
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const VENDORED = 'vendor/litellm/model_prices_and_context_window.json';

/** Type of the raw upstream map: model id -> raw LiteLLM entry (only cost fields matter). */
type RawMap = Record<string, Record<string, unknown>>;

/**
 * Deterministic fingerprint of just the SERVED models' normalized pricing.
 * Two raw tables with the same served-model prices produce identical strings,
 * so any difference here means a price relay actually bills for has changed.
 *
 * @param raw - A parsed upstream/vendored LiteLLM price map.
 * @returns Stable JSON string of `{ [servedModel]: ModelPricing | null }`.
 */
function servedFingerprint(raw: RawMap): string {
  const out: Record<string, unknown> = {};
  for (const model of SERVED_MODELS) {
    const key = ALIASES[model] ?? model;
    const entry = raw[key];
    out[model] =
      entry && entry['input_cost_per_token'] != null
        ? normalizeEntry(entry as Parameters<typeof normalizeEntry>[0])
        : null;
  }
  return JSON.stringify(out);
}

async function main(): Promise<void> {
  const res = await fetch(RAW_URL);
  if (!res.ok) throw new Error(`[prices-check] upstream fetch failed: HTTP ${res.status}`);
  const upstreamText = await res.text();
  const upstream = JSON.parse(upstreamText) as RawMap;
  const current = JSON.parse(readFileSync(VENDORED, 'utf8')) as RawMap;

  const changed = servedFingerprint(current) !== servedFingerprint(upstream);

  if (changed) {
    // Refresh the vendored mirror to the exact upstream bytes (clean, reviewable diff).
    writeFileSync(VENDORED, upstreamText.endsWith('\n') ? upstreamText : `${upstreamText}\n`);
  }

  const line = `changed=${changed}`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
