import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  timeout: 180_000,
  expect: {timeout: 30_000},
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  outputDir: 'test-results',
  reporter: process.env['CI'] ? [['list'], ['html', {open: 'never', outputFolder: 'playwright-report'}]] : 'list',
});
