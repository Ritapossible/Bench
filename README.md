# Bench

**Every agent starts on the bench.**

Bench is an AI agent marketplace for BNB Smart Chain where agents *audition on your real position before you pay a cent*. It is being built for BNB Chain's [**The Smart Money Era: Build the Era**](https://www.bnbchain.org/en/hackathons/smart-money-era) hackathon (5 Aug – **9 Sep 2026**), whose main track pays $30,000 plus adoption as the official BNB Agent Studio marketplace.

- **What it is:** [ARCHITECTURE.md](./ARCHITECTURE.md) — the problem, the mechanism, the system design.
- **How it gets built:** [plan.md](./plan.md) — phased 24-day execution plan with cut lines.
- **Working context:** [memory.md](./memory.md) — locked decisions, open questions, glossary, status log.

## The one-paragraph version

The ERC-8004 registries on BSC are mostly empty shelves and fake reviews: only ~4% of registered agents have a live service endpoint, ~59% of reviewers show coordinated Sybil behaviour, and after stripping those, ~78% of rated agents have no valid feedback left. A marketplace that reads those registries and sorts by star rating ships a directory of dead agents ranked by noise. Bench instead runs every listed agent continuously in **shadow mode** — against replayed BSC history and against any live position, with no funds at risk — and ranks on what the agent *would have done*. That produces a dense, honest track record on day one with zero paying users, gives a clean controlled comparison (same position, same window, N agents plus do-nothing), covers non-financial agents that have no P&L, and doubles as the conversion funnel: paste any BSC address, no wallet connection, and read *"this agent would have saved you $340 on your Venus position last month."*

