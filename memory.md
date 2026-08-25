# Bench — Working Memory

Persistent context for anyone (human or agent) picking this project up mid-flight. Keep it current; it is the file to read first.

**Last updated:** 25 Aug 2026 (frontend shipped; Phase 2 shadow engine landed)

---

## What Bench is, in one sentence

An AI agent marketplace on BNB Smart Chain where agents **audition on your real position before you pay** — Bench runs every listed agent in shadow mode against replayed history and the user's live position, ranks on what they would have done, then hires the winners under a revocable spend cap.

## Why it exists

Built for the BNB Chain **"Build the Era"** hackathon. Grand prize is adoption as the official BNB Agent Studio marketplace.

- Build: 5 Aug – **9 Sep 2026** (submission deadline)
- Judging: 9 – 23 Sep 2026
- Winners announced: **5 Nov 2026**

The six-week gap between judging and announcement is the tell: this is a procurement exercise with a hackathon wrapper. They are selecting a **team to partner with**, not a demo to admire. Code quality, deploy story, docs, and evidence of durability are being scored whether or not the rubric says so.

## Locked decisions

| Decision | Rationale |
|---|---|
| **Name: Bench** | Double meaning — agents sit on the bench until called up, and *benchmark* is literally what the shadow engine does. Tagline: *"Every agent starts on the bench."* |
| **Shadow mode is the core primitive** | Solves cold start, attribution, category coverage, and conversion with one mechanism. Everything else is downstream of it. |
| **Rank on auditions, not stars** | ERC-8004 reputation on BSC is measurably worthless (see Key facts). |
| **Write to the Validation Registry, not Reputation** | Validation has verifiable semantics and validator hooks; Reputation is trivially gamed. |
| **TypeScript, not Python** | `AltanaWalletProvider` (EIP-7702 session keys) is TS-only in the BNBAgent SDK. |
| **Wedge: PancakeSwap LP + Venus health factor** | Real users, real capital, clean measurable counterfactuals, live partner track. |
| **Index 8004scan, don't compete with it** | It already exists as an explorer, and AltLayer is a prize sponsor. Bench's delta over an explorer is *hiring, money at risk, and recourse*. |
| **Two-column leaderboard: simulated \| realized** | Always labelled, never merged. Honesty here is a differentiator, not a limitation. |
| **Don't require agents to support `dry_run`** | Nobody implements it. Intercept at the RPC layer against a forked node instead — the agent believes it is live. |

## Open questions — ask the organizers, unanswered as of 16 Aug

Answers change what gets built. Asking also signals a serious counterparty.

1. What does "officially adopted as a standalone product" mean contractually — IP assignment, licence, maintenance obligation, ongoing funding?
2. What licence is required for submissions?
3. Is the full scoring rubric published? The blog defers it to the contest page. **Get it and build to it directly.**
4. Mainnet or testnet for judging, given ERC-8183 mainnet is pending?

## Key facts (verified, with sources)

From the empirical ERC-8004 study, arXiv 2606.26028, data through May 2026:

- Only **~4%** of BSC-registered agents have a valid registration with a live endpoint (3% ETH, 15% Base).
- **~59%** of BSC reviewers show coordinated Sybil behaviour (73.5% ETH, 90.6% Base).
- After removing Sybil-flagged feedback, **~78%** of rated BSC agents have no valid feedback left.
- Study's conclusion: reputation values are not comparable, feedback rarely links to a verifiable transaction, manipulation is near-free.

Ecosystem:

- **BNB Agent Studio** launched 1 Jul 2026, co-engineered with AWS (Bedrock AgentCore). Mints a wallet-owning ERC-8004 agent in ~15 min. **Supply is not the constraint — demand is.**
- **BNBAgent SDK** — Python + TypeScript, self-described *"under active development, may introduce breaking changes."* Pin it, wrap it.
- Wallet providers in SDK: `EVMWalletProvider` (both), `TWAKProvider` (both), `AltanaWalletProvider` (**TS only**).
- Registration is **gas-free on BSC testnet** via MegaFuel paymaster sponsorship.
- **x402** on BSC supports U, USDT, USD1, USDC; auth methods `eip3009`, `permit2-exact`, `permit2-upto`. Use `permit2-upto` for metered agents.
- **ERC-8183** = AgenticCommerce kernel + EvaluatorRouter + OptimisticPolicy. Optimistic settlement; silence past the dispute window is approval. Testnet live, mainnet pending.

## Prize pool

$40,000+ — BNB Chain $30k USDT (+ adoption) · TermiX $10k USDT · PancakeSwap 1,000 CAKE · AltLayer 8004scan Pro + AltLLM credits · Altana 50,000 XP. **No fixed main track**, so positioning and narrative carry unusual weight. One coherent build qualifies for all five; most teams will enter one.

## Traps already identified — do not relearn these

