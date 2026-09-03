import { execSync } from 'node:child_process';

/**
 * Whether a real anvil can be started.
 *
 * Shared rather than copied per suite: the shadow tests had `describe.skipIf`
 * on a private copy and silently skipped in CI for weeks while reporting
 * green, which is why CI now installs Foundry. One definition means one place
 * to look when they are skipping.
 */
export const anvilAvailable = (): boolean => {
  try {
    execSync(`${process.env['ANVIL_BINARY'] ?? 'anvil'} --version`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
