import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // WXT maps '@' to the project root (this repo has no srcDir), so '@/lib/x' -> ./lib/x.
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
  },
  test: {
    // Detection is pure by construction, so almost nothing needs a DOM. The one file that does
    // opts in with a `@vitest-environment happy-dom` docblock.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
