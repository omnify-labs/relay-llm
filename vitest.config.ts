import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Reason: the vendored LiteLLM submodule under vendor/ ships its own test
    // suite; scope collection to relay's own tests so `pnpm test` stays ours.
    include: ['src/**/*.test.ts'],
  },
});
