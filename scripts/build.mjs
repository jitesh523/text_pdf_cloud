import { build } from 'esbuild';

await build({
  entryPoints: ['src/files.js'],
  outfile: 'dist/files.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2021', 'safari15'],
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});
