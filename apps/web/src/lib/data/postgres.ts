import {
  agentKey,
  isVerifiedLive,
  summarizeAgreement,
  type Address,
  type AgentCategory,
  type AgentId,
  type AgreementSummary,
  type CatalogEntry,
  type CatalogStats,
  type ChainName,
  type Score,
} from '@bench/core';
import { BscPositionReader, buildCrossReference } from '@bench/adapters';
import { createDb, PgAuditionStore, PgCatalogRepository } from '@bench/db';
import type { AddressReportResult, AgentDetail, AgentSummary, BenchData } from './types';

/**
 * The production BenchData: Postgres, plus the 8004scan cross-reference.
 *
 * Written to the same interface as the fixtures, so which one is in use is a
 * deployment fact rather than a code path the pages know about. Three things it
 * does that a naive port of the fixtures would not:
 *
 *  1. **One score query per page, not one per row.** `latestScores` takes the
 *     whole page's agents at once. Per-row lookups turn the catalog into a page
 *     that gets slower as Bench indexes more agents, which is backwards for a
 *     marketplace whose pitch is breadth.
 *  2. **An unscored agent stays unscored.** `score` is null when nothing has
 *     been audited, and the UI renders that as "not audited yet". Defaulting to
 *     zero would make an unmeasured agent look measured and bad.
 *  3. **It refuses to invent what it has not computed.** `reportForAddress`
 *     returns `not-audited` rather than a plausible-looking number, because the
 *     counterfactual for a specific position requires a shadow run against that
 *     position and nothing else can stand in for it.
 */

const CHAIN: ChainName = (process.env['BENCH_CHAIN'] as ChainName | undefined) ?? 'bsc-testnet';
const PAGE_LIMIT = 200;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/**
 * Positions are read from BSC **mainnet**, even though the agent catalog is on
 * testnet for the contest.
 *
 * Those are different questions about different things. The catalog asks which
 * agents are registered and live, and for judging that is testnet. A reader
 * pasting their own address is asking about money they actually hold, and that
 * is on mainnet. Reading testnet for them would return an empty position for
 * almost everyone and look like a bug.
 */
const POSITION_RPC = process.env['BSC_MAINNET_RPC_URL'] ?? 'https://bsc-dataseed.bnbchain.org';

export function createPgData(connectionString: string): BenchData {
  const db = createDb(connectionString);
  const catalog = new PgCatalogRepository(db);
  const audition = new PgAuditionStore(db);
  const positions = new BscPositionReader({ chain: 'bsc-mainnet', rpcUrl: POSITION_RPC });
  const crossRef = buildCrossReference({
    apiKey: process.env['ALTLAYER_8004SCAN_API_KEY'] ?? undefined,
  });

  /** Attach the newest simulated score to each entry, in one round trip. */
  const withScores = async (entries: readonly CatalogEntry[]): Promise<readonly AgentSummary[]> => {
    const scores = await audition.latestScores(
      entries.map((e) => e.record.id),
      'simulated',
    );
    return entries.map((entry) => ({
      entry,
      score: scores.get(agentKey(entry.record.id)) ?? null,
    }));
  };

  return {
    async catalogStats(): Promise<CatalogStats> {
      return catalog.stats(CHAIN);
    },

    async catalogHistory(): Promise<readonly CatalogStats[]> {
      const history = await audition.statsHistory(CHAIN);
      // Before the indexer has run twice there is no trend to draw. Return
      // today's measurement alone rather than padding the series - a chart of
      // one point is honest, a chart of twenty copies of it is not.
      return history.length > 0 ? history : [await catalog.stats(CHAIN)];
    },

    async catalogProvenance() {
      // Read from indexer state rather than an environment flag: a flag is a
      // claim someone has to remember to update, and this is exactly the claim
      // that must not be wrong. No checkpoint means the indexer has never run
      // against this database, so whatever is in it was put there by the seed.
      const checkpoint = await catalog.checkpoint(CHAIN);
      return checkpoint === null ? ('seeded' as const) : ('indexed' as const);
    },

    async crossReference(): Promise<AgreementSummary> {
      const page = await catalog.query({ chain: CHAIN, limit: PAGE_LIMIT });
      const result = await crossRef.lookup(page.entries.map((e) => e.record.id));
      return summarizeAgreement(result);
    },

    async listAgents(opts): Promise<readonly AgentSummary[]> {
      const query = {
        chain: CHAIN,
        limit: PAGE_LIMIT,
        ...(opts?.verifiedLiveOnly === undefined
          ? {}
          : { verifiedLiveOnly: opts.verifiedLiveOnly }),
        ...(opts?.category === undefined ? {} : { category: opts.category }),
      };

      const page = await catalog.query(query);
      let entries = page.entries;

      // The catalog filters client-side, so whatever this returns is the whole
      // universe that filter can see. Against a real registry that is 2,013
      // agents of which eight are verified live, and a page of the first 200 by
      // token id contained none of them - the default view rendered "nothing
      // matches" over a catalog whose entire point is those eight. So the
      // verified-live set is fetched in SQL and merged in: it is small, it is
      // the headline, and it must never be the part that gets truncated away.
      if (opts?.verifiedLiveOnly !== true) {
        const live = await catalog.query({ ...query, verifiedLiveOnly: true });
        const seen = new Set(entries.map((e) => agentKey(e.record.id)));
        entries = [...live.entries.filter((e) => !seen.has(agentKey(e.record.id))), ...entries];
      }

      const summaries = await withScores(entries);
      // Unscored agents sort last rather than as zero: -1 is below every
      // possible normalized score, which is in [0, 1]. Verified-live first
      // within that, since an unaudited live agent is still more useful than an
      // unaudited dead one.
      return [...summaries].sort((a, b) => {
        if (a.entry.verifiedLive !== b.entry.verifiedLive) return a.entry.verifiedLive ? -1 : 1;
        return (b.score?.normalized ?? -1) - (a.score?.normalized ?? -1);
      });
    },

    async getAgent(chain, tokenId): Promise<AgentDetail | null> {
      let id: AgentId;
      try {
        id = { chain: chain as ChainName, tokenId: BigInt(tokenId) };
      } catch {
        // A non-numeric token id in the URL is a bad link, not a server error.
        return null;
      }

      const record = await catalog.getAgent(id);
      if (record === null) return null;

      const [liveness, runs, outcomes, simulated, realized] = await Promise.all([
        catalog.liveness(id),
        audition.runsFor(id),
        audition.outcomesFor(id),
        audition.latestScore(id, 'simulated'),
        audition.latestScore(id, 'realized'),
      ]);

      return {
        entry: { record, liveness, verifiedLive: isVerifiedLive(liveness) },
        score: simulated,
        runs,
        outcomes,
        // Never merged with `score`. A backtest and a settled job are different
        // evidence and the UI labels them separately.
        realized,
      };
    },

    async reportForAddress(address): Promise<AddressReportResult> {
      if (!ADDRESS.test(address)) return { status: 'invalid-address' };

      // The position half is a fact, so it is read rather than simulated, and
      // it is read even when the counterfactual half cannot be produced yet.
      // The counterfactual is a shadow run against *this* position on a forked
      // chain, which needs an archive node and a worker; deriving a number from
      // unrelated auditions instead would look like a result and be a guess.
      try {
        const position = await positions.read(address as Address);
        return { status: 'position-only', position };
      } catch (err) {
        return {
          status: 'unavailable',
          reason: err instanceof Error ? err.message : 'could not reach a BSC node',
        };
      }
    },
  };
}

/** Exported for the catalog page's category tabs, which need the same source of truth. */
export type { AgentCategory, Score };
