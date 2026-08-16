import {
  notImplemented,
  type PaymentAuthorization,
  type PaymentClient,
  type PaymentQuote,
  type PaymentReceipt,
  type QuoteRequest,
  type TokenAmount,
} from '@bench/core';

/**
 * Binance x402 facilitator. Phase 4.
 *
 * Flow: request a paid resource, take the HTTP 402 challenge, sign an
 * authorization off-chain, retry with proof, settle on-chain in a BSC
 * stablecoin (U / USDT / USD1 / USDC).
 *
 * Default scheme is `permit2-upto`: usage meters against a ceiling instead of
 * taking a fixed prepay. That matches the session-key spend cap, so a hire has
 * one consistent ceiling from payment through authority.
 */
export class X402PaymentClient implements PaymentClient {
  async quote(_req: QuoteRequest): Promise<PaymentQuote> {
    return notImplemented('X402PaymentClient.quote');
  }

  async authorize(_quote: PaymentQuote): Promise<PaymentAuthorization> {
    return notImplemented('X402PaymentClient.authorize');
  }

  async settle(_auth: PaymentAuthorization): Promise<PaymentReceipt> {
    return notImplemented('X402PaymentClient.settle');
  }

  async spentAgainst(_auth: PaymentAuthorization): Promise<TokenAmount> {
    return notImplemented('X402PaymentClient.spentAgainst');
  }
}
