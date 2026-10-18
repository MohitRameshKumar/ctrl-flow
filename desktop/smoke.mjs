/**
 * Headless-ish P0 smoke test.
 *
 * Launches the built Electron app, waits for the core renderer to settle, then asks the page
 * whether the gate conditions actually hold: the chrome shim installed, `background.main()` ran,
 * Dexie opened, the React tree mounted, and a storage write round-trips through the main process.
 *
 * Run with `node desktop/smoke.mjs`. Exits non-zero on failure so it can gate a build.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const electron = join(
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

// A throwaway userData dir so the smoke test never touches real settings or the real Dexie db.
const userData = mkdtempSync(join(tmpdir(), 'cadence-smoke-'));

const child = spawn(electron, ['.', '--cadence-smoke', `--user-data-dir=${userData}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CADENCE_SMOKE: '1' },
});

let out = '';
const RESULT = /CADENCE_SMOKE_RESULT (\{.*\})/;

function finish(code, note) {
  try {
    child.kill();
  } catch {}
  setTimeout(() => {
    try {
      rmSync(userData, { recursive: true, force: true });
    } catch {}
    if (note) console.log(note);
    process.exit(code);
  }, 300);
}

const timer = setTimeout(() => {
  console.error('TIMEOUT: no smoke result within 60s');
  console.error('--- output ---');
  console.error(out.slice(-4000));
  finish(1);
}, 60_000);

function scan(chunk) {
  out += chunk;
  process.stdout.write(chunk);
  const match = RESULT.exec(out);
  if (!match) return;
  clearTimeout(timer);

  let report;
  try {
    report = JSON.parse(match[1]);
  } catch (err) {
    console.error('could not parse smoke result', err);
    finish(1);
    return;
  }

  console.log('\n================ P0 SMOKE ================');
  const checks = Object.entries(report.checks ?? {});
  for (const [name, value] of checks) {
    console.log(`${value === true ? ' ok ' : 'FAIL'}  ${name}${value === true ? '' : `  -- ${JSON.stringify(value)}`}`);
  }
  const failed = checks.filter(([, v]) => v !== true);
  if (report.errors?.length) {
    console.log('\nrenderer errors:');
    for (const e of report.errors) console.log('  ' + e);
  }
  finish(failed.length ? 1 : 0, failed.length ? `\n${failed.length} FAILED` : '\nALL GREEN');
}

child.stdout.on('data', (d) => scan(String(d)));
child.stderr.on('data', (d) => scan(String(d)));
child.on('exit', (code) => {
  if (!RESULT.test(out)) {
    clearTimeout(timer);
    console.error(`\nelectron exited (${code}) before reporting`);
    finish(1);
  }
});
