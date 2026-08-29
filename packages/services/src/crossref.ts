import {
  summarizeAgreement,
  type AgreementSummary,
  type CatalogRepository,
  type ChainName,
  type CrossReferenceSource,
} from '@bench/core';

/**
 * Corroborate the catalog against an independent source, on a schedule.
 *
 * Lives here rather than in a page because it costs one upstream call per
 * agent. Computing it per request made /registry take about forty seconds once
 * an API key was configured - the source paces its own requests, so concurrency
 * does not help and simultaneous visitors queue behind each other - and spent
 * the day's quota a pageview at a time. The worker runs this twice an hour and
 * stores one row.
 *
 * Never throws: the source reports failure as a status, and an outage in a
 * corroborating explorer must not take a queue down. The chain remains the
 * source of truth; this only measures whether someone else sees the same thing.
 */
export async function summarizeAgreementFor(
  source: CrossReferenceSource,
  catalog: CatalogRepository,
  chain: ChainName,
  limit: number,
): Promise<AgreementSummary> {
  const page = await catalog.query({ chain, limit });
  const result = await source.lookup(page.entries.map((e) => e.record.id));
  return summarizeAgreement(result);
}
