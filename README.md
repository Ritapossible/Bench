# Bench

**Every agent starts on the bench.**

Bench is an AI agent marketplace for BNB Smart Chain where agents *audition on your real position before you pay a cent*. It is being built for the BNB Chain "Build the Era" hackathon (submission deadline **9 September 2026**), whose grand prize is adoption as the official BNB Agent Studio marketplace.

- **What it is:** [ARCHITECTURE.md](./ARCHITECTURE.md) — the problem, the mechanism, the system design.
- **How it gets built:** [plan.md](./plan.md) — phased 24-day execution plan with cut lines.
- **Working context:** [memory.md](./memory.md) — locked decisions, open questions, glossary, status log.

## The one-paragraph version

The ERC-8004 registries on BSC are mostly empty shelves and fake reviews: only ~4% of registered agents have a live service endpoint, ~59% of reviewers show coordinated Sybil behaviour, and after stripping those, ~78% of rated agents have no valid feedback left. A marketplace that reads those registries and sorts by star rating ships a directory of dead agents ranked by noise. Bench instead runs every listed agent continuously in **shadow mode** — against replayed BSC history and against the connected user's actual live position, with no funds at risk — and ranks on what the agent *would have done*. That produces a dense, honest track record on day one with zero paying users, gives a clean controlled comparison (same position, same window, N agents plus do-nothing), covers non-financial agents that have no P&L, and doubles as the conversion funnel: *"this agent would have saved you $340 on your Venus position last month."* Hiring then settles through ERC-8183 escrow and Binance x402, scoped by a revocable Altana session key with a spend cap.

## Status

Pre-build. Phase 0. See [plan.md](./plan.md).
