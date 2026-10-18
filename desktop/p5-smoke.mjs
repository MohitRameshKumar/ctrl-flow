/**
 * P5 gate: focus inference does not misfire on Cadence own window.
 *
 * Launches the app (which launches Chrome), drives that Chrome through a scripted session via the
 * app's own CDP connection, and then asks Cadence's Dexie database what it recorded. This is the
 * end-to-end check that the collector, the tab registry, and the navigation mapping all work —
 * none of which a unit test can establish.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ---------------- fixture site ---------------- */
const PAGES = {
  '/alpha': `<!doctype html><title>Alpha</title><h1>Alpha</h1>
     <button id="go" onclick="document.title='Alpha clicked'">Press me</button>
     <input id="q" name="q" />
     <a href="/beta">beta</a>`,
  '/beta': `<!doctype html><title>Beta</title><h1>Beta</h1>
     <button id="spa" onclick="history.pushState({},'','/beta/inner')">in-page nav</button>`,
  '/beta/inner': `<!doctype html><title>Beta inner</title><h1>inner</h1>`,
  '/gamma': `<!doctype html><title>Gamma</title><h1>Gamma</h1>`,
};
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  const body = PAGES[path];
  res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html' });
  res.end(body ?? 'nope');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const userData = mkdtempSync(join(tmpdir(), 'cadence-p5-'));
const electron = join(
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

const child = spawn(electron, ['.', `--user-data-dir=${userData}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CADENCE_P5: BASE },
});

let out = '';
const RESULT = /CADENCE_P5_RESULT (\{.*\})/;

function finish(code, note) {
  try { child.kill(); } catch {}
  server.close();
  setTimeout(() => {
    try { rmSync(userData, { recursive: true, force: true }); } catch {}
    if (note) console.log(note);
    process.exit(code);
  }, 500);
}

const timer = setTimeout(() => {
  console.error('TIMEOUT waiting for P5 result');
  console.error(out.slice(-5000));
  finish(1);
}, 120_000);

function scan(chunk) {
  out += chunk;
  process.stdout.write(chunk);
  const m = RESULT.exec(out);
  if (!m) return;
  clearTimeout(timer);

  let report;
  try { report = JSON.parse(m[1]); } catch (e) { console.error(e); finish(1); return; }

  console.log('\n================ P5 SMOKE ================');
  const entries = Object.entries(report.checks ?? {});
  for (const [name, value] of entries) {
    console.log(`${value === true ? ' ok ' : 'FAIL'}  ${name}${value === true ? '' : `  -- ${JSON.stringify(value)}`}`);
  }
  if (report.eventKinds) console.log('\nevent kinds recorded:', JSON.stringify(report.eventKinds));
  if (report.errors?.length) {
    console.log('\nerrors:');
    for (const e of report.errors) console.log('  ' + e);
  }
  const failed = entries.filter(([, v]) => v !== true);
  finish(failed.length ? 1 : 0, failed.length ? `\n${failed.length} FAILED` : '\nALL GREEN');
}

child.stdout.on('data', (d) => scan(String(d)));
child.stderr.on('data', (d) => scan(String(d)));
child.on('exit', (c) => {
  if (!RESULT.test(out)) { clearTimeout(timer); console.error(`electron exited (${c})`); finish(1); }
});
