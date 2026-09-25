// Bundles the extension into dist/ with esbuild and copies static assets.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(root, 'src/manifest.json'), 'utf8'));
manifest.version = pkg.version;
await writeFile(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));

await cp(path.join(root, 'public'), dist, { recursive: true });
await cp(path.join(root, 'src/sidepanel/index.html'), path.join(dist, 'sidepanel.html'));
await cp(path.join(root, 'src/sidepanel/theme-boot.js'), path.join(dist, 'theme-boot.js'));
await cp(path.join(root, 'src/sidepanel/styles.css'), path.join(dist, 'sidepanel.css'));

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: {
    background: path.join(root, 'src/background/service-worker.ts'),
    sidepanel: path.join(root, 'src/sidepanel/main.tsx'),
  },
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  legalComments: 'none',
  logLevel: 'info',
  // No remote code: everything is bundled locally, as required by Manifest V3.
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('Watching for changes…');
} else {
  await esbuild.build(options);
  console.log('Built extension into dist/');
}
