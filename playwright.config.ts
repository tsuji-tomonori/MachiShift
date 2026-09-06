import { defineConfig, devices } from '@playwright/test';

/** CI software-rendered functional regression. Never a target-GPU benchmark. */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 150_000,
  expect: { timeout: 30_000 },
  outputDir: 'reports/playwright-artifacts',
  reporter: [
    ['list'],
    ['json', { outputFile: 'reports/playwright-results.json' }],
    ['html', { outputFolder: 'reports/playwright-html', open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1280, height: 720 },
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 120_000,
  },
  projects: [{
    name: 'chromium-software-functionality',
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 1280, height: 720 },
      launchOptions: {
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
      },
    },
  }],
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
