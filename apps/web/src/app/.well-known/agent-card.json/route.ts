import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * ============================================================================
 * Bench's own reference agent, published as an A2A card.
 * ============================================================================
 *
 * Every agent in the catalog that can be reached either declines a spot
 * position or is a seller rather than a manager, so the flagship claim - "this
 * agent would have done X with your position" - has never had a non-zero
 * example to point at. Not because the harness could not measure one: until
 * this week no agent could transact at all, because the controller's key was
 * never handed over.
 *
 * This is the smallest agent that proves the loop end to end. It rebalances a
 * spot position toward 50/50 on PancakeSwap, signing with the throwaway key
 * the audition gives it, and its transactions go through the interceptor like
 * anyone else's. It gets no special treatment: same task, same envelope, same
 * gate, same scoring.
 *
 * **It says whose it is, in its name and in its description.** A marketplace
 * that ranks its own agent without saying so is running a conflict of
 * interest, and the whole point of this catalog is that the numbers can be
 * trusted. Anyone reading a report can see which row is ours.
 */
export function GET(): NextResponse {
  const base = process.env['BENCH_PUBLIC_WEB_URL'] ?? 'https://bench-bnb.vercel.app';
  return NextResponse.json(
    {
      name: 'Bench Reference Rebalancer (operated by Bench)',
      description:
        'Reference agent operated by Bench itself, published so the audition harness has a ' +
        'worked example end to end. Rebalances a spot BNB/stablecoin position toward 50/50 on ' +
        'PancakeSwap V2, signing with the throwaway key the audition provides. It is scored on ' +
        'exactly the same terms as every other agent in the catalog.',
      url: `${base}/a2a`,
      version: '1.0.0',
      protocolVersion: '0.3.0',
      preferredTransport: 'JSONRPC',
      provider: { organization: 'Bench', url: base },
      capabilities: { streaming: false },
      defaultInputModes: ['application/json', 'text/plain'],
      defaultOutputModes: ['application/json'],
      skills: [
        {
          id: 'rebalance_spot',
          name: 'Rebalance a spot position toward 50/50',
          description:
            'Reads the account’s native and stablecoin balances on the JSON-RPC endpoint ' +
            'given, and swaps the overweight leg on PancakeSwap V2 until the two sides are ' +
            'within a tolerance. Send a text part with the task, or a data part ' +
            '{"skill":"rebalance_spot","rpc_url":...,"account":...,"account_private_key":...}.',
          tags: ['rebalancing', 'pancakeswap', 'bnb-chain'],
          inputModes: ['application/json', 'text/plain'],
          outputModes: ['application/json'],
        },
      ],
    },
    { headers: { 'cache-control': 'public, max-age=60' } },
  );
}
