// Greps the normal (non-test) build output for the test-hook marker string. Run after a plain
// `npm run build` (no WXT_TEST) — never after `build:test`, which intentionally includes it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const outDir = path.resolve('.output/chrome-mv3');
const MARKER = '__cadenceTest';
let found = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (/\.(js|mjs|html|css|json)$/.test(entry)) {
      const content = readFileSync(full, 'utf8');
      if (content.includes(MARKER)) found.push(full);
    }
  }
}

try {
  walk(outDir);
} catch (err) {
  console.error(`FAIL: could not read ${outDir} — did "npm run build" run first?`);
  console.error(err.message);
  process.exit(1);
}

if (found.length > 0) {
  console.error(`FAIL: test hooks leaked into the normal build:\n${found.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}

console.log(`PASS: ${MARKER} is not present anywhere in the normal build (${outDir})`);
