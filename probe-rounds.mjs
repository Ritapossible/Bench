import { HttpProbeClient } from '@bench/adapters';
import { PgCatalogRepository, createDb } from '@bench/db';
import { Prober } from '@bench/services';

const db = createDb('postgresql://bench@127.0.0.1:5433/bench');
const repo = new PgCatalogRepository(db);
// staleAfterMs 0 so every endpoint is immediately due again: verified-live
// needs 3 probes and this compresses three prober cycles into one run.
const prober = new Prober(new HttpProbeClient({ timeoutMs: 5_000, allowLoopback: false }), repo, {
  batchSize: 250,
  concurrency: 24,
  staleAfterMs: 0,
});

for (let round = 1; round <= 2; round += 1) {
  let probed = 0;
  for (let i = 0; i < 8; i += 1) {
    const r = await prober.tick();
    if (r.probed === 0) break;
    probed += r.probed;
  }
  console.log(`round ${round}: probed ${probed}`);
}
console.log('final stats:', JSON.stringify(await repo.stats('bsc-testnet')));
await db.$client.end();
