import {
  BenchError,
  type Address,
  type ChainName,
  type Hex,
  type PaymentAuthorization,
  type PaymentClient,
  type PaymentQuote,
  type PaymentReceipt,
  type QuoteRequest,
  type TokenAmount,
  type X402Scheme,
} from '@bench/core';
import {
  BNB,
  BNB_TESTNET,
  encodeXPaymentHeader,
  networkToChainId,
  selectX402Requirement,
  signX402Payment,
  type Session,
  type X402Requirement,
} from '@altananetwork/sdk';

/**
 * ============================================================================
 * Binance x402, against a real 402 challenge.
 * ============================================================================
 *
 * Worth stating plainly, because it changes where this belongs: **x402 is not
 * a way to pay a chosen party a chosen amount.** It is an HTTP flow. A server
 * answers 402 with the terms it will accept, the client signs one of them into
 * an `X-PAYMENT` header and retries, and a facilitator settles on chain. The
 * merchant sets the payee and the price; the caller only chooses whether to
 * pay.
 *
 * `QuoteRequest` was written the other way round - a `payTo` and an `amount`
 * we supply - because it was designed against the idea of x402 rather than
 * against a 402 response. So the mapping here is deliberately narrow:
 * `resource` must be a URL that answers 402, and the `payTo`/`amount` on the
 * request are treated as a **ceiling to check the merchant against**, not as
 * instructions. If the challenge asks for more than the caller authorised, or
 * routes payment somewhere else, this refuses.
 *
 * Which means the hire path is not this adapter's job. A hire escrows to a
 * provider under a dispute window - that is ERC-8183, and it is implemented
 * next door. What x402 is for in Bench is **egress**: a shadowed agent paying
 * a data feed per call, metered against the run's budget. That is the
 * `MeteredFetch` the audition runner hands to every agent.
 */

export interface X402PaymentOptions {
  readonly chain: ChainName;
  /**
   * The session key that signs payments.
   *
   * A session rather than the admin key on purpose: an x402 authorization is
   * validated on-chain through ERC-1271, and a session carrying a spend cap
   * bounds what a compromised or looping agent can spend before anyone
   * notices. Paying from the admin key would put the whole account behind
   * every data call.
   */
  readonly session: Session;
  /** Preferred rail when a challenge offers several. */
  readonly preferRail?: 'permit2' | 'eip3009';
}

/** Requirement plus the URL it came from - needed to retry the fetch. */
interface Pending {
  readonly requirement: X402Requirement;
  readonly url: string;
  readonly header: string;
}

export class X402PaymentClient implements PaymentClient {
  readonly #opts: X402PaymentOptions;
  readonly #chainId: number;
  /** Signed-but-unsettled challenges, by quote nonce. */
  readonly #pending = new Map<string, Pending>();
  /** What each payee has actually been paid, for `spentAgainst`. */
  readonly #settled = new Map<string, bigint>();

  constructor(opts: X402PaymentOptions) {
    this.#opts = opts;
    this.#chainId = (opts.chain === 'bsc-mainnet' ? BNB : BNB_TESTNET).chainId;
  }

  /**
   * Read the merchant's terms.
   *
   * The 402 body is the quote. Nothing here invents one, which is why a
   * resource that is not a URL is refused rather than approximated: there is
   * no challenge to read, and returning a plausible quote would let the rest
   * of the flow proceed against terms no merchant ever offered.
   */
  async quote(req: QuoteRequest): Promise<PaymentQuote> {
    // Parsed *and* scheme-checked. `new URL` accepts any scheme, so
    // `agent:bsc-testnet:1581` - the resource a hire passes - parses cleanly
    // and would have gone to fetch(). The refusal below is the whole point of
    // this method, and without the scheme check it never fired.
    let url: URL;
    try {
      url = new URL(req.resource);
    } catch {
      url = null as unknown as URL;
    }
    if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      throw new BenchError(
        'INVALID_REQUEST',
        `x402 quotes come from a 402 response, so the resource must be an http(s) URL. Got ` +
          `"${req.resource}" - if this is a hire, settlement is ERC-8183 escrow, not x402.`,
      );
    }

    const res = await fetch(url, { method: 'GET' });
    if (res.status !== 402) {
      throw new BenchError(
        'UPSTREAM_UNAVAILABLE',
        `${url.host} answered ${res.status}, not 402; there is nothing to pay for`,
      );
    }

