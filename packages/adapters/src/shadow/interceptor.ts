import { createServer, type Server } from 'node:http';
import {
  BenchError,
  type Address,
  type CandidateAction,
  type GateDecision,
  type Hex,
  type InterceptedAction,
} from '@bench/core';
import { parseTransaction, recoverTransactionAddress } from 'viem';
import { decodeAction } from './tx-decode.js';

/**
 * The interception point.
 *
 * ARCHITECTURE.md 3.3: agents are NOT asked to implement a dry-run interface,
 * because almost none do. Instead they are handed an RPC endpoint that looks
 * exactly like a node, and every `eth_sendRawTransaction` is decoded and
 * recorded on its way past. **The agent cannot tell it is not live**, which is
 * the entire point — an agent that knows it is being watched is not the agent
 * you would be hiring.
 *
 * "Never broadcast" is a property of the *fork*, not of this proxy: the
 * transaction really does execute, against a local anvil whose state is
 * thrown away when the run ends. It has to execute, or the agent's next read
 * would contradict its last write and the illusion would break.
 *
 * Everything other than `eth_sendRawTransaction` is proxied through untouched.
 */

export interface InterceptorOptions {
  readonly upstreamUrl: string;
  /** Called for every intercepted transaction, in sequence order. */
  readonly onAction: (action: InterceptedAction) => void;
  readonly clock?: () => Date;
  /** Receipt poll budget. Anvil auto-mines, so this is a safety net, not a wait. */
  readonly receiptAttempts?: number;
  /**
   * The execution gate — ARCHITECTURE.md 2.1.
   *
   * Absent during an audition, where the job is to *record* what the agent
   * does. Present during a hire, where a transaction outside the envelope the
   * agent established is refused here and never forwarded upstream. Same
   * machinery, pointed at live traffic.
   */
  readonly gate?: (candidate: CandidateAction) => GateDecision;
  /** Called for every gate decision, allowed or blocked, for the hire card. */
  readonly onDecision?: (candidate: CandidateAction, decision: GateDecision) => void;
}

export interface InterceptorHandle {
  /** Hand this to the agent as its RPC endpoint. */
  readonly url: string;
  readonly port: number;
  readonly actionCount: () => number;
  /** Transactions the gate refused. Never forwarded, never on any chain. */
  readonly blockedCount: () => number;
  close(): Promise<void>;
}

interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: unknown;
  readonly method?: string;
  readonly params?: readonly unknown[];
}

interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export async function startInterceptor(opts: InterceptorOptions): Promise<InterceptorHandle> {
  const clock = opts.clock ?? (() => new Date());
  const receiptAttempts = opts.receiptAttempts ?? 40;
  let seq = 0;
  let blocked = 0;
  // Cumulative spend and action count over the life of this session, which is
  // what bounds a *hire* rather than a single transaction.
  let cumulativeValueWei = 0n;

  const upstream = async (payload: unknown): Promise<unknown> => {
    const res = await fetch(opts.upstreamUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  };

  const call = async (method: string, params: readonly unknown[]): Promise<JsonRpcResponse> =>
    (await upstream({ jsonrpc: '2.0', id: Date.now(), method, params })) as JsonRpcResponse;

  /** Receipt, once anvil has mined. Absent means the node never produced one. */
  const receiptFor = async (hash: Hex): Promise<Record<string, unknown> | null> => {
    for (let i = 0; i < receiptAttempts; i += 1) {
      const r = await call('eth_getTransactionReceipt', [hash]);
      if (r.result !== null && r.result !== undefined) return r.result as Record<string, unknown>;
      await new Promise((res) => setTimeout(res, 25));
    }
    return null;
  };

  /**
   * Why a mined transaction reverted. Anvil mines reverting transactions with
   * status 0 rather than rejecting them, so the reason has to be recovered by
   * replaying the call one block earlier. Best-effort: a missing reason is not
   * worth failing an audition over.
   */
  const revertReasonFor = async (
    from: Address,
    to: Address | null,
    data: Hex,
    value: bigint,
    blockNumber: string,
  ): Promise<string | undefined> => {
    try {
      const prev = `0x${(BigInt(blockNumber) - 1n).toString(16)}`;
      const r = await call('eth_call', [
        { from, to, data, value: `0x${value.toString(16)}` },
        prev,
      ]);
      if (r.error) return r.error.message;
      return undefined;
    } catch {
      return undefined;
    }
  };

  const handleSendRaw = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
    const raw = req.params?.[0];
    if (typeof raw !== 'string') {
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32602, message: 'expected a raw transaction' },
      };
    }

    const serialized = raw as Hex;
    const tx = parseTransaction(serialized);
    const from = (await recoverTransactionAddress({
      serializedTransaction: serialized as never,
    })) as Address;
    const to = (tx.to ?? null) as Address | null;
    const data = (tx.data ?? '0x') as Hex;
    const value = tx.value ?? 0n;
    const at = clock();
    const mySeq = seq;
    seq += 1;

    // The gate runs before anything is forwarded. A refused transaction does
    // not reach the upstream node, so there is no state to unwind and nothing
    // for a reorg to resurrect — it simply never happened.
    if (opts.gate !== undefined) {
      const candidate: CandidateAction = {
        to,
        value,
        data,
        cumulativeValueWei,
        priorActionCount: mySeq,
      };
      const decision = opts.gate(candidate);
      opts.onDecision?.(candidate, decision);

      if (!decision.allowed && !decision.advisory) {
        blocked += 1;
        opts.onAction({
          seq: mySeq,
          at,
          to,
          value,
          data,
          decoded: decodeAction(data),
          simulated: { success: false, gasUsed: 0n, revertReason: decision.explanation },
        });
        // A plain JSON-RPC error, because that is what the agent would get
        // from a node that would not accept the transaction. It learns that
        // it failed, not why — the reasoning is Bench's, shown to the owner.
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32003, message: 'transaction rejected' },
        };
      }
    }

    cumulativeValueWei += value;

    const forwarded = await call('eth_sendRawTransaction', [serialized]);

    // Rejected before mining — bad nonce, insufficient funds, a gas estimate
    // that reverts. Still an action the agent took, and still worth recording:
    // an agent that repeatedly submits invalid transactions is telling you
    // something about itself.
    if (forwarded.error !== undefined || typeof forwarded.result !== 'string') {
      opts.onAction({
        seq: mySeq,
        at,
        to,
        value,
        data,
        decoded: decodeAction(data),
        simulated: {
          success: false,
          gasUsed: 0n,
          ...(forwarded.error ? { revertReason: forwarded.error.message } : {}),
        },
      });
      return {
        jsonrpc: '2.0',
        id: req.id,
        ...(forwarded.error ? { error: forwarded.error } : { result: forwarded.result }),
      };
    }

    const hash = forwarded.result as Hex;
    const receipt = await receiptFor(hash);
    const status = receipt?.['status'];
    const success = status === '0x1' || status === 1;
    const gasUsed = typeof receipt?.['gasUsed'] === 'string' ? BigInt(receipt['gasUsed']) : 0n;

    let revertReason: string | undefined;
    if (!success && typeof receipt?.['blockNumber'] === 'string') {
      revertReason = await revertReasonFor(from, to, data, value, receipt['blockNumber']);
    }

    opts.onAction({
      seq: mySeq,
      at,
      to,
      value,
      data,
      decoded: decodeAction(data),
      simulated: { success, gasUsed, ...(revertReason === undefined ? {} : { revertReason }) },
    });

    // The agent gets the hash it would have got from a real node.
    return { jsonrpc: '2.0', id: req.id, result: hash };
  };

  const handleOne = async (req: JsonRpcRequest): Promise<unknown> => {
    if (req.method === 'eth_sendRawTransaction') return handleSendRaw(req);
    return upstream(req);
  };

  const server: Server = createServer((httpReq, httpRes) => {
    const chunks: Buffer[] = [];
    httpReq.on('data', (c: Buffer) => chunks.push(c));
    httpReq.on('end', () => {
      void (async () => {
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          const out = Array.isArray(body)
            ? await Promise.all((body as JsonRpcRequest[]).map(handleOne))
            : await handleOne(body as JsonRpcRequest);
          httpRes.writeHead(200, { 'content-type': 'application/json' });
          httpRes.end(JSON.stringify(out));
        } catch (err) {
          httpRes.writeHead(500, { 'content-type': 'application/json' });
          httpRes.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: {
                code: -32603,
                message: err instanceof Error ? err.message : 'interceptor failure',
              },
            }),
          );
        }
      })();
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new BenchError('FORK_UNAVAILABLE', 'interceptor could not bind a port'));
        return;
      }
      resolve(addr.port);
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    actionCount: () => seq,
    blockedCount: () => blocked,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