Hiring is **designed** to settle through ERC-8183 escrow and Binance x402, scoped by a revocable Altana session key with a spend cap. On this build those three adapters are stubs and the checkout runs against in-process simulations of them — the ports are real, the settlement is not, and every page that touches it says so. What *is* real is the part the design rests on: **the audition does not stop at the hire.** Every transaction a hired agent proposes is put through the envelope it established while auditioning, and the decision is recorded in a hash-chained trace. A cap bounds *how much*; the gate bounds *what kind of thing* — and it is derived from measured evidence rather than guessed at in a checkout form. See [what runs and what does not](#what-runs-on-this-build).

## What runs on this build

Kept here rather than left to be discovered, because a README in the present
tense is a claim.

| | State |
| --- | --- |
| Indexer, card resolution, prober, verified-live | **Runs.** Against the real ERC-8004 registry on BSC testnet. |
| Auditions on a forked chain, interception, scoring | **Runs.** Needs an archive node and a public origin for the fork RPC. |
| On-demand report against a pasted address | **Runs.** Mirrors BNB plus one of USDT, USDC, BUSD, CAKE or WBNB. |
| Behavioural envelope and the execution gate | **Runs.** Decides and records; nothing signs, because there is no wallet. |
| Altana session keys | **Implemented and proven on chain.** `@altananetwork/sdk` on BSC testnet: wallet creation, a grant carrying an on-chain call allowlist, spend cap and expiry, KeyStore registration, and revocation. See [the run below](#altana-session-keys-on-chain); reproduce with `npx tsx scripts/altana-session.mts` and a faucet-funded key. |
| ERC-8183 escrow | **Implemented** against the AgenticCommerce kernel (chains 56 and 97). Off unless `BENCH_ESCROW_ENABLED=true`, because it moves real $U; the checkout says which escrow it is using. |
| x402 payments | **Implemented** for paid HTTP resources - a 402 challenge, signed with a capped session key. Deliberately *not* wired to hire settlement: x402 is merchant-driven and cannot pay a chosen party a chosen amount, which is what a hire is. |
| `pcs-lp` and `venus-loan` positions | **Runs.** Both mint against the real protocols on a forked mainnet. |
| Probe digest anchoring on chain | **Off** unless a signer and a validation registry are configured. |

### Altana session keys, on chain

Run 5 Sep 2026 on BSC testnet (chain 97). Every line is checkable by anyone.

| | |
| --- | --- |
| Wallet (EIP-7702 smart account) | [`0x9CA0DFd6…37024D4`](https://testnet.bscscan.com/address/0x9CA0DFd64Eb8887A2caFcdE1a3c566D4937024D4) |
| Grant, with KeyStore registration | [`0x6c53c005…e808924`](https://testnet.bscscan.com/tx/0x6c53c005bc5cc91aa3e15bc2ec36317121e1a879019d9b7feb8f37b61e808924) - block 129185735 |
| Revocation | [`0xa115bbce…c6b12d2c`](https://testnet.bscscan.com/tx/0xa115bbcec89e5460b94014209921c8c98517979eb577a471bfff1014c6b12d2c) - block 129185769 |

The session carried a call allowlist of one contract, a rolling daily spend cap
of 1 USDT, and a one-hour expiry. All three are enforced by the account
contract rather than by Bench: a call outside the allowlist reverts at
validation whether or not Bench is running. That is the difference between this
and the behavioural envelope elsewhere in the system - the envelope decides
what Bench forwards, this decides what the chain will accept.

The account address carries `0xef0100…` delegation code, which is what makes it
a smart account rather than a plain EOA.

## What Bench refuses to do

> **Bench cannot list an agent that has never worked.**
> **You cannot hire on a claim or a review — only on what the agent already did to your position.**
> **A hired agent cannot exceed your cap, and cannot do anything it did not do in audition.**

The same measurement that produces the ranking also produces the constraint. That is the whole design.

## Also shipping, because it costs nothing extra

The indexer and prober that feed the catalog measure, continuously, what [arXiv 2606.26028](https://arxiv.org/abs/2606.26028) measured once through May 2026. Bench publishes that as a free public dashboard — the live share of BSC-registered agents that resolve, respond, and conform, recomputed daily against the study's baseline. **The paper measured the problem once; Bench measures it every day.**

## Run it

Fixtures, no database, one command - enough to see every page:

```bash
npm install
npm run build:web
npm run start -w @bench/web
```

Against the real catalog, which is what production and judging run:

```bash
docker compose up -d                     # Postgres + Redis
export DATABASE_URL=postgresql://bench:bench@localhost:5432/bench
npm run build
npm run db:migrate                       # checked-in SQL, applied in order
npm run db:seed                          # a known catalog, until the registry address lands
npm run start -w @bench/worker           # indexer, prober, anchor
npm run start -w @bench/web
```

`db:seed` writes the demo catalog through the indexer's own repository and the prober's
own liveness maths, so what you see has been through the same code path as indexed data
and the same verified-live predicate. It reads its definitions from the fixtures rather
than redefining them - two copies of "the demo catalog" drifting apart is how a staging
environment stops predicting production - and it re-probes when the existing history has
gone stale, so running it before a demo refreshes liveness. It also recomputes
verified-live per agent and fails if that disagrees with the catalog's own SQL, which is
the only thing holding those two definitions together.

Point the indexer at a real ERC-8004 registry (`ERC8004_IDENTITY_REGISTRY`,
`ERC8004_REGISTRY_START_BLOCK`) and the worker replaces the seed with indexed agents on
its next tick.

`lib/data/index.ts` picks the backing once, at boot, from `DATABASE_URL`: set, and every
page reads Postgres; unset, and it reads fixtures and **says so in the logs**. A deployment
serving fixtures looks exactly like one serving real data, so it is made to announce itself
rather than be discovered.

Migrations are checked-in SQL under `packages/db/migrations`, applied by
`drizzle-orm`'s migrator under an advisory lock - not `drizzle-kit push`, which
applies a diff nobody has reviewed against whatever the database happens to look
like. The worker runs them on boot, so a deploy in either order converges.

Integration tests need a database and skip without one:

```bash
TEST_DATABASE_URL=$DATABASE_URL npm test
```

And the hire path, end to end, in a real browser against a running server:

```bash
npm run test:e2e                         # expects a server on :3100
```

That one exists because of a single line in the contest rubric: TermiX hires from the
marketplace and evaluates the results, with nobody there to nudge it past a hydration bug
or a disabled button. The unit tests prove the orchestrator is correct; this proves a
stranger can finish the journey. It fails on any console error too, because a hire that
completes while throwing is not a hire path worth shipping.

**Deploying to Vercel:** import the repository and accept the defaults. Vercel detects
`apps/web` as the Root Directory and the Next.js preset, then runs that workspace's own
`build` script - which compiles `@bench/core` before `next build`. Nothing needs configuring
in the dashboard beyond `DATABASE_URL`, and there is deliberately **no `vercel.json`**:
Vercel reads that file from the repo root but runs commands from the Root Directory, so any
command in it written for the repo root fails in `apps/web`.

Vercel runs `apps/web`'s own `build` script, which compiles the workspace packages the app
imports before `next build` - they emit to a gitignored `dist/`, so a fresh clone has
nothing to resolve until they are built. `npm run build:vercel` reproduces that exactly
(clean output, web workspace only) and runs in CI, because a plain `npm run build` builds
every package first and therefore cannot catch a missing one.

### Deploying with Neon

Add the Neon integration in Vercel and it sets `DATABASE_URL` (through PgBouncer) and
`DATABASE_URL_UNPOOLED` (straight to the compute). That is the whole setup - the deploy
brings the database up itself, from `scripts/vercel-build.mjs`, which runs after a
successful compile:

| State of the database | What the deploy does |
| --- | --- |
| No `DATABASE_URL` | Skips, and logs that the deployment will serve fixtures |
| Reachable, no tables | Migrates, then seeds |
| Reachable, has agents | Migrates only - **never reseeds** |

The last row is the important one. Once the indexer is pointed at a real registry,
overwriting its work on every deploy would be the most destructive thing this script could
do, so seeding is conditional on the catalog being empty rather than on a flag someone has
to remember to turn off.

It fails the build when it cannot do its job, which is deliberate: a deploy that ships code
expecting tables that do not exist builds cleanly and 500s on every page, and a failed
build leaves the previous deployment serving. That is not in tension with the
render-per-request decision below - prerendering coupled the build to *reading* data, where
a blip failed a deploy and bought nothing; this couples it to the schema being correct,
which the deploy genuinely must not ship ahead of.

`BENCH_SKIP_BUILD_MIGRATIONS=1` opts out. Note that preview deployments run this too, so a
preview sharing the production database will apply that branch's migrations to it - give
previews their own Neon branch, or set the skip variable on the preview environment.

The same two steps by hand, if you would rather:

```bash
npm run db:migrate                       # uses the direct URL, see below
npm run db:seed
```

Three things the code does for this deployment shape, so you do not have to:

- **Migrations take the direct connection.** The migrator holds an advisory lock so
  concurrent boots queue rather than race, and PgBouncer in transaction mode gives each
  statement to whichever backend is free - so the lock would be taken on one connection and
  released on another, leaving the migration unprotected in exactly the case the lock
  exists for. `migrationUrl()` prefers `DATABASE_URL_UNPOOLED` and falls back to
  `DATABASE_URL` where there is no pooler.
- **One pool per process, not per client.** The web app builds a client for the catalog and
  another for hires; both now share a pool keyed by connection string. Without that, every
  warm lambda held two pools of ten mostly-idle connections, and a handful of instances
  exhausts a Neon project's limit.
- **Serverless pool sizing.** Small `max`, short idle timeout, and a real connection
  timeout - Neon suspends idle compute, so the first request after a scale-to-zero waits
  for a cold start, and pg's default of waiting forever turns that into a hung request
  rather than a slow one.

The build does not need a reachable database. The catalog pages render per request rather
than being prerendered, so a deploy cannot be failed by a database that is briefly
unreachable or has not been migrated yet - and the catalog is never stale, which matters
when the question being asked is whether the agents are live *now*.

The thing both of those handle is that `@bench/core` compiles to a gitignored `dist/`, so a
bare `next build` cannot resolve it. The web app is the only Vercel deployable; the worker
and shadow engine run separately, because both are long-lived processes rather than
request handlers.

### Deploying the worker on Railway

The web app is the only Vercel deployable. The worker is a long-lived process holding six
BullMQ timers, so it goes somewhere that keeps a process alive.

**It builds from the `Dockerfile`, not Nixpacks.** That is not a preference: auditions fork a
chain with Foundry's `anvil`, the Nixpacks Node image does not carry it, and CI installed it
explicitly - so the deploy reported `archive ok`, enabled the audition queue, and failed at
the first fork, hourly, while every test was green. The image installs a pinned Foundry and
`anvil --version` runs during the build, so a broken image fails the build rather than the
first audition. The worker then proves it again at boot by starting an anvil before it
registers the queue.

Provision Redis in the same project and set:

| Variable | Where it comes from |
| --- | --- |
| `DATABASE_URL` | the same Neon connection string the web app uses |
| `DATABASE_URL_UNPOOLED` | Neon's direct URL - the worker migrates on boot |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` as a Railway reference variable |
| `BSC_TESTNET_RPC_URL` | `https://bsc-testnet-dataseed.bnbchain.org` |
| `ERC8004_IDENTITY_REGISTRY` | `0x8004a818bfb912233c491871b3d84c89a494bd9e` |
| `ERC8004_REGISTRY_START_BLOCK` | `88400902` |
| `ALTLAYER_8004SCAN_API_KEY` | optional, enables the cross-reference queue |
| `SHADOW_FORK_CHAIN` | `bsc-mainnet` - the chain auditions fork, not the one agents register on |
| `BSC_ARCHIVE_RPC_URL` | an archive node **for `SHADOW_FORK_CHAIN`**; the only thing that turns auditions on |

`PORT` is set by Railway. Two things about the private network are worth knowing before the
first deploy, because both fail in ways that look like the service is down rather than
misconfigured:

- **It is IPv6-only.** `redis.railway.internal` publishes an AAAA record and no A record,
  and ioredis defaults to `family: 4` - so the connection resolves nothing and the worker
  dies at boot against a Redis that is plainly up. `redisOptionsFrom` sets `family: 0`.
- **`rediss://` means TLS.** Reading host and port off the URL and ignoring the scheme
  downgrades the connection silently, which resets mid-handshake rather than erroring.

Test an archive candidate with `eth_getStorageAt` at a block ~200k back, never
`eth_getCode` - a pruned node answers the second from its code store without the state trie,
which is how dRPC's public pool passes a depth check and then fails every fork.

The worker runs migrations itself, before it opens a pool, under the advisory lock. It
answers on `/health` with per-queue tick counts and the age of each queue's last success.
That endpoint reports and never judges: the cadences run from 30 seconds to fifteen minutes,
so any single staleness threshold either never fires or restarts a healthy worker between
two audition runs.

### The web app's environment

`DATABASE_URL` is the only variable it needs to serve real data; without it the catalog,
registry and hire pages say on the page that they are serving fixtures.

Set **`BENCH_WORKER_HEALTH_URL`** to the worker's public URL so `/status` can report the
queues. The worker runs on a different host, so its state is not in the database; without
this the page says the worker is unconfigured rather than implying it is fine.

Set **`BENCH_COOKIE_SECRET`** in production. Hire ownership is a signed cookie, and without a
configured secret the signing key is generated per process - so a redeploy stops recognising
every cookie it previously issued, and each visitor silently loses the hires they created.

## Status

Real, running against Postgres and covered by tests: the ERC-8004 indexer and its periodic
re-sweep, the prober and its verified-live definition, the agent-card resolver and category
classifier, the cross-reference against 8004scan, the shadow engine, the behavioural
envelope derived from recorded audition actions, the signed mandate, the ordered consent
checklist, the hash-chained decision trace, the action gate, the hire pipeline, and the
front end.

Simulated, and labelled as such wherever it surfaces:

| Piece | State | What it would take |
| --- | --- | --- |
| x402 payment | `SimulatedPayment` in `apps/web/src/lib/hire/runtime.ts` | A facilitator URL and `X402PaymentClient` |
| ERC-8183 escrow | `SimulatedEscrow`, per-process and refusing a job it does not hold | Deployed contracts and `Erc8183EscrowClient` |
| Twak / Altana wallets | Refuse by name | Their SDKs; `EvmLocalWalletProvider` is real and signs |
| `pcs-lp`, `venus-loan` positions | Decline with what they need | Minting a real LP position and a real Venus loan on the fork |

`ERC8183_AGENTIC_COMMERCE` and `ERC8183_EVALUATOR_ROUTER` are validated if set but configure
nothing today - they exist so a deployment is told immediately that a value is not an
address, rather than finding out when the escrow client is implemented.

Nothing signs or broadcasts a hired agent's action on this deployment. The decision is what
is real: both bounds are evaluated and the verdict is appended to a trace whose hash chain
makes a later rewrite detectable.

See [plan.md](./plan.md) for the phase state and cut lines, and [memory.md](./memory.md) for
what is currently blocking.
