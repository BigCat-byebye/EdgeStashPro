import { access, chmod, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';

const target = new URL('../.dev.vars', import.meta.url);

try {
  await access(target, constants.F_OK);
  await chmod(target, 0o600);
  console.log('Using existing .dev.vars');
} catch {
  const adminBytes = crypto.getRandomValues(new Uint8Array(24));
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const adminPassword = Buffer.from(adminBytes).toString('base64url');
  const storageKey = Buffer.from(keyBytes).toString('base64');
  const content = `ADMIN_PASSWORD="${adminPassword}"\nSTORAGE_CONFIG_KEY="${storageKey}"\n`;
  await writeFile(target, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  console.log('Created .dev.vars with isolated development secrets');
}
