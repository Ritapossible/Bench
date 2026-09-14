import { createHash } from 'node:crypto';
import { createAccount, createClient } from 'genlayer-js';
import { localnet, studionet, testnetAsimov, testnetBradbury } from 'genlayer-js/chains';
import { TransactionStatus } from 'genlayer-js/types';
import { BenchError, classifyEvidence } from '@bench/core';
import type {
  DisputeFiling,
  DisputeGround,
  DisputeRecord,
  DisputeResolver,
  DisputeState,
  DisputeTerms,
  DisputeVerdictRecord,
  EvidenceIndependence,
  EvidenceSource,
  HireRegistration,
} from '@bench/core';
import type { Address } from '@bench/core';

/**
 * The dispute layer's only real adapter: a GenLayer Intelligent Contract.
 *
 * Why a second chain at all, when Bench already runs on BSC. A dispute needs a
 * ruling, a ruling needs judgment, and judgment is the one thing an EVM cannot
 * perform - it has no way to read a page, weigh what it says, and have other
 * nodes agree that the weighing was reasonable. The usual answer is a
 * multisig, a whitelisted voter set, or the marketplace itself, and all three
 * put the decision in the hands of someone with an interest in it.
 *
 * GenLayer's validators each fetch the evidence, each run the model, and
 * compare structured rulings rather than bytes. That is the shape this needs:
 * the disagreement that matters is about the verdict, not about which CDN edge
 * served which banner.
 *
 * **Reads need no account and no gas.** Every view on the Arbiter is free, so a
 * Bench page renders a dispute, its state and its evidence tally without a
 * signer configured. Writes need one, and the adapter says which it has.
 */

/**
 * Networks this adapter will talk to, named the way a config file should read.
 *
 * `unknown` and one cast at `createClient`, which is not laziness. The SDK's
 * own types do not typecheck against each other under
 * `exactOptionalPropertyTypes`: its exported chains declare
 * `blockExplorers?: {...} | undefined` and its client config declares
 * `blockExplorers?: {...}`, so `createClient({ chain: studionet })` is rejected
 * by TypeScript while being the SDK's own documented usage. Inferring the type
 * here also emits a declaration referencing a hashed internal module that
 * cannot be named from outside the package.
 *
 * The alternative is relaxing `exactOptionalPropertyTypes` for the whole
 * workspace, which would trade a real guarantee across every file for a
 * third-party packaging problem in one. The cast is confined to the single
 * expression that needs it and the chain values are the SDK's own constants,
 * so nothing about them is being asserted that the SDK does not already
 * guarantee at runtime.
 */
const CHAINS: Readonly<Record<string, unknown>> = {
  localnet,
  studionet,
  'testnet-bradbury': testnetBradbury,
  'testnet-asimov': testnetAsimov,
};

type SdkChain = NonNullable<NonNullable<Parameters<typeof createClient>[0]>['chain']>;

export type GenLayerChainName = 'localnet' | 'studionet' | 'testnet-bradbury' | 'testnet-asimov';

export interface GenLayerArbiterOptions {
  readonly rpcUrl: string;
  readonly address: Address;
  /** Which GenLayer network. Defaults to testnet Bradbury. */
  readonly chain?: GenLayerChainName;
  /**
   * The key that pays for writes.
   *
   * Optional, and its absence is not an error: reads carry the whole of what a
   * page needs and a deployment that only displays disputes should not have to
   * hold a funded key to do it.
   */
  readonly privateKey?: string;
  /** Bench's own host, so the arbiter can mark Bench's data as interested. */
  readonly marketplaceDomain?: string;
  /** How long to wait for a write to reach ACCEPTED. */
  readonly receiptRetries?: number;
  readonly receiptIntervalMs?: number;
}

type Client = ReturnType<typeof createClient>;

const DEFAULTS = {
  chain: 'testnet-bradbury' as const,
  receiptRetries: 200,
  receiptIntervalMs: 5_000,
};

