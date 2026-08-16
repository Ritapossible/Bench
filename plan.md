# Bench — Execution Plan

**Deadline: 9 September 2026.** Written 16 August 2026 → **24 days.**

Ordering principle: **ship the trust layer before the polish.** An ugly page ranking 40 verified-live agents by measured audition results beats a beautiful page listing 900 dead ones. Every phase below is ordered by demo-criticality, so that stopping at any point still leaves something coherent.

---

## Phase 0 — Foundations (Aug 16–17)

- [ ] Repo, CI, Postgres + Redis via docker-compose, Next.js + workers monorepo skeleton.
- [ ] **Adapter interfaces first**, before any SDK call: `WalletProvider`, `EscrowClient`, `PaymentClient`, `RegistryClient`. Pin `@bnbagent/sdk` to an exact version. A breaking SDK release must be a one-file fix.
- [ ] Anvil fork of BSC running locally, reproducible from a pinned block.
- [ ] **Send the organizer questions today** (memory.md §Open questions). The answers change what gets built; every day of delay is a day of possible rework.
- [ ] Pull the **actual scoring rubric** from the contest page. The blog defers it. Do not guess at weights that can simply be read.

## Phase 1 — Catalog with a pulse (Aug 18–22)

Goal: a page that is already more useful than a raw registry read.

- [ ] Indexer: ERC-8004 registry events → `agents`; resolve `tokenURI` → agent card → capabilities, endpoints, declared permissions.
- [ ] 8004scan cross-reference ingest (complement, credit them; do not rebuild the explorer).
- [ ] Prober: scheduled endpoint pings → reachability, p95 latency, A2A/MCP conformance.
- [ ] **"Verified live" filter working.** This alone makes the catalog ~25× denser in real agents.
- [ ] Agent cards + profile pages. Plain styling is fine at this stage.
- [ ] Onchain anchoring of the rolling probe hash.

**Exit test:** filter to verified-live and get a list of agents that all actually respond.

## Phase 2 — Shadow engine (Aug 23–30) ★ longest pole

Goal: the mechanism the whole product rests on.

- [ ] Fork harness: spin Anvil at a pinned block, seed a synthetic mirror of a target position, hand the agent an RPC + throwaway key. **The agent must believe it is live.**
- [ ] RPC interception: capture `eth_sendRawTransaction`, simulate against fork state, record intended action + decoded intent + state diff.
- [ ] **Egress budget guard + outbound allowlist.** A shadowed agent can still make real x402-paid calls. Without this, a hundred auditions bill real money. Not optional; build it with the harness, not after.
- [ ] Run orchestration: BullMQ queue, N agents on the same window in parallel, plus the do-nothing baseline.
- [ ] Determinism: persist fork block, seed, window with every run so any audition is independently replayable.
- [ ] Historical window library: one crash, one chop, one rally, for both wedge position types.

**Exit test:** three agents auditioned on the same historical PCS LP window, three different terminal states, all replayable from stored parameters.

## Phase 3 — Scoring, reports, leaderboard (Aug 31 – Sep 3)

- [ ] Per-category scorers: yield, grid/trading, monitoring (precision/recall/false-alarm), health factor (lead time before liquidation price touched).
- [ ] Deltas vs do-nothing and vs peer median.
- [ ] **Audition report** — the user-facing artifact, and TermiX's "Agent Advantage Report" delivered automatically rather than hand-built for three demo cases.
- [ ] Leaderboard with **two columns, simulated and realized, always labelled**, sample size and window shown next to every score.
- [ ] Side-by-side compare view (N agents, one window).
- [ ] Attestor: sign outcome records → ERC-8004 **Validation Registry** (not Reputation).

**Exit test:** open any agent profile and see a report that says what it would have done, against what baseline, over what window, with what sample size.

## Phase 4 — Hire pipeline + seed agents (Sep 4–6)

- [ ] x402 checkout, `permit2-upto` for metered agents.
- [ ] ERC-8183 escrow: fund → job → optimistic settle → dispute path.
- [ ] Altana EIP-7702 session key: spend cap + contract allowlist, minted at checkout.
- [ ] **Revoke control on the hire card**, plus the active-hire dashboard showing cap remaining.
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

Do not show a happy path. Show **three agents auditioning on the same live position side by side, one of them quietly losing money in simulation, and the user hiring the one that didn't** — then revoke it mid-job and watch the spend cap hold.

That is the thirty seconds a judge repeats to someone else, and it is precisely the thing the ERC-8004 research says nobody can currently do.

## Cut lines

If behind schedule, cut in this order. Each cut leaves a coherent product.

1. **Broker agent → roadmap slide.** Costly, and the audition mechanism carries the pitch without it.
2. **Live-position auditions → historical windows only.** Weakens conversion, keeps the mechanism.
3. **ERC-8183 escrow → x402 payment only.** Keeps hiring real, drops recourse.
4. **Second seed agent.** One good one beats two rushed ones.

**Never cut:** the shadow engine, the verified-live filter, the two-column honest leaderboard, the revocable capped session key. Those four *are* the submission.

## Prize alignment

One coherent product, four qualifying entries — most teams will enter one track.

| Track | How Bench qualifies | Extra work |
|---|---|---|
| **BNB Chain main** ($30k + adoption) | The marketplace itself: discovery, comparison, hiring, ERC-8004 identity + track records, x402 settlement | — |
| **TermiX** ($10k) | Audition reports *are* with/without-agent Advantage Reports, generated at scale | Formatting only |
| **Altana** (50k XP) | Checkout mints a capped, allowlisted, user-revocable EIP-7702 session key | Already in Phase 4 |
| **PancakeSwap** (1,000 CAKE) | LP range rebalancer + safe swap router as seed supply | Already in Phase 4 |
| **AltLayer** (8004scan Pro, AltLLM credits) | Bench indexes and credits 8004scan rather than competing with it | Ingest, Phase 1 |

## Risk register

| Risk | Mitigation |
|---|---|
| SDK breaking change mid-build | Pinned version + adapter interfaces (Phase 0) |
| Shadow egress bills real money | Hard per-run budget + outbound allowlist (Phase 2) |
| ERC-8183 mainnet not ready | Build on testnet; confirm judging target with organizers |
| Thin audition data at judging | Start backfill Sep 7; label sample size honestly rather than inflating |
| Judging rubric unknown | Pull the real rubric in Phase 0 and build to it |
| Adoption terms unfavourable | Ask before building (memory.md §Open questions) |
