import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const distDir = path.join(root, 'dist');
fs.mkdirSync(distDir, { recursive: true });

// 1. Bundle UI TypeScript into a single IIFE script string
const uiResult = await esbuild.build({
  entryPoints: [path.join(root, 'src/ui/app.ts')],
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  minify: true,
  write: false,
  sourcemap: false,
});

const uiJs = uiResult.outputFiles[0].text;
const templateHtml = fs.readFileSync(path.join(root, 'src/ui/index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'src/ui/style.css'), 'utf8');

const singleFileHtml = templateHtml
  .replace('/*__INLINE_CSS__*/', () => styleCss)
  .replace('/*__INLINE_JS__*/', () => uiJs);

fs.writeFileSync(path.join(distDir, 'app.html'), singleFileHtml, 'utf8');

// 2. Bundle MCP server into dist/server.js
await esbuild.build({
  entryPoints: [path.join(root, 'src/server.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  outfile: path.join(distDir, 'server.js'),
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  external: [],
});

const htmlSizeKb = (Buffer.byteLength(singleFileHtml, 'utf8') / 1024).toFixed(1);
console.log(`Built dist/app.html (${htmlSizeKb} KB) and dist/server.js`);
