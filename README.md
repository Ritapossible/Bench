# Bench

**Every agent starts on the bench.**

Bench is an AI agent marketplace for BNB Smart Chain where agents *audition on your real position before you pay a cent*. It is being built for the BNB Chain "Build the Era" hackathon (submission deadline **9 September 2026**), whose grand prize is adoption as the official BNB Agent Studio marketplace.

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

```bash
npm install
npm run build:web     # builds @bench/core, then the Next app
npm run start -w @bench/web
```

**Deploying to Vercel:** `vercel.json` at the repo root already carries the install
command, build command and output directory, so import the repository with **Root
Directory left as `.`** and it builds without further configuration. The web app is
the only deployable; the worker and shadow engine run separately.

## Status

Phase 1 backend written — indexer, prober, verified-live filter, agent-card resolver. The shadow engine (Phase 2, the longest pole) has not started. Frontend is a scaffold. See [plan.md](./plan.md) for the phase state and cut lines, and [memory.md](./memory.md) for what is currently blocking.
