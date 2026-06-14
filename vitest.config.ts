import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Scoped explicitly. Without an `include`, vitest's default glob walks the whole
    // project and collected `dist/**/*.test.js` — the compiled copies of these same
    // tests, so every failure appeared twice and the stale build was tested as if it
    // were source. `dist/` is gone now; the bound stops it coming back.
    //
    // The audit harnesses (`scripts/smoke.wizards.ts`, `scripts/check.i18n.ts`) are
    // deliberately out of scope: they are standalone scripts with their own runners
    // (`pnpm smoke:wizards`, `pnpm check:i18n`), not vitest suites.
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**', '.wrangler/**'],
  },
});
