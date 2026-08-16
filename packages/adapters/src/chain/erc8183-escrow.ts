import {
  notImplemented,
  type EscrowClient,
  type EscrowJob,
  type Hex,
  type JobSpec,
} from '@bench/core';

/**
 * ERC-8183 agentic commerce escrow. Phase 4.
 *
 * Optimistic settlement: silence past the dispute window is implicit approval;
 * the client may dispute within it to trigger a whitelisted-voter quorum.
 *
 * Live on BSC testnet, mainnet pending as of Aug 2026 — one of the open
 * questions for the organizers is which target judging runs against. Keep the
 * contract addresses in config, never inline.
 */
export class Erc8183EscrowClient implements EscrowClient {
  async openJob(_spec: JobSpec): Promise<EscrowJob> {
    return notImplemented('Erc8183EscrowClient.openJob');
  }

  async fund(_jobId: string): Promise<Hex> {
    return notImplemented('Erc8183EscrowClient.fund');
  }

  async deliver(_jobId: string, _proof: Hex): Promise<Hex> {
    return notImplemented('Erc8183EscrowClient.deliver');
  }

  async settle(_jobId: string): Promise<Hex> {
    return notImplemented('Erc8183EscrowClient.settle');
  }

  async dispute(_jobId: string, _reason: string): Promise<Hex> {
    return notImplemented('Erc8183EscrowClient.dispute');
  }

  async get(_jobId: string): Promise<EscrowJob | null> {
    return notImplemented('Erc8183EscrowClient.get');
  }
}
