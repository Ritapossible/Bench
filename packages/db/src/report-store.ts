import { and, asc, eq, sql } from 'drizzle-orm';
import { redactSecrets, type ChainName } from '@bench/core';
import type { Db } from './index.js';
import * as schema from './schema.js';

/**
 * Requests for an audition against a reader's own position.
 *
 * Its own store rather than a method on the catalog: the lifecycle here is a
 * queue - claim, run, finish - and mixing that into a repository whose other
 * methods are all idempotent reads would hide the one place ordering matters.
 */
export interface ReportRequest {
  readonly chain: ChainName;
  readonly address: string;
  readonly status: 'pending' | 'running' | 'complete' | 'failed';
  readonly windowId: string | null;
  readonly requestedAt: Date;
  readonly completedAt: Date | null;
  readonly agentsRun: number;
  readonly failureReason: string | null;
}

export class PgReportStore {
  constructor(private readonly db: Db) {}

  /**
   * Record that someone wants this position auditioned.
   *
   * Re-requesting a completed report re-opens it, because the point of the
   * page is what agents would do with the position *now*; re-requesting one
   * already running is a no-op, so a reader refreshing does not queue a second
   * fork.
   */
  async request(chain: ChainName, address: string): Promise<ReportRequest> {
    const key = address.toLowerCase();
    await this.db
      .insert(schema.reportRequests)
      .values({ chain, address: key, status: 'pending' })
      .onConflictDoUpdate({
        target: [schema.reportRequests.chain, schema.reportRequests.address],
        set: { status: 'pending', requestedAt: new Date(), failureReason: null },
        where: sql`${schema.reportRequests.status} in ('complete', 'failed')`,
      });

    const got = await this.get(chain, key);
    if (got === null) throw new Error(`report request for ${key} vanished after insert`);
    return got;
  }

  async get(chain: ChainName, address: string): Promise<ReportRequest | null> {
    const rows = await this.db
      .select()
      .from(schema.reportRequests)
      .where(
        and(
          eq(schema.reportRequests.chain, chain),
          eq(schema.reportRequests.address, address.toLowerCase()),
        ),
      )
      .limit(1);
    const r = rows[0];
    return r === undefined
      ? null
      : {
          chain: r.chain as ChainName,
          address: r.address,
          status: r.status as ReportRequest['status'],
          windowId: r.windowId,
          requestedAt: r.requestedAt,
          completedAt: r.completedAt,
          agentsRun: r.agentsRun,
          failureReason: r.failureReason,
        };
  }

  /**
   * Take the oldest pending request, atomically.
   *
   * `update ... where status = 'pending' ... returning` is the claim: two
   * workers racing cannot both win it, because the second one's `where` no
   * longer matches. Selecting and then updating would let both run the same
   * position on two forks and record two sets of runs for one window.
   */
  async claimNext(chain: ChainName): Promise<ReportRequest | null> {
    const oldest = await this.db
      .select({ address: schema.reportRequests.address })
      .from(schema.reportRequests)
      .where(
        and(eq(schema.reportRequests.chain, chain), eq(schema.reportRequests.status, 'pending')),
      )
      .orderBy(asc(schema.reportRequests.requestedAt))
      .limit(1);

    const address = oldest[0]?.address;
    if (address === undefined) return null;

    const claimed = await this.db
      .update(schema.reportRequests)
      .set({ status: 'running', startedAt: new Date() })
      .where(
        and(
          eq(schema.reportRequests.chain, chain),
          eq(schema.reportRequests.address, address),
          eq(schema.reportRequests.status, 'pending'),
        ),
      )
      .returning({ address: schema.reportRequests.address });

    return claimed.length === 0 ? null : this.get(chain, address);
  }

  async finish(
    chain: ChainName,
    address: string,
    result:
      | { readonly ok: true; readonly windowId: string; readonly agentsRun: number }
      | { readonly ok: false; readonly reason: string },
  ): Promise<void> {
    await this.db
      .update(schema.reportRequests)
      .set(
        result.ok
          ? {
              status: 'complete',
              windowId: result.windowId,
              agentsRun: result.agentsRun,
              completedAt: new Date(),
              failureReason: null,
            }
          : {
              status: 'failed',
              completedAt: new Date(),
              // Same rule as everywhere else: this is rendered on a public
              // page, and the message can carry the RPC URL that produced it.
              failureReason: redactSecrets(result.reason),
            },
      )
      .where(
        and(
          eq(schema.reportRequests.chain, chain),
          eq(schema.reportRequests.address, address.toLowerCase()),
        ),
      );
  }

  /**
   * Release requests a crashed worker left claimed.
   *
   * Without this a request stuck in 'running' is never retried and the reader
   * waits forever on a page that says "working on it" - the failure mode that
   * looks exactly like success until someone checks.
   */
  async releaseStale(chain: ChainName, olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const released = await this.db
      .update(schema.reportRequests)
      .set({ status: 'pending', startedAt: null })
      .where(
        and(
          eq(schema.reportRequests.chain, chain),
          eq(schema.reportRequests.status, 'running'),
          sql`${schema.reportRequests.startedAt} < ${cutoff}`,
        ),
      )
      .returning({ address: schema.reportRequests.address });
    return released.length;
  }
}
