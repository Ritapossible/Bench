import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { BenchError } from '@bench/core';

/**
 * Anvil process management.
 *
 * Split out from the fork provider because process lifecycle is the part that
 * leaks: an audition that throws halfway must still reap its node, or a few
 * hundred queued runs leave a few hundred orphaned anvils holding ports and
 * memory. Every path out of `startAnvil` either returns a handle whose `stop`
 * works or has already killed the child.
 */

export interface AnvilOptions {
  /** Archive node to fork from. Omit for a bare chain — see `forkless` in AnvilForkProvider. */
  readonly forkUrl?: string;
  readonly forkBlockNumber?: bigint;
  readonly chainId?: number;
  readonly binary?: string;
  readonly startupTimeoutMs?: number;
  readonly extraArgs?: readonly string[];
}

export interface AnvilHandle {
  readonly url: string;
  readonly port: number;
  readonly pid: number | undefined;
  /** Everything anvil wrote, kept for diagnosis when a run fails oddly. */
  readonly log: () => string;
  stop(): Promise<void>;
}

/** Ask the OS for a free port, then release it. Racy in principle; retried by the caller. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close(() => reject(new Error('could not determine a free port')));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

async function rpcReady(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { result?: string };
    return typeof body.result === 'string';
  } catch {
    return false;
  }
}

export async function startAnvil(opts: AnvilOptions = {}): Promise<AnvilHandle> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const binary = opts.binary ?? process.env['ANVIL_BINARY'] ?? 'anvil';

  const args = ['--port', String(port), '--host', '127.0.0.1'];
  if (opts.forkUrl !== undefined) {
    args.push('--fork-url', opts.forkUrl);
    // An ARCHIVE node is mandatory when pinning a block: a pruned node cannot
    // serve historical state and fails confusingly partway through a run.
    if (opts.forkBlockNumber !== undefined) {
      args.push('--fork-block-number', opts.forkBlockNumber.toString());
    }
  }
  if (opts.chainId !== undefined) args.push('--chain-id', String(opts.chainId));
  if (opts.extraArgs) args.push(...opts.extraArgs);

  let child: ChildProcess;
  try {
    child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (cause) {
    throw new BenchError('FORK_UNAVAILABLE', `could not spawn ${binary}`, cause);
  }

  let out = '';
  child.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
  child.stderr?.on('data', (c: Buffer) => { out += c.toString(); });

  let exited = false;
  child.once('exit', () => { exited = true; });

  const stop = async (): Promise<void> => {
    if (exited || child.pid === undefined) return;
    child.kill('SIGTERM');
    // Give it a moment to close its listener, then insist.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!exited) child.kill('SIGKILL');
        resolve();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  const deadline = Date.now() + (opts.startupTimeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (exited) {
      throw new BenchError('FORK_UNAVAILABLE', `anvil exited during startup:\n${out.slice(-2_000)}`);
    }
    if (await rpcReady(url)) {
      return { url, port, pid: child.pid, log: () => out, stop };
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  await stop();
  throw new BenchError('FORK_UNAVAILABLE', `anvil did not become ready on ${url}:\n${out.slice(-2_000)}`);
}
