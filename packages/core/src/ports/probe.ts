import type { AgentEndpoint, AgentId, ProbeResult } from '../types/agent.js';

/**
 * Liveness and protocol conformance. `conformant` is the part that matters:
 * plenty of endpoints return 200 without speaking the protocol they declare,
 * and only ~4% of BSC-registered agents have a live endpoint at all.
 */
export interface ProbeClient {
  probe(agent: AgentId, endpoint: AgentEndpoint): Promise<ProbeResult>;
}