    const body = (await res.json()) as { accepts?: X402Requirement[] };
    const chosen = selectX402Requirement(body.accepts ?? [], {
      chainId: this.#chainId,
      ...(this.#opts.preferRail === undefined ? {} : { preferRail: this.#opts.preferRail }),
    });
    if (chosen === undefined) {
      throw new BenchError(
        'UPSTREAM_UNAVAILABLE',
        `${url.host} offered no payment option this wallet can settle on chain ${this.#chainId}`,
      );
    }

    const asked = BigInt(chosen.amount ?? chosen.maxAmountRequired ?? '0');

    // The caller's payTo and amount are a ceiling, not an instruction. A
    // merchant that asks for more, or for payment elsewhere, is refused here
    // rather than paid and reconciled afterwards.
    if (asked > req.amount.amount) {
      throw new BenchError(
        'SPEND_CAP_EXCEEDED',
        `${url.host} asked for ${asked.toString()} but this call authorised ` +
          `${req.amount.amount.toString()}`,
      );
    }
    if (chosen.payTo.toLowerCase() !== req.payTo.toLowerCase()) {
      throw new BenchError(
        'INVALID_REQUEST',
        `${url.host} routes payment to ${chosen.payTo}, not the authorised ${req.payTo}`,
      );
    }

    const signed = await signX402Payment(this.#opts.session, chosen);
    const nonce = nonceOf(signed.header);
    this.#pending.set(nonce, { requirement: chosen, url: url.toString(), header: signed.header });

    return {
      payTo: chosen.payTo,
      amount: { ...req.amount, amount: asked },
      scheme: schemeOf(chosen),
      // The challenge's own timeout, or a conservative minute. Never longer
      // than the merchant said it would honour.
      expiresAt: new Date(Date.now() + (chosen.maxTimeoutSeconds ?? 60) * 1000),
      nonce,
    };
  }

  /**
   * The signature already exists - `quote` produced it while reading the
   * challenge, because the header is what proves the terms were accepted as
   * offered. This hands it back rather than signing a second time over
   * possibly different terms.
   */
  async authorize(quote: PaymentQuote): Promise<PaymentAuthorization> {
    const pending = this.#require(quote.nonce);
    return {
      quote,
      signature: pending.header as Hex,
      // permit2-upto meters against a ceiling; the exact rails do not.
      ceiling: quote.scheme === 'permit2-upto' ? quote.amount : null,
    };
  }

  /** Retry the resource with the header. The facilitator settles on chain. */
  async settle(auth: PaymentAuthorization): Promise<PaymentReceipt> {
    const pending = this.#require(auth.quote.nonce);

    const res = await fetch(pending.url, { headers: { 'X-PAYMENT': pending.header } });
    if (res.status === 402) {
      throw new BenchError('UPSTREAM_UNAVAILABLE', `payment for ${pending.url} was rejected`);
    }
    if (!res.ok) {
      throw new BenchError(
        'UPSTREAM_UNAVAILABLE',
        `${new URL(pending.url).host} answered ${res.status} after payment`,
      );
    }

    // The facilitator reports the settlement transaction in X-PAYMENT-RESPONSE.
    const txHash = settlementHashFrom(res.headers.get('x-payment-response'));
    if (txHash === null) {
      throw new BenchError(
        'UPSTREAM_UNAVAILABLE',
        `${new URL(pending.url).host} served the resource without reporting a settlement ` +
          `transaction, so there is no receipt to record`,
      );
    }

    const key = auth.quote.payTo.toLowerCase();
    this.#settled.set(key, (this.#settled.get(key) ?? 0n) + auth.quote.amount.amount);
    this.#pending.delete(auth.quote.nonce);

    return { txHash, settled: auth.quote.amount, at: new Date() };
  }

  async spentAgainst(auth: PaymentAuthorization): Promise<TokenAmount> {
    const key = auth.quote.payTo.toLowerCase();
    return { ...auth.quote.amount, amount: this.#settled.get(key) ?? 0n };
  }

  #require(nonce: Hex): Pending {
    const pending = this.#pending.get(nonce);
    if (pending === undefined) {
      throw new BenchError(
        'NOT_FOUND',
        `no x402 challenge is pending for ${nonce}; quote before authorising`,
      );
    }
    return pending;
  }
}

/** A stable id for one signed challenge. The header is unique per signature. */
function nonceOf(header: string): Hex {
  let h = 0n;
  for (const ch of header) h = (h * 31n + BigInt(ch.charCodeAt(0))) % (1n << 128n);
  return `0x${h.toString(16).padStart(32, '0')}` as Hex;
}

function schemeOf(req: X402Requirement): X402Scheme {
  const rail = req.extra?.assetTransferMethod ?? req.scheme;
  if (rail === 'eip3009') return 'eip3009';
  return rail === 'permit2-upto' ? 'permit2-upto' : 'permit2-exact';
}

/** The settlement tx from the facilitator's base64 X-PAYMENT-RESPONSE. */
function settlementHashFrom(header: string | null): Hex | null {
  if (header === null || header === '') return null;
  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
      transaction?: string;
      txHash?: string;
    };
    const hash = decoded.transaction ?? decoded.txHash;
    return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash) ? (hash as Hex) : null;
  } catch {
    return null;
  }
}

/** Exported for the egress path, which pays per data call rather than per hire. */
export { encodeXPaymentHeader, networkToChainId };
export type { Address };
