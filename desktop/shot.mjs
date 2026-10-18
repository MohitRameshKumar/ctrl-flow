/**
 * Launches the app and saves a screenshot of the core window, for eyeballing the UI.
 * `node desktop/shot.mjs [outfile]`
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const outFile = process.argv[2] ?? 'cadence-shot.png';
const electron = join(
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

const child = spawn(electron, ['.'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CADENCE_SHOT: outFile },
});

let out = '';
const done = /CADENCE_SHOT_SAVED (.*)/;

const timer = setTimeout(() => {
  console.error('timed out waiting for the screenshot');
  console.error(out.slice(-2000));
  child.kill();
  process.exit(1);
}, 60_000);

function scan(chunk) {
  out += chunk;
  process.stdout.write(chunk);
  if (!done.test(out)) return;
  clearTimeout(timer);
  child.kill();
  setTimeout(() => process.exit(0), 200);
}

child.stdout.on('data', (d) => scan(String(d)));
child.stderr.on('data', (d) => scan(String(d)));
