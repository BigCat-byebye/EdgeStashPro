import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const wranglerBin = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const expected = {
  worker: 'edgestash-dev',
  d1: 'edgestash-d1-dev',
  kv: 'edgestash-kv-dev',
  r2: 'edgestash-storage-dev'
};

function runWrangler(args, { allowFailure = false, print = false } = {}) {
  const result = spawnSync(process.execPath, [wranglerBin, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: print ? 'inherit' : ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0 && !allowFailure) {
    const detail = print ? '' : `\n${result.stdout || ''}${result.stderr || ''}`;
    throw new Error(`wrangler ${args.join(' ')} failed${detail}`);
  }
  return result;
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} did not return JSON: ${result.stdout || result.stderr}`);
  }
}

console.log('Verifying Cloudflare identity');
runWrangler(['whoami'], { print: true });

let databases = parseJsonOutput(runWrangler(['d1', 'list', '--json']), 'd1 list');
let database = databases.find(item => item.name === expected.d1);
if (!database) {
  console.log(`Creating D1 ${expected.d1}`);
  runWrangler(['d1', 'create', expected.d1, '--binding', 'D1_DB', '--update-config=false'], { print: true });
  databases = parseJsonOutput(runWrangler(['d1', 'list', '--json']), 'd1 list');
  database = databases.find(item => item.name === expected.d1);
}
if (!database?.uuid) throw new Error(`Unable to resolve D1 ${expected.d1}`);

let namespaces = parseJsonOutput(runWrangler(['kv', 'namespace', 'list']), 'kv namespace list');
let namespace = namespaces.find(item => item.title === expected.kv);
if (!namespace) {
  console.log(`Creating KV ${expected.kv}`);
  runWrangler(['kv', 'namespace', 'create', expected.kv, '--binding', 'KV_STORE', '--update-config=false'], { print: true });
  namespaces = parseJsonOutput(runWrangler(['kv', 'namespace', 'list']), 'kv namespace list');
  namespace = namespaces.find(item => item.title === expected.kv);
}
if (!namespace?.id) throw new Error(`Unable to resolve KV ${expected.kv}`);

let bucketsOutput = runWrangler(['r2', 'bucket', 'list']).stdout;
if (!new RegExp(`^name:\\s+${expected.r2}$`, 'm').test(bucketsOutput)) {
  console.log(`Creating R2 ${expected.r2}`);
  runWrangler(['r2', 'bucket', 'create', expected.r2], { print: true });
  bucketsOutput = runWrangler(['r2', 'bucket', 'list']).stdout;
}
if (!new RegExp(`^name:\\s+${expected.r2}$`, 'm').test(bucketsOutput)) {
  throw new Error(`Unable to resolve R2 ${expected.r2}`);
}

const config = {
  $schema: './node_modules/wrangler/config-schema.json',
  name: expected.worker,
  main: 'src/index.js',
  compatibility_date: '2026-05-15',
  keep_vars: true,
  vars: { ENVIRONMENT: 'dev' },
  secrets: { required: ['ADMIN_PASSWORD', 'STORAGE_CONFIG_KEY'] },
  kv_namespaces: [{ binding: 'KV_STORE', id: namespace.id }],
  d1_databases: [{
    binding: 'D1_DB',
    database_name: expected.d1,
    database_id: database.uuid
  }],
  triggers: { crons: ['* * * * *'] }
};

await writeFile(new URL('../wrangler.dev.jsonc', import.meta.url), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log(`Provisioned isolated dev config for ${expected.worker}`);
