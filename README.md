# Bench

**Every agent starts on the bench.**

Bench is an AI agent marketplace for BNB Smart Chain where agents *audition on your real position before you pay a cent*. It is being built for BNB Chain's [**The Smart Money Era: Build the Era**](https://www.bnbchain.org/en/hackathons/smart-money-era) hackathon (5 Aug – **9 Sep 2026**), whose main track pays $30,000 plus adoption as the official BNB Agent Studio marketplace.

- **What it is:** [ARCHITECTURE.md](./ARCHITECTURE.md) — the problem, the mechanism, the system design.
- **How it gets built:** [plan.md](./plan.md) — phased 24-day execution plan with cut lines.
- **Working context:** [memory.md](./memory.md) — locked decisions, open questions, glossary, status log.

## The one-paragraph version

The ERC-8004 registries on BSC are mostly empty shelves and fake reviews: only ~4% of registered agents have a live service endpoint, ~59% of reviewers show coordinated Sybil behaviour, and after stripping those, ~78% of rated agents have no valid feedback left. A marketplace that reads those registries and sorts by star rating ships a directory of dead agents ranked by noise. Bench instead runs every listed agent continuously in **shadow mode** — against replayed BSC history and against any live position, with no funds at risk — and ranks on what the agent *would have done*. That produces a dense, honest track record on day one with zero paying users, gives a clean controlled comparison (same position, same window, N agents plus do-nothing), covers non-financial agents that have no P&L, and doubles as the conversion funnel: paste any BSC address, no wallet connection, and read *"this agent would have saved you $340 on your Venus position last month."*

Hiring settles through ERC-8183 escrow and Binance x402, scoped by a revocable Altana session key with a spend cap. **And the audition does not stop at the hire:** every transaction the hired agent produces is simulated and checked against the envelope it established while auditioning, before that session key will sign it. A cap bounds *how much*; the gate bounds *what kind of thing* — and it is derived from measured evidence rather than guessed at in a checkout form.

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
npm run start -w @bench/worker           # indexer, prober, anchor
npm run start -w @bench/web
```

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

**Deploying to Vercel:** import the repository and accept the defaults. Vercel detects
`apps/web` as the Root Directory and the Next.js preset, then runs that workspace's own
`build` script - which compiles `@bench/core` before `next build`. Nothing needs configuring
in the dashboard beyond `DATABASE_URL`, and there is deliberately **no `vercel.json`**:
Vercel reads that file from the repo root but runs commands from the Root Directory, so any
command in it written for the repo root fails in `apps/web`.

The thing both of those handle is that `@bench/core` compiles to a gitignored `dist/`, so a
bare `next build` cannot resolve it. The web app is the only Vercel deployable; the worker
and shadow engine run separately, because both are long-lived processes rather than
request handlers.

## Status

Built and covered by tests: the ERC-8004 indexer, the prober and its verified-live
definition, the agent-card resolver, the shadow engine (forked-chain interception with a
signing gate), the behavioural envelope, the signed mandate, the ordered consent checklist,
the hash-chained decision trace, the hire pipeline, and the full front end. All of it runs
against Postgres, not fixtures.

Still stubbed: the x402 payment client and the ERC-8183 escrow client are simulated
adapters behind their real interfaces, labelled as such everywhere they surface in the UI.
The catalog is seeded rather than indexed from a live registry until the registry address is
confirmed.

See [plan.md](./plan.md) for the phase state and cut lines, and [memory.md](./memory.md) for
what is currently blocking.
