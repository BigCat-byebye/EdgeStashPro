import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const wranglerBin = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`);
  return result.stdout || '';
}

run(process.execPath, ['scripts/assert-dev-config.mjs']);
const versions = JSON.parse(run(process.execPath, [wranglerBin, 'versions', 'list', '--name', 'edgestash-dev', '--json'], { capture: true }));
if (!Array.isArray(versions) || versions.length === 0) throw new Error('edgestash-dev has no deployed version');
const latest = versions.reduce((current, item) => Number(item.number) > Number(current.number) ? item : current, versions[0]);

const deployment = JSON.parse(await readFile(new URL('../.dev-deployment.json', import.meta.url), 'utf8'));
if (deployment.worker !== 'edgestash-dev' || !deployment.url?.includes('edgestash-dev')) {
  throw new Error('Missing isolated edgestash-dev deployment URL');
}
const response = await fetch(new URL('/login.html', deployment.url), { redirect: 'manual' });
const html = await response.text();
if (response.status !== 200 || !html.includes('EdgeStashPro')) throw new Error(`Development login smoke failed with ${response.status}`);
console.log(`Verified edgestash-dev version ${latest.id} at ${deployment.url}`);
