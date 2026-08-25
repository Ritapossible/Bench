/**
 * Domain services: the things Bench *does*, composed from ports.
 *
 * Nothing here talks to Postgres, an RPC endpoint, or the network directly —
 * each service takes ports in its constructor. That is what lets every one of
 * them be tested against in-memory fakes with no chain, no database, and no
 * testnet funds, and it is why the shadow runner in Phase 2 can be developed
 * against replayed fixtures before Anvil is wired up.
 */

export { mapLimit, mapLimitSettled, type Settled } from './concurrency.js';
export { Indexer, type IndexerOptions, type IndexerTickResult } from './indexer.js';
export { Prober, type ProberOptions, type ProberTickResult } from './prober.js';
export { ProbeAnchor, type AnchorOptions, type AnchorTickResult } from './anchor.js';
export {
  AuditionRunner,
  type AuditionReport,
  type AuditionRequest,
  type AuditionResult,
  type AuditionRunnerDeps,
  type ShadowAgent,
  type ShadowAgentContext,
} from './audition.js';
