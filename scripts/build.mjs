// Dependency-light production build using esbuild (alternative to `vite build`).
// Usage: node scripts/build.mjs            -> dist/
//        RAPIDCARE_NODE_PATH=/some/node_modules node scripts/build.mjs   (resolve react from another location)
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { build } = await import(process.env.ESBUILD_PATH ?? 'esbuild'); // ESBUILD_PATH only needed in unusual setups
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, 'assets'), { recursive: true });

const nodePaths = (process.env.RAPIDCARE_NODE_PATH ?? '').split(':').filter(Boolean);
const result = await build({
  entryPoints: [resolve(root, 'src/main.tsx')],
  bundle: true, minify: true, sourcemap: true, format: 'esm', target: 'es2020', jsx: 'automatic',
  outdir: resolve(out, 'assets'), entryNames: 'app', nodePaths, logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ VITE_ROUTING_PROVIDER: process.env.VITE_ROUTING_PROVIDER ?? 'mock', VITE_MAP_TILE_URL: process.env.VITE_MAP_TILE_URL ?? '' }) },
  loader: { '.css': 'css' },
});
if (result.errors.length) process.exit(1);
let html = readFileSync(resolve(root, 'index.html'), 'utf8');
html = html.replace('<script type="module" src="/src/main.tsx"></script>', '<link rel="stylesheet" href="./assets/app.css" />\n    <script type="module" src="./assets/app.js"></script>');
writeFileSync(resolve(out, 'index.html'), html);
console.log('Built to dist/');
