import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Builds the extension before the suite runs.
 *
 * Not a convenience. These tests load `.output/chrome-mv3`, so a forgotten build means every
 * assertion silently runs against the previous version — which already cost one debugging round
 * where a passing seed produced a card with the old page titles. Failing loudly on a build error
 * beats passing quietly against stale code.
 */
export default function globalSetup(): void {
  // Invokes wxt's entry script with the current node rather than going through `npm run`.
  // Node refuses to `execFile` a `.cmd` without a shell, and enabling the shell to work around
  // that trades one warning for an unescaped-argument hazard.
  execFileSync(process.execPath, [resolve(ROOT, 'node_modules/wxt/bin/wxt.mjs'), 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  const manifest = resolve(ROOT, '.output/chrome-mv3/manifest.json');
  if (!existsSync(manifest)) {
    throw new Error(`Build finished but ${manifest} is missing — nothing to load.`);
  }
}
