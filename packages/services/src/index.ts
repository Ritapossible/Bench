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
export {
  Indexer,
  indexerProfileFor,
  type EnumerationTickResult,
  type IndexerOptions,
  type IndexerTickResult,
} from './indexer.js';
export { summarizeAgreementFor } from './crossref.js';
export {
  AuditionService,
  describeEmptyTick,
  type AuditionServiceDeps,
  type AuditionServiceOptions,
  type AuditionTickResult,
  type ShadowAgentFactory,
} from './audition-service.js';
export {
  Scorer,
  metricFor,
  normalizeDelta,
  type ScorerOptions,
  type ScoringResult,
} from './scorer.js';
export { Prober, proberProfileFor, type ProberOptions, type ProberTickResult } from './prober.js';
export { ProbeAnchor, type AnchorOptions, type AnchorTickResult } from './anchor.js';
export {
  HireOrchestrator,
  InMemoryHireStore,
  type ActionDecision,
  type HireOrchestratorDeps,
  type ClaimResult,
  type HireRecord,
  type HireRequest,
  type HireStore,
  type ProposedAction,
} from './hire.js';
export {
  AuditionRunner,
  type AuditionReport,
  type AuditionRequest,
  type AuditionResult,
  type AuditionRunnerDeps,
  type MeteredFetch,
  type ShadowAgent,
  type ShadowAgentContext,
} from './audition.js';
export { buildAdvantageReport, type AdvantageReport, type AdvantageTask } from './advantage.js';
