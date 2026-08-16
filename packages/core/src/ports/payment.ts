import type {
  PaymentAuthorization,
  PaymentQuote,
  PaymentReceipt,
  X402Scheme,
} from '../types/hire.js';
import type { Address, TokenAmount } from '../types/primitives.js';

export interface QuoteRequest {
  readonly resource: string;
  readonly payTo: Address;
  readonly amount: TokenAmount;
  /** Defaults to permit2-upto, the right scheme for metered agent usage. */
  readonly scheme?: X402Scheme;
}

/**
 * Binance x402. Supported BSC settlement tokens: U, USDT, USD1, USDC.
 *
 * `permit2-upto` is the default because agents meter usage against a ceiling
 * rather than taking a fixed prepay — the same shape as the spend cap on the
 * session key, so a hire has one consistent ceiling story end to end.
 */
export interface PaymentClient {
  quote(req: QuoteRequest): Promise<PaymentQuote>;
  authorize(quote: PaymentQuote): Promise<PaymentAuthorization>;
  settle(auth: PaymentAuthorization): Promise<PaymentReceipt>;
  /** Drawn so far against a permit2-upto ceiling. */
  spentAgainst(auth: PaymentAuthorization): Promise<TokenAmount>;
}
