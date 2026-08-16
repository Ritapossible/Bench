import {
  notImplemented,
  type AgentCard,
  type AgentId,
  type AgentRecord,
  type Hex,
  type ListAgentsQuery,
  type RegistryClient,
  type ValidationEntry,
} from '@bench/core';

/**
 * ERC-8004 registries on BSC. Phase 1.
 *
 * Two things to get right when this is filled in:
 *
 * - `resolveCard` fails for most agents. Only ~4% of BSC registrations have a
 *   resolvable card with a live endpoint. Unresolvable is the NORMAL path, not
 *   the error path — return the AgentRecord with `card: null` and let the
 *   prober and the "verified live" filter do the rest. Do not throw and skip.
 *
 * - `writeValidation` targets the Validation Registry. There is intentionally
 *   no reputation write anywhere in Bench.
 */
export class Erc8004RegistryClient implements RegistryClient {
  async listAgents(_q?: ListAgentsQuery): Promise<readonly AgentRecord[]> {
    return notImplemented('Erc8004RegistryClient.listAgents');
  }

  async getAgent(_id: AgentId): Promise<AgentRecord | null> {
    return notImplemented('Erc8004RegistryClient.getAgent');
  }

  async resolveCard(_uri: string): Promise<AgentCard> {
    return notImplemented('Erc8004RegistryClient.resolveCard');
  }

  async watchRegistrations(
    _fromBlock: bigint,
    _onAgent: (a: AgentRecord) => Promise<void>,
  ): Promise<() => void> {
    return notImplemented('Erc8004RegistryClient.watchRegistrations');
  }

  async writeValidation(_entry: ValidationEntry): Promise<Hex> {
    return notImplemented('Erc8004RegistryClient.writeValidation');
  }

  async anchorProbeDigest(_digest: Hex): Promise<Hex> {
    return notImplemented('Erc8004RegistryClient.anchorProbeDigest');
  }
}
