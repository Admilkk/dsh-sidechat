import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
for (const file of ['lib/index.js', 'lib/persistence.js', 'lib/query-view.js', 'lib/client.js', 'cordis.patch.yml', 'dsh.plugin.json', 'README.md', 'LICENSE']) {
  if (!(await stat(path.join(root, file))).isFile()) throw new Error(`Missing package file: ${file}`);
}
const manifest = JSON.parse(await readFile(path.join(root, 'dsh.plugin.json'), 'utf8'));
if (manifest.name !== pkg.name || manifest.version !== pkg.version) throw new Error('Package/manifest identity mismatch');
const client = await readFile(path.join(root, 'lib/client.js'), 'utf8');
let registration;
vm.runInNewContext(client, { window: { __ModuleLoader__: { load(value) { registration = value; } } } }, { timeout: 5000 });
if (registration?.id !== pkg.name || typeof registration.factory !== 'function') throw new Error('Invalid DSH client registration');
if (!pkg.dsh.client.inject.every(name => name.startsWith('@deepseek-ai/'))) throw new Error('Unexpected third-party client seed dependency');
for (const [name] of Object.entries(pkg.dependencies ?? {})) {
  if (/side.?chat|sidenote|better-sidebar/i.test(name)) throw new Error(`Third-party sidebar dependency forbidden: ${name}`);
}
for (const name of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.devDependencies })) {
  if (/openai|codex|side.?chat|sidenote|better-sidebar/i.test(name)) throw new Error(`Reference repository dependency forbidden: ${name}`);
}
console.log('Package identity, client registration and dependency boundary passed');
