#!/usr/bin/env node
/**
 * Run the browser tests on one engine (cross-platform env handling).
 *   node scripts/run-e2e.mjs [chromium|webkit]
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const engine = process.argv[2] ?? 'chromium';
if (!['chromium', 'webkit'].includes(engine)) {
  console.error('Usage: node scripts/run-e2e.mjs [chromium|webkit]');
  process.exit(2);
}
const { status } = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'tests/e2e/**/*.test.mjs'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, E2E_BROWSER: engine },
  stdio: 'inherit',
});
process.exit(status ?? 1);
