import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const wranglerBin = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const configPath = new URL('../wrangler.dev.jsonc', import.meta.url);
const expectedBucket = 'edgestash-storage-dev';

function fail(message) {
  throw new Error(`Development isolation check failed: ${message}`);
}

function runWrangler(args) {
  const result = spawnSync(process.execPath, [wranglerBin, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0) fail(`wrangler ${args.join(' ')} failed: ${result.stdout || ''}${result.stderr || ''}`);
  return result.stdout;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} did not return JSON`);
  }
}

const config = JSON.parse(await readFile(configPath, 'utf8'));
if (config.name !== 'edgestash-dev' || !config.name.endsWith('-dev')) fail('Worker name must be edgestash-dev');
if (config.main !== 'src/index.js') fail('main must be src/index.js');
if (config.vars?.ENVIRONMENT !== 'dev') fail('ENVIRONMENT must be dev');
if (config.routes || config.route) fail('routes/custom domains are forbidden in dev config');
if (config.r2_buckets) fail('R2 bindings are forbidden');
if (config.env?.production) fail('production environment is forbidden');
if (JSON.stringify(config).includes('production')) fail('production identifiers are forbidden');

const d1 = config.d1_databases;
if (!Array.isArray(d1) || d1.length !== 1) fail('exactly one D1 binding is required');
if (d1[0].binding !== 'D1_DB' || d1[0].database_name !== 'edgestash-d1-dev' || !d1[0].database_name.endsWith('-dev')) {
  fail('D1 binding must target edgestash-d1-dev');
}
const d1Info = parseJson(runWrangler(['d1', 'info', d1[0].database_name, '--json']), 'd1 info');
const d1Record = Array.isArray(d1Info) ? d1Info[0] : d1Info;
if (d1Record?.uuid !== d1[0].database_id && d1Record?.id !== d1[0].database_id) fail('D1 ID does not match edgestash-d1-dev');

const kv = config.kv_namespaces;
if (!Array.isArray(kv) || kv.length !== 1 || kv[0].binding !== 'KV_STORE') fail('exactly one KV_STORE binding is required');
const namespaces = parseJson(runWrangler(['kv', 'namespace', 'list']), 'kv namespace list');
const namespace = namespaces.find(item => item.id === kv[0].id);
if (!namespace || namespace.title !== 'edgestash-kv-dev' || !namespace.title.endsWith('-dev')) fail('KV ID does not map to edgestash-kv-dev');

const buckets = runWrangler(['r2', 'bucket', 'list']);
if (!new RegExp(`^name:\\s+${expectedBucket}$`, 'm').test(buckets)) fail(`${expectedBucket} does not exist`);

const secrets = config.secrets?.required;
if (!Array.isArray(secrets) || !secrets.includes('ADMIN_PASSWORD') || !secrets.includes('STORAGE_CONFIG_KEY')) {
  fail('required dev secrets are incomplete');
}
if (!Array.isArray(config.triggers?.crons) || !config.triggers.crons.includes('* * * * *')) fail('dev Cron trigger is missing');

console.log('Development isolation check passed for edgestash-dev');
