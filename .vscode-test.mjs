import {defineConfig} from '@vscode/test-cli';

export default defineConfig({
  files: 'dist-test/integration/**/*.test.cjs',
  workspaceFolder: './test/fixtures/workspace',
  mocha: {ui: 'tdd', timeout: 20000},
});
