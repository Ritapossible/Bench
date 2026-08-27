# Bench — Execution Plan

**Deadline: 9 September 2026.** Written 16 August 2026 → **24 days.**

Ordering principle: **ship the trust layer before the polish.** An ugly page ranking 40 verified-live agents by measured audition results beats a beautiful page listing 900 dead ones. Every phase below is ordered by demo-criticality, so that stopping at any point still leaves something coherent.

---

## Phase 0 — Foundations (Aug 16–17)

- [x] Repo, CI, Postgres + Redis via docker-compose, Next.js + workers monorepo skeleton.
- [x] **Adapter interfaces first**, before any SDK call: `WalletProvider`, `EscrowClient`, `PaymentClient`, `RegistryClient`. Pin `@bnbagent/sdk` to an exact version. A breaking SDK release must be a one-file fix.
- [ ] Anvil fork of BSC running locally, reproducible from a pinned block. *(`scripts/fork.sh` written; not yet run against an archive node.)*
- [ ] **Send the organizer questions today** (memory.md §Open questions). The answers change what gets built; every day of delay is a day of possible rework. **← still outstanding, and it gates Phase 4.**
- [x] Pull the **actual scoring rubric** from the contest page. *(Done 25 Aug — https://www.bnbchain.org/en/hackathons/smart-money-era. It contradicted a locked scope decision; full rubric and consequences in memory.md §The rubric, correction in ARCHITECTURE.md §8. Three findings that change the build: Agent Diversity across four categories is a third of the main-track criteria; "activate it" puts the hire pipeline inside criterion one, so it cannot be cut; and "agents must be live on BSC, publicly accessible during judging" means fixtures do not survive judging.)*

## Phase 1 — Catalog with a pulse (Aug 18–22)

Goal: a page that is already more useful than a raw registry read.

- [x] Indexer: ERC-8004 registry events → `agents`; resolve `tokenURI` → agent card → capabilities, endpoints, declared permissions. *(Reads via viem/ERC-721 mints; unresolvable cards kept with a recorded reason.)*
- [x] 8004scan cross-reference ingest (complement, credit them; do not rebuild the explorer). *(`CrossReferenceSource` port in core, `Scan8004CrossReference` in adapters, surfaced on `/registry`. **Activates on `ALTLAYER_8004SCAN_API_KEY` alone** and no-ops as `unconfigured` until then — never gates the catalog, since the chain is the source of truth. Response schema is unverified without a key: unrecognised shapes are refused rather than guessed at, and an all-failed run reports `unavailable` rather than 0% agreement, because those are different claims. Pro-tier application submitted separately.)*
- [x] Prober: scheduled endpoint pings → reachability, p95 latency, A2A/MCP conformance. *(Read-only conformance: A2A well-known card, MCP `initialize`, OASF descriptor.)*
- [x] **"Verified live" filter working.** This alone makes the catalog ~25× denser in real agents. *(One predicate in `@bench/core`; mirrored in SQL for the WHERE clause.)*
- [ ] Agent cards + profile pages. Plain styling is fine at this stage. *(Frontend — deliberately deferred.)*
- [ ] Onchain anchoring of the rolling probe hash. *(Hash chain, batching, and the anchor job are done; the registry write itself is still `notImplemented` pending a verified Validation Registry ABI.)*
- [ ] **Public registry health dashboard** (ARCHITECTURE.md §3.2.1). Rides entirely on the indexer and prober, which already work — live share of BSC agents that resolve, respond and conform, against the arXiv baseline. **Ship this independently of Phase 2; it puts something real and verifiable on the internet while the engine is still being built.**

**Environment blocker:** `npm install` cannot complete on the dev machine (Windows file locks → `ENOTEMPTY`), which has corrupted `node_modules`. `@bench/core` and `@bench/services` are verified; `@bench/adapters`, `@bench/db`, and the worker are written but not yet typechecked or tested. See memory.md §Status log for the recovery steps.

**Exit test:** filter to verified-live and get a list of agents that all actually respond.

## Phase 2 — Shadow engine (Aug 23–30) ★ longest pole

Goal: the mechanism the whole product rests on.

- [x] Fork harness: spin Anvil at a pinned block, seed a synthetic mirror of a target position, hand the agent an RPC + throwaway key. **The agent must believe it is live.** *(`shadow/anvil-process.ts`, `shadow/anvil-fork.ts`. The controller key is derived from the window seed, so a replay controls the same address.)*
- [x] RPC interception: capture `eth_sendRawTransaction`, simulate against fork state, record intended action + decoded intent + state diff. *(`shadow/interceptor.ts`; decoding in `shadow/tx-decode.ts` covers ERC-20, PCS v3 and Venus. Unknown selectors yield `null` rather than throwing, and a transaction rejected before mining is recorded, not dropped.)*
- [~] **Egress budget guard + outbound allowlist.** The guard is implemented and tested (`shadow/egress-guard.ts`, deny-by-default on both host and budget) and `AuditionRunner` accepts it — but **nothing enforces it yet**. The fork sandboxes an agent's *transactions*, not its *sockets*, so enforcement needs the agent's outbound HTTP routed through a proxy, which lands with the containerised agent runner. **Until then, do not audition an agent that pays for its data.**
- [x] Run orchestration: N agents on the same window in parallel, plus the do-nothing baseline. *(`AuditionRunner` in `@bench/services`: own fork per agent, bounded by `maxConcurrentForks`, per-agent timeout, agent failures recorded as findings rather than discarded. Queue-agnostic — BullMQ wiring still to come.)*
- [x] Determinism: persist fork block, seed, window with every run so any audition is independently replayable. *(`replayHash` delegates to `@bench/core`, so the value published with an outcome and the value a third party recomputes come from one implementation.)*
- [ ] Historical window library: one crash, one chop, one rally, for both wedge position types. *(Blocked on an archive RPC — see below.)*

- [ ] **`npx bench-replay <auditionId>`** (§3.3.1) — re-runs a stored audition and reports whether it matches what Bench published. A wrapper over the determinism record, not new capability, and it converts the central claim from a sentence into a command a judge can run.

**Exit test:** ✅ **passing** — `npm run shadow:demo` runs three agents on one window, produces three distinct terminal states, and reproduces the first agent's terminal value exactly on replay.

**What is still forkless.** The demo and the integration tests run anvil with no `--fork-url`. That exercises seeding, interception, decoding, valuation, the do-nothing baseline and replay — everything except forking real BSC state. The `spot-balance` seeder is complete; `pcs-lp` and `venus-loan` decline loudly until they have a forked chain carrying those protocols. **A BSC archive RPC URL is the single remaining unblock** for both of them, for the window library, and for `bench-replay` against a real window.

## Phase 3 — Scoring, reports, leaderboard (Aug 31 – Sep 3)

- [ ] Per-category scorers: yield, grid/trading, monitoring (precision/recall/false-alarm), health factor (lead time before liquidation price touched).
- [ ] Deltas vs do-nothing and vs peer median.
- [ ] **Audition report** — the user-facing artifact, and TermiX's "Agent Advantage Report" delivered automatically rather than hand-built for three demo cases.
- [ ] Leaderboard with **two columns, simulated and realized, always labelled**, sample size and window shown next to every score.
- [ ] Side-by-side compare view (N agents, one window).
- [ ] **Paste-an-address audition report** (§3.8) — no wallet connection. Removes the highest-friction step from in front of the highest-value screen, and makes the report shareable.
- [ ] Attestor: sign outcome records → ERC-8004 **Validation Registry** (not Reputation).

**Exit test:** open any agent profile and see a report that says what it would have done, against what baseline, over what window, with what sample size.

## Phase 4 — Hire pipeline + seed agents (Sep 4–6)

- [ ] x402 checkout, `permit2-upto` for metered agents.
- [ ] ERC-8183 escrow: fund → job → optimistic settle → dispute path.
- [ ] Altana EIP-7702 session key: spend cap + contract allowlist, minted at checkout.
- [x] **Execution gate** (§2.1) ★ — **landed early, as this plan said it should be.** `deriveEnvelope` and `checkAgainstEnvelope` are pure domain logic in `@bench/core` (one definition, so the app, the worker and the signer cannot drift); `startGatedSession` in `@bench/adapters` puts them in the transport path. Six rules — unseen recipient, unseen selector, single value, cumulative value, action count, simulated position drop — each with tolerance over what was observed, because a bound pinned to the exact maximum is a straitjacket rather than a safety bound. An envelope under three auditions is marked **advisory**: recorded, not enforced. **`npm run gate:demo`** runs beat 2 end to end and then proves it by reading the chain: refused transaction absent, attacker balance zero, controller nonce 1 not 2.
- [ ] **Revoke control on the hire card**, plus the active-hire dashboard showing cap remaining and a log of blocked transactions with the rule that fired.
- [ ] Payment-gated feedback: a review counts only when bound to a settled nonzero-value job, weighted by payment size and payer history.
- [ ] Two seed agents on the wedge: **PancakeSwap LP range rebalancer**, **safe swap router** (slippage / MEV / honeypot guarded).

**Exit test:** hire an agent end to end on testnet, watch the cap decrement, revoke mid-job, confirm the session key is dead.

## Phase 5 — Broker agent + live-position auditions (Sep 7–8)

- [ ] Register Bench itself under ERC-8004 as a broker agent.
- [ ] Intent input → decomposition → team selection from audition rankings → **one escrow, one capped session key** covering the team.
- [ ] Shadow against the *connected user's live position*, not just historical windows — this is the conversion moment ("would have saved you $340 on your Venus position").
- [ ] Visual pass on the three screens that appear in the video. Only those three.

## Phase 6 — Freeze and submit (Sep 9)

- [ ] Code freeze early in the day. No new features.
- [ ] Seed the deployment with real audition volume — it costs compute, so start the backfill running on **Sep 7**, not on submission day.
- [ ] README, architecture doc, deploy instructions, licence.
- [ ] **Demo video.** See below.
- [ ] Submit via the intake form. Do not submit in the final hour.

---

## The demo

Do not show a happy path. Three beats, and **the middle one is the film**.

1. **Three agents audition on the same position, side by side.** One of them is quietly losing money in simulation. The user hires the one that didn't. *(The ranking claim.)*
2. **The hired agent then does something it never did in audition** — reaches for an address that appeared in no audition run — and **the transaction dies before it reaches the chain**, with the rules that fired shown on the hire card. *(ARCHITECTURE.md §2.1. Working now: `npm run gate:demo`, which also proves the refusal by reading the chain afterwards — attacker balance zero, controller nonce 1 not 2.)*
3. **Revoke mid-job.** The session key goes dead with the cap still holding. *(Recourse.)*

Build the video around beat 2. Beats 1 and 3 are things a careful team could plausibly *claim*; beat 2 shows an agent **stopped by evidence it generated about itself**, which is precisely the thing the ERC-8004 research says nobody can currently do. It is also the only beat no other submission can copy without having built the shadow engine first.

**Show the refusal, not the success.** Every submission's demo works — a demo where everything succeeds proves nothing and is instantly forgettable. A demo where the product *catches* something is the only kind that demonstrates the product is real.

## Cut lines

If behind schedule, cut in this order. Each cut leaves a coherent product.

1. **Broker agent → roadmap slide.** Costly, and the audition mechanism carries the pitch without it.
2. **Live-position auditions → historical windows only.** Weakens conversion, keeps the mechanism.
3. **ERC-8183 escrow → x402 payment only.** Keeps hiring real, drops recourse. **Do not cut hiring itself** — "activate it" is inside the Functionality criterion.
4. **Second seed agent.** One good one beats two rushed ones.

**Degrade rather than cut:** the execution gate's full behavioural envelope → hard invariants only. The hard-invariant version still produces beat 2 of the demo, and is a few hundred lines on top of a working fork harness.

**Never cut:** the shadow engine, the verified-live filter, the two-column honest leaderboard, the revocable capped session key, and the execution gate in at least its minimum form. Those five *are* the submission — and the gate is the one no competing team can reproduce without having built the engine first.

## Prize alignment

One coherent product, four qualifying entries — most teams will enter one track.

| Track | How Bench qualifies | Extra work |
|---|---|---|
| **BNB Chain main** ($30k + adoption) | The marketplace itself: discovery, comparison, hiring, ERC-8004 identity + track records, x402 settlement | — |
| **TermiX** ($10k) | Audition reports *are* with/without-agent Advantage Reports, generated at scale | Formatting only |
| **Altana** (50k XP) | Checkout mints a capped, allowlisted, user-revocable EIP-7702 session key — **and the gate makes that key refuse behaviour the agent never demonstrated**, which is a use of session keys nobody else will show | Already in Phase 4 |
| **PancakeSwap** (1,000 CAKE) | LP range rebalancer + safe swap router as seed supply | Already in Phase 4 |
| **AltLayer** (8004scan Pro, AltLLM credits) | Bench indexes and credits 8004scan rather than competing with it | Ingest, Phase 1 |

## Risk register

| Risk | Mitigation |
|---|---|
| SDK breaking change mid-build | Pinned version + adapter interfaces (Phase 0) |
| Shadow egress bills real money | Hard per-run budget + outbound allowlist (Phase 2) |
| ERC-8183 mainnet not ready | Build on testnet; confirm judging target with organizers |
| Thin audition data at judging | Start backfill Sep 7; label sample size honestly rather than inflating |
| ~~Judging rubric unknown~~ | **Resolved 25 Aug.** Cost: `rebalancing` category added late, catalog rebalanced, hire pipeline promoted out of the cut list |
| ~~Mainnet or testnet unclear~~ | **Resolved 25 Aug — testnet is allowed**, Altana says "testnet counts, mainnet is stronger". Build target unchanged |
| A judge hires an agent and nothing happens | *"TermiX will hire from your marketplace and evaluate the results."* The hire path must work unattended for a stranger, and the seed agents must actually perform |
| Fixtures still served at judging | "Agents must be live on BSC" and "publicly accessible during judging" — point the indexer at the real registry before 9 Sep |
| Adoption terms unfavourable | Ask before building (memory.md §Open questions) |
