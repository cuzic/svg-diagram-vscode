import {defineConfig} from '@vscode/test-cli';

export default defineConfig({
  files: 'dist-test/integration/**/*.test.cjs',
  // two folders: the fixture project (svg-diagram in node_modules) and an unrelated one (a site.json of some other tool)
  workspaceFolder: './test/fixtures/multi-root.code-workspace',
  mocha: {ui: 'tdd', timeout: 20000},
});