/** Read one field out of a contract's dict return, whatever the SDK hands back. */
function field(value: unknown, key: string): unknown {
  if (value instanceof Map) return value.get(key);
  if (typeof value === 'object' && value !== null) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

const asString = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : v === undefined || v === null ? fallback : String(v);

const asNumber = (v: unknown, fallback = 0): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  const parsed = Number(asString(v, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const asBigInt = (v: unknown): bigint => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  try {
    return BigInt(asString(v, '0'));
  } catch {
    return 0n;
  }
};

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The contract speaks in upper case; Bench's types are lower. */
const STATES: Readonly<Record<string, DisputeState>> = {
  OPEN: 'open',
  UPHELD: 'upheld',
  DISMISSED: 'dismissed',
  ABSTAINED: 'abstained',
};

const GROUNDS: Readonly<Record<string, DisputeGround>> = {
  BREACH: 'breach',
  DELIVERY: 'delivery',
};

const EMPTY_TALLY: EvidenceIndependence = {
  independent: 0,
  claimant: 0,
  respondent: 0,
  marketplace: 0,
  unclassified: 0,
};

export class GenLayerArbiter implements DisputeResolver {
  readonly available = true;
  readonly locator: { readonly chain: string; readonly address: string };

  readonly #client: Client;
  readonly #address: Address;
  readonly #canWrite: boolean;
  readonly #retries: number;
  readonly #interval: number;
  readonly #marketplaceDomain: string | undefined;

  constructor(opts: GenLayerArbiterOptions) {
    const chainName = opts.chain ?? DEFAULTS.chain;
    const chain = CHAINS[chainName];
    if (chain === undefined) {
      throw new BenchError('INVALID_REQUEST', `unknown GenLayer chain ${chainName}`);
    }
    this.#address = opts.address;
    this.#canWrite = opts.privateKey !== undefined && opts.privateKey !== '';
    this.#retries = opts.receiptRetries ?? DEFAULTS.receiptRetries;
    this.#interval = opts.receiptIntervalMs ?? DEFAULTS.receiptIntervalMs;
    this.#marketplaceDomain = opts.marketplaceDomain;
    this.locator = { chain: chainName, address: opts.address };

    this.#client = createClient({
      chain: chain as SdkChain,
      endpoint: opts.rpcUrl,
      ...(this.#canWrite ? { account: createAccount(opts.privateKey as `0x${string}`) } : {}),
    });
  }

  #requireSigner(what: string): void {
    if (!this.#canWrite) {
      // Named at the call site rather than left to fail inside the SDK, where
      // it surfaces as a nonce error against an undefined account and reads
      // like a chain problem.
      throw new BenchError(
        'INVALID_REQUEST',
        `${what} needs a funded GenLayer key; this deployment has reads only`,
      );
    }
  }

  async #read(functionName: string, args: unknown[]): Promise<unknown> {
    return this.#client.readContract({
      address: this.#address,
      functionName,
      args: args as never,
    });
  }

  async #write(functionName: string, args: unknown[], value = 0n): Promise<void> {
    const hash = await this.#client.writeContract({
      address: this.#address,
      functionName,
      args: args as never,
      value,
    });
    /**
     * Waited on, not fired and forgotten.
     *
     * A dispute write that has not reached ACCEPTED has not happened, and the
     * page that called it would otherwise render a filing the chain may still
     * reject. GenLayer's consensus takes real time - validators fetch evidence
     * and run a model - so the budget is minutes, not seconds.
     */
    await this.#client.waitForTransactionReceipt({
      hash,
      status: TransactionStatus.ACCEPTED,
      retries: this.#retries,
      interval: this.#interval,
    });
  }

  async registerHire(reg: HireRegistration): Promise<{ readonly termsHash: string }> {
    this.#requireSigner('registering a hire');
    const termsHash = termsDigest(reg.terms);
    await this.#write('register_hire', [
      reg.hireId,
      `${reg.agent.chain}:${reg.agent.tokenId.toString()}`,
      reg.client,
      reg.respondent,
      termsHash,
      reg.recordUrl,
      reg.claimantDomain ?? '',
      reg.respondentDomain ?? '',
      reg.marketplaceDomain ?? this.#marketplaceDomain ?? '',
    ]);
    return { termsHash };
  }

  async openDispute(filing: DisputeFiling): Promise<DisputeRecord> {
    this.#requireSigner('opening a dispute');
    await this.#write(
      'open_dispute',
      [
        filing.hireId,
        filing.ground.toUpperCase(),
        filing.engagement,
        [...filing.criteria],
        [...filing.evidenceUrls],
      ],
      filing.bond,
    );
    // The write returns the new id through consensus data whose shape varies by
    // network, so the id is read back from the contract instead. One extra free
    // call against a value that is authoritative either way.
    const ids = await this.forHire(filing.hireId);
    const latest = ids.at(-1);
    if (latest === undefined) {
      throw new BenchError('UPSTREAM_UNAVAILABLE', 'the dispute did not appear after opening');
    }
    const record = await this.get(latest);
    if (record === null) {
      throw new BenchError('UPSTREAM_UNAVAILABLE', 'the dispute did not appear after opening');
    }
    return record;
  }

  async answer(disputeId: number, evidenceUrls: readonly string[]): Promise<DisputeRecord> {
    this.#requireSigner('answering a dispute');
    await this.#write('answer', [disputeId, [...evidenceUrls]]);
    return this.#must(disputeId);
  }

  async adjudicate(disputeId: number, terms: DisputeTerms): Promise<DisputeRecord> {
    this.#requireSigner('adjudicating');
    // Canonical JSON, because the contract re-encodes what it is given and
    // compares the digest: two encoders disagreeing about key order would look
    // exactly like someone restating the terms after the fact.
    await this.#write('adjudicate', [disputeId, canonicalJson(terms)]);
    return this.#must(disputeId);
  }

  async #must(disputeId: number): Promise<DisputeRecord> {
    const record = await this.get(disputeId);
    if (record === null) {
      throw new BenchError('UPSTREAM_UNAVAILABLE', `dispute ${disputeId} vanished`);
    }
    return record;
  }

  async get(disputeId: number): Promise<DisputeRecord | null> {
    let raw: unknown;
    try {
      raw = await this.#read('dispute', [disputeId]);
    } catch {
      // The contract raises for an id it does not have. A missing dispute is an
      // answer, not a failure, and a page asking about one should not fault.
      return null;
    }
    return decodeDispute(disputeId, raw, this.#marketplaceDomain);
  }

  async forHire(hireId: string): Promise<readonly number[]> {
    try {
      return asList(await this.#read('disputes_for', [hireId])).map((v) => asNumber(v));
    } catch {
      return [];
    }
  }

  async independence(disputeId: number): Promise<EvidenceIndependence> {
    try {
      const raw = await this.#read('evidence_independence', [disputeId]);
      return {
        independent: asNumber(field(raw, 'independent')),
        claimant: asNumber(field(raw, 'claimant')),
        respondent: asNumber(field(raw, 'respondent')),
        marketplace: asNumber(field(raw, 'marketplace')),
        unclassified: asNumber(field(raw, 'unclassified')),
      };
    } catch {
      return EMPTY_TALLY;
    }
  }
}

/**
 * Canonical JSON: sorted keys, no spaces.
 *
 * Matches `canonical_json` in the contract exactly. The digest of the terms is
 * what stops either party restating the rules after the hire has gone wrong, so
 * the two encoders have to agree byte for byte or every adjudication fails as
 * tampering.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * sha256 over the canonical encoding, matching `terms_digest` in the contract.
 *
 * This is the value that stops either party restating the rules after the hire
 * has gone wrong, so the two implementations have to agree byte for byte: a
 * digest computed differently here reads on-chain as tampering rather than as a
 * bug, and the dispute simply refuses to adjudicate.
 */
export function termsDigest(terms: DisputeTerms): string {
  return createHash('sha256').update(canonicalJson(terms), 'utf8').digest('hex');
}

/** Seconds on the contract, `Date` in Bench. Zero means "not set", not 1970. */
const atSecond = (v: unknown): Date => new Date(asNumber(v) * 1000);

export function decodeDispute(
  disputeId: number,
  raw: unknown,
  marketplaceDomain: string | undefined,
): DisputeRecord {
  const urls = asList(field(raw, 'sources')).map((u) => asString(u));
  const classes = asList(field(raw, 'source_class')).map((c) => asString(c));
  const sources: EvidenceSource[] = urls.map((url, i) => ({
    url,
    /**
     * The contract's own classification is authoritative; this recomputes only
     * where the contract did not say.
     *
     * Re-deriving a class the contract already assigned would let Bench's view
     * of who owns a source diverge from the one the ruling was made under -
     * and Bench is the party with the most to gain from the answer being
     * `independent`.
     */
    origin:
      (classes[i] as EvidenceSource['origin']) ??
      classifyEvidence(url, marketplaceDomain === undefined ? {} : { marketplaceDomain }),
  }));

  const verdictJson = asString(field(raw, 'verdict'));
  return {
    disputeId,
    hireId: asString(field(raw, 'hire_id')),
    ground: GROUNDS[asString(field(raw, 'ground'))] ?? 'delivery',
    state: STATES[asString(field(raw, 'state'))] ?? 'open',
    claimant: asString(field(raw, 'claimant')) as Address,
    respondent: asString(field(raw, 'respondent')) as Address,
    criteria: asList(field(raw, 'criteria')).map((c) => asString(c)),
    sources,
    bond: asBigInt(field(raw, 'bond')),
    extensions: asNumber(field(raw, 'extensions')),
    openedAt: atSecond(field(raw, 'opened_at')),
    answerEndsAt: atSecond(field(raw, 'answer_end')),
    windowEndsAt: atSecond(field(raw, 'window_end')),
    verdict: decodeVerdict(verdictJson),
  };
}

export function decodeVerdict(json: string): DisputeVerdictRecord | null {
  if (json === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // A verdict that will not parse is not a reason to fail the page. The
    // dispute's state is stored separately and is the thing a reader needs.
    return null;
  }
  // `Array.isArray` as well as the null check: `typeof [] === 'object'`, so a
  // verdict field holding a JSON array would otherwise be read as a record
  // whose every key is missing, and returned as a confident `unresolved`
  // ruling over zero criteria. Absence is the honest answer to something this
  // cannot read.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const v = parsed as Record<string, unknown>;
  const evidence = (v['evidence'] ?? {}) as Record<string, unknown>;
  return {
    ruling: (['upheld', 'dismissed', 'unresolved'] as const).includes(
      v['ruling'] as 'upheld' | 'dismissed' | 'unresolved',
    )
      ? (v['ruling'] as 'upheld' | 'dismissed' | 'unresolved')
      : 'unresolved',
    resolvedBy: v['resolved_by'] === 'replay' ? 'replay' : 'model',
    criteria: asList(v['criteria']).map((c) => ({
      id: asNumber(field(c, 'id')),
      status: (['met', 'unmet', 'unresolved'] as const).includes(
        field(c, 'status') as 'met' | 'unmet' | 'unresolved',
      )
        ? (field(c, 'status') as 'met' | 'unmet' | 'unresolved')
        : 'unresolved',
      confidence: asNumber(field(c, 'confidence')),
    })),
    sourcesReachable: asNumber(v['sources_reachable']),
    evidence: {
      independent: asNumber(evidence['independent']),
      claimant: asNumber(evidence['claimant']),
      respondent: asNumber(evidence['respondent']),
      marketplace: asNumber(evidence['marketplace']),
      unclassified: asNumber(evidence['unclassified']),
    },
    observed:
      typeof v['observed'] === 'object' && v['observed'] !== null
        ? (v['observed'] as Record<string, unknown>)
        : null,
  };
}