- **The obvious build loses.** Registry read + agent cards + star sort = an empty directory of dead agents ranked by noise. Twenty teams will ship it.
- **Ranking rigor alone loses too.** BNB Chain's real problem is that deployed agents never get hired. The marketplace must be a demand engine, not a leaderboard.
- **Don't overclaim statistical rigor.** Risk-adjusted delta over a dozen settled jobs is meaningless, and TermiX judges trade for a living. Shadow mode exists partly because it produces defensible sample sizes; report window and n next to every score anyway.
- **Shadow runs can spend real money** via outbound x402 data calls. Hard egress budget per run, plus an outbound allowlist.
- **Don't build another explorer.** 8004scan is that, and its sponsor is judging.

## Glossary

- **Audition** — a shadow run of one agent over one window against one position template.
- **Shadow mode** — agent executes against a forked-state RPC with a mirrored position; transactions are intercepted and simulated, never broadcast.
- **Do-nothing baseline** — the counterfactual where no agent acts on the position.
- **Peer median** — median terminal state across all agents auditioning the same window.
- **Verified live** — agent endpoint responded and conformed to its declared protocol within the probe window.
- **Broker agent** — Bench itself, registered under ERC-8004, turning an intent into a team of agents under one escrow and one session key.

## Status log

- **16 Aug 2026** — Concept locked, named Bench. Architecture and plan written. Phase 0 not yet started. Organizer questions not yet sent.
- **16 Aug 2026 (later)** — Phase 0 complete and pushed to `github.com/Ritapossible/Bench`. Phase 1 backend written: indexer, prober, anchor, catalog repository (Postgres + in-memory), SSRF-guarded fetch, agent-card resolver, verified-live filter. Frontend deliberately untouched.

  **Decision — Phase 1 rides on viem, not `@bnbagent/sdk`.** Reading the Identity Registry is standard ERC-721 access, so it does not need the SDK, whose export surface is still unverified against the pin. This keeps the catalog unblocked by a dependency we cannot check. The SDK earns its place in Phase 4, where Altana EIP-7702 session keys have no viem equivalent.

  **Blocked on the local machine, not on the code:** `npm install` cannot complete — repeated `ENOTEMPTY`/`rm: Directory not empty` failures under Windows file locks, which have progressively corrupted `node_modules` (viem, zod, drizzle-orm, vite, and finally typescript itself). `@bench/core` and `@bench/services` typechecked clean and passed 36 assertions against compiled output *before* the tree degraded; `@bench/adapters`, `@bench/db`, and the worker are written but unverified. **Next action: recover `node_modules` (close editors/watchers, exclude the repo from Defender real-time scanning, `rm -rf node_modules packages/*/node_modules && npm install`), then `npm run typecheck && npm test`.**

  Two things still owed from Phase 0, unchanged: **organizer questions not sent**, and the **real scoring rubric not pulled**. Both gate what gets built next, so they outrank more code.

- **25 Aug 2026 — frontend shipped, Phase 2 shadow engine landed, Vercel deploy wired.**

  **The npm blocker was local, and it was hiding three real bugs.** On a clean Linux tree `npm install` completes in ~46s. Once `@bench/adapters` could finally be typechecked and tested, three defects surfaced that had never been run:

  1. `ERC8004_IDENTITY_REGISTRY` was typed as a plain string in `@bench/config` while the adapter needs the hex-literal type. **This failed `tsc -b` outright**, so no package downstream of config could emit. Fixed at the schema with a transform, since the regex already proves the shape.
  2. **SSRF bypass in `safe-fetch`, and it was a live hole.** The IPv4-mapped IPv6 filter matched on the dotted-quad spelling, but `new URL()` rewrites `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]` and `[0:0:0:0:0:ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]` — so **cloud metadata was reachable through a registered agent's declared endpoint**. Now decided by expanding to hextets and matching on structure rather than spelling; six spellings covered by regression tests.
  3. `next@15.1.3` carries CVE-2025-66478 → bumped to 15.5.23.

  **Shadow engine.** `anvil-process` (lifecycle, free port, readiness, guaranteed reaping), `interceptor` (JSON-RPC proxy; `eth_sendRawTransaction` decoded, executed against fork state, recorded; everything else proxied), `tx-decode` (ERC-20 + PCS + Venus, total), `seeders` (`spot-balance` complete; the two wedge kinds decline with exactly what they need), `anvil-fork` (composition), `AuditionRunner` (N agents + do-nothing baseline). 110 tests pass; anvil-dependent ones skip when the binary is absent.

  **`BSC_ARCHIVE_RPC_URL` is now the single highest-value unblock.** Nothing has forked real BSC state yet. It turns on the `pcs-lp` and `venus-loan` seeders and the window library, which is the rest of Phase 2.

  **Egress guard is NOT enforced.** Written, tested, accepted by the runner — but the fork sandboxes transactions, not sockets. Do not audition an agent that pays for data until its outbound HTTP is proxied.

  **Frontend.** Five routes live, monochrome design system, colour reserved for state. All data behind the `BenchData` interface in `apps/web/src/lib/data` — fixtures today, one file to swap. Wallet deliberately unwired: nothing before hiring needs a signature. `vercel.json` + `npm run build:web` deploy with Root Directory left at `.`.
