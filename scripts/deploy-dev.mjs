import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const wranglerBin = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stdout || ''}${result.stderr || ''}` : '';
    throw new Error(`${command} ${args.join(' ')} failed${detail}`);
  }
  return result;
}

run(process.execPath, ['scripts/init-dev-secrets.mjs']);
run(process.execPath, ['scripts/assert-dev-config.mjs']);
const deployed = run(process.execPath, [
  wranglerBin,
  'deploy',
  '--config',
  'wrangler.dev.jsonc',
  '--secrets-file',
  '.dev.vars'
], { capture: true });
process.stdout.write(deployed.stdout || '');
process.stderr.write(deployed.stderr || '');

const combined = `${deployed.stdout || ''}\n${deployed.stderr || ''}`;
const url = combined.match(/https:\/\/[^\s]+\.workers\.dev\/?/)?.[0] || null;
const versionId = combined.match(/Current Version ID:\s*([0-9a-f-]+)/i)?.[1]
  || combined.match(/Current Deployment ID:\s*([0-9a-f-]+)/i)?.[1]
  || null;
await writeFile(new URL('../.dev-deployment.json', import.meta.url), JSON.stringify({
  worker: 'edgestash-dev',
  url,
  versionId,
  deployedAt: new Date().toISOString()
}, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
