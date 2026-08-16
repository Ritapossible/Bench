import {
  notImplemented,
  type AuditionWindow,
  type ForkHandle,
  type ForkProvider,
  type Hex,
  type SpawnForkOptions,
} from '@bench/core';

/**
 * Anvil-backed fork provider. Phase 2 — the longest pole in the build.
 *
 * Shape of the real implementation, recorded here so Phase 2 starts from a
 * decision rather than a blank file:
 *
 *   1. `anvil --fork-url <archive> --fork-block-number <n>` on a free port.
 *      An ARCHIVE node is mandatory; a pruned node cannot serve historical
 *      state and fails confusingly mid-run.
 *   2. Seed the mirrored position by direct state manipulation
 *      (anvil_setStorageAt / anvil_setBalance / anvil_impersonateAccount)
 *      rather than by replaying user transactions — faster and exact.
 *   3. Put a thin JSON-RPC proxy in front of the anvil port. That proxy is
 *      the interception point: `eth_sendRawTransaction` is decoded, simulated
 *      against fork state, recorded as an InterceptedAction, and answered with
 *      a plausible tx hash. The agent cannot tell it is not live.
 *   4. On window close, read terminal state and destroy the fork.
 *
 * `replayHash` must stay a pure function of the window, because it is what
 * lets a third party re-run an audition and check Bench's arithmetic.
 */
export class AnvilForkProvider implements ForkProvider {
  async spawn(_opts: SpawnForkOptions): Promise<ForkHandle> {
    return notImplemented('AnvilForkProvider.spawn');
  }

  replayHash(_window: AuditionWindow): Hex {
    return notImplemented('AnvilForkProvider.replayHash');
  }
}
