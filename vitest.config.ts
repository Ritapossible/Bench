import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  /**
   * The `@/` alias apps/web uses, so a route handler can be tested directly.
   *
   * Next resolves this from tsconfig paths at build time; vitest does not read
   * that, and without it a test importing a route fails to resolve rather than
   * failing an assertion - which reads like the file is missing.
   */
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    /**
     * One file at a time.
     *
     * The integration tests share a single database, and each clears the
     * tables it uses in `beforeEach`. Run in parallel they delete each other's
     * rows mid-test, which surfaces as foreign-key violations in whichever
     * file lost the race - a failure that names the wrong file, appears only
     * sometimes, and reads like a schema bug.
     *
     * Ten seconds of wall clock is worth less than a gate anyone can trust: a
     * suite that fails randomly is one whose next real failure gets re-run
     * instead of read. The alternative - a schema or database per file - buys
     * back the parallelism at the cost of setup nobody would maintain for a
     * suite this size.
     */
    fileParallelism: false,
  },
});
