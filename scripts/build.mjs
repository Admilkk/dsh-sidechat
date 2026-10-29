import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(process.env.DSH_BUILD_TOOLS
  ? path.resolve(process.env.DSH_BUILD_TOOLS, 'package.json')
  : import.meta.url);
const { build } = require('esbuild');
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await mkdir(path.join(root, 'lib'), { recursive: true });
const common = {
  bundle: true,
  absWorkingDir: root,
  target: 'es2022',
  sourcemap: false,
  legalComments: 'none',
  external: ['@deepseek-ai/*', 'zod', 'cordis', 'react', 'react/*', 'react-dom', 'react-dom/*'],
};
await build({ ...common, entryPoints: ['src/index.mjs'], outfile: 'lib/index.js', format: 'esm', platform: 'node' });
await build({ ...common, entryPoints: ['src/query-view.mjs'], outfile: 'lib/query-view.js', format: 'esm', platform: 'node' });
await build({
  ...common,
  entryPoints: ['src/client.jsx'],
  outfile: 'lib/client.js',
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(metadata.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
});
console.log(`Built ${metadata.name}@${metadata.version}`);
