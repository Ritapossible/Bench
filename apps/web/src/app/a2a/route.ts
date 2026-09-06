import { NextResponse } from 'next/server';
import { isAddress, isHex, type Address, type Hex } from 'viem';
import { rebalanceToward5050 } from '@/lib/agent/rebalance';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** An audition allows 90s; a swap plus its receipt fits well inside this. */
export const maxDuration = 60;

/**
 * ============================================================================
 * Bench's reference agent, speaking A2A.
 * ============================================================================
 *
 * Written against what the shim actually sends, which is the only reason it
 * works: a text part carrying the task, or a data part naming a declared
 * skill, plus `metadata` with the RPC endpoint, the controller and its key.
 * Both are accepted, because this agent's card declares both input modes and
 * an agent that advertises text and then refuses it is the bug that kept the
 * whole catalog at zero.
 *
 * Refusals go back the way A2A agents in this registry actually send them -
 * a data part carrying `error` inside a JSON-RPC success - so this exercises
 * the refusal path the shim now reads rather than a shape nobody uses.
 */

interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: unknown;
  readonly method?: string;
  readonly params?: {
    readonly message?: {
      readonly parts?: readonly { kind?: string; text?: string; data?: unknown }[];
    };
    readonly metadata?: Record<string, unknown>;
  };
}

const ok = (id: unknown, data: unknown): NextResponse =>
  NextResponse.json({
    jsonrpc: '2.0',
    id: id ?? null,
    result: {
      kind: 'message',
      role: 'agent',
      messageId: `bench-ref-${Date.now().toString(36)}`,
      parts: [{ kind: 'data', data }],
    },
  });

const refuse = (id: unknown, error: string, extra: Record<string, unknown> = {}): NextResponse =>
  ok(id, { error, ...extra });

/** The USDT the catalog's spot positions are mirrored in. */
const DEFAULT_TOKEN: Address = '0x55d398326f99059fF775485246999027B3197955';

/** First 0x-prefixed hex of the right length anywhere in the text. */
function findHex(text: string, chars: number): string | null {
  const m = new RegExp(`0x[0-9a-fA-F]{${chars}}`).exec(text);
  return m === null ? null : m[0];
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 200 },
    );
  }

  const id = body.id ?? null;
  if (body.method !== 'message/send') {
    // -32601 in a well-formed envelope, which is also what the prober's
    // liveness check looks for. An unknown method must not 404.
    return NextResponse.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${body.method ?? 'none'}` },
    });
  }

  const parts = body.params?.message?.parts ?? [];
  const meta = body.params?.metadata ?? {};
  const dataPart = parts.find((p) => p.kind === 'data' && typeof p.data === 'object');
  const data = (dataPart?.data ?? {}) as Record<string, unknown>;
  const text = parts
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text ?? '')
    .join(' ');

  /**
   * Read from the structured input first, then from the prose.
   *
   * The prose fallback is not decoration: A2A's default wire format is a text
   * part, this agent's card says it accepts one, and an agent that only really
   * works with its own envelope is the failure mode this whole catalog is
   * full of.
   */
  const rpcUrl =
    str(data['rpc_url']) ?? str(meta['rpcUrl']) ?? /https?:\/\/\S+/.exec(text)?.[0] ?? null;
  const account = str(data['account']) ?? str(meta['account']) ?? findHex(text, 40) ?? null;
  const privateKey =
    str(data['account_private_key']) ?? str(meta['accountPrivateKey']) ?? findHex(text, 64) ?? null;
  const token = str(data['token']) ?? DEFAULT_TOKEN;

  if (rpcUrl === null || account === null || privateKey === null) {
    return refuse(id, 'MISSING_AUDITION_CONTEXT', {
      message:
        'need the fork RPC endpoint, the account holding the position, and its key. Send them ' +
        'as metadata (rpcUrl, account, accountPrivateKey) or in a data part (rpc_url, account, ' +
        'account_private_key).',
      missing: [
        rpcUrl === null ? 'rpc_url' : null,
        account === null ? 'account' : null,
        privateKey === null ? 'account_private_key' : null,
      ].filter((x) => x !== null),
    });
  }
  if (!isAddress(account) || !isAddress(token) || !isHex(privateKey)) {
    return refuse(id, 'INVALID_AUDITION_CONTEXT', {
      message: 'account, token and key must be 0x-prefixed hex of the right length',
    });
  }

  try {
    const result = await rebalanceToward5050({
      rpcUrl,
      account: account as Address,
      privateKey: privateKey as Hex,
      token: token as Address,
    });
    return ok(id, { skill: 'rebalance_spot', ...result });
  } catch (err) {
    /**
     * Reported as a refusal with its reason, not as a 500.
     *
     * A 500 reads to the harness as an unreachable endpoint, which is a claim
     * about the registration rather than about this run. The message is
     * truncated because it ends up on a public page.
     */
    return refuse(id, 'REBALANCE_FAILED', {
      message: (err instanceof Error ? err.message : String(err)).slice(0, 240),
    });
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
