import { AnvilForkProvider, A2AShadowAgent } from '@bench/adapters';
import { PgAuditionStore, PgCatalogRepository, createDb } from '@bench/db';
import { AuditionRunner, AuditionService, Scorer } from '@bench/services';
import { createServer } from 'node:http';

const db = createDb('postgresql://bench@127.0.0.1:5433/bench');
const repo = new PgCatalogRepository(db);
const store = new PgAuditionStore(db);

// A stand-in registered agent that accepts an A2A task, to prove the shim and
// the persistence path. The fork itself is exercised by shadow.test.ts.
let tasks = 0;
const server = createServer((req, res) => {
  tasks += 1;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { status: 'completed' } }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// A fake fork so this runs without an archive node.
const forks = {
  async spawn() {
    return {
      id: 'f',
      rpcUrl: `http://127.0.0.1:${port}/rpc`,
      async seedPosition() {
        return {
          controller: '0x2222222222222222222222222222222222222222',
          openedAt: { valueUsd: 10_000, detail: {} },
        };
      },
      onAction() {},
      async terminalState() {
        return { valueUsd: 10_420, detail: {} };
      },
      async destroy() {},
    };
  },
  replayHash: () => '0x' + 'ab'.repeat(32),
};

const svc = new AuditionService(
  {
    forks,
    catalog: repo,
    store,
    runner: new AuditionRunner({ forks }),
    agentFor: ({ agent }) =>
      new A2AShadowAgent({
        id: agent.id,
        name: agent.card?.name ?? 'x',
        endpoint: { protocol: 'a2a', url: `http://127.0.0.1:${port}/a2a` },
        allowLoopback: true,
      }),
  },
  { chain: 'bsc-testnet', archiveRpcUrl: 'http://unused', batchSize: 3 },
);

const window_ = { id: 'w1', label: 'test', regime: 'live', forkBlock: 1n, endBlock: 2n, seed: 's' };
const position = {
  kind: 'spot-balance',
  label: 'p',
  params: {},
  capital: {
    token: '0x55d398326f99059ff775485246999027b3197955',
    symbol: 'USDT',
    decimals: 18,
    amount: 10_000n * 10n ** 18n,
  },
};

const tick = await svc.tick(window_, position);
console.log('audition tick:', JSON.stringify(tick));
console.log('agent endpoints hit:', tasks);

const scorer = new Scorer(store);
const page = await repo.query({ chain: 'bsc-testnet', limit: 50 });
const s = await scorer.scoreAll(
  page.entries.map((e) => ({ id: e.record.id, category: e.record.card?.category ?? 'other' })),
);
console.log('scorer:', JSON.stringify(s));

const scored = await store.latestScores(
  page.entries.map((e) => e.record.id),
  'simulated',
);
console.log('scores now in db:', scored.size);
for (const [k, v] of [...scored].slice(0, 3))
  console.log(
    `  ${k} normalized=${v.normalized.toFixed(3)} n=${v.sampleSize} metric=${v.metric.kind}`,
  );

server.close();
await db.$client.end();
process.exit(0);
