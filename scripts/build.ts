// Bundles src/extension.ts into dist/extension.cjs (VS Code loads extensions as CommonJS; `vscode` is provided by the host).
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

const options: esbuild.BuildOptions = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

// --tests: also the integration tests, run inside VS Code by @vscode/test-cli (see .vscode-test.mjs)
if (tests) {
  const fs = await import('node:fs');
  const entryPoints = fs.globSync('test/integration/*.test.ts');
  await esbuild.build({entryPoints, outdir: 'dist-test/integration', outExtension: {'.js': '.cjs'}, bundle: true, format: 'cjs', platform: 'node', target: 'node22', external: ['vscode', 'mocha'], sourcemap: true, logLevel: 'info'});
}

if (watch) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
