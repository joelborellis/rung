// Bundle the API into one JavaScript file for deployment.
//
// esbuild rather than tsc: it resolves the extensionless imports the source
// uses, follows into shared/, and emits a single file — so what gets deployed
// has no build-tool dependency and no module-resolution surprises at runtime.
// It comes in transitively with Vite, so this costs no new dependency.
//
// `pg` stays external and is installed on the server from package.json. It is
// the one runtime dependency; bundling a database driver invites trouble with
// its optional native bits for no benefit.

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'server');

mkdirSync(OUT, { recursive: true });

const result = await build({
  entryPoints: [resolve(ROOT, 'api/src/prod-server.ts')],
  outfile: resolve(OUT, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // pg is the only runtime dependency; everything else is our own code.
  external: ['pg'],
  sourcemap: true,
  minify: false, // a readable stack trace in the App Service log stream is worth more
  logLevel: 'info',
  banner: {
    // Some transitive CJS reaches for these under ESM.
    js: [
      "import { createRequire as __cr } from 'node:module';",
      'const require = __cr(import.meta.url);',
    ].join('\n'),
  },
});

if (result.errors.length > 0) process.exit(1);

// A package.json beside the bundle, carrying only what the server actually
// needs at runtime. App Service installs from this, so the deployed node_modules
// is `pg` and nothing else — no React, no Vite, no test tooling.
const root = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
writeFileSync(
  resolve(OUT, 'package.json'),
  `${JSON.stringify(
    {
      name: 'rung-server',
      version: root.version,
      private: true,
      type: 'module',
      main: 'index.js',
      scripts: { start: 'node index.js' },
      dependencies: { pg: root.dependencies.pg },
      engines: { node: '>=22' },
    },
    null,
    2,
  )}\n`,
);

console.log(`\nserver/ bundled — deploy that directory plus dist/ as static assets.`);
