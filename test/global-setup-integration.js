// Applies D1 migrations to the local wrangler state before integration tests run.
// Safe to run multiple times — wrangler skips already-applied migrations.
import { execSync } from 'child_process';

export default function globalSetup() {
  execSync('wrangler d1 migrations apply isdet-tools-db --local', {
    stdio: 'pipe',
    env: { ...process.env, CI: '1' },
  });
}
