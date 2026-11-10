import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * `vitest.config.ts` does NOT extend `vite.config.ts`, so the React plugin has to be declared here:
 * without it esbuild falls back to the classic JSX runtime and every component test dies with
 * `ReferenceError: React is not defined` (`client/tsconfig.json` is a solution file and carries no
 * `jsx` option). The `include` globs must list `.tsx` too, otherwise a component test is silently
 * skipped while the suite still reports green. `tests/**` carries the node-types half of the token
 * suite (it reads index.css with `node:fs` — see client/tests/tokens.test.ts for why it cannot live
 * in src; dropping this entry silently skips the contrast suite while everything still reports green).
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
});
