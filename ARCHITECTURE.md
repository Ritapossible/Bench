# Bench — Project Overview & Architecture

> Status: design doc, pre-implementation. Written 16 Aug 2026. Revised 25 Aug 2026 —
> new §2.1, §3.2.1, §3.3.1, §3.8; amendments to §3.5, §3.6, §6, §8, §9.

---

## 1. The problem

BNB Chain launched **BNB Agent Studio** on 1 July 2026. It mints a deployable, wallet-owning, ERC-8004-registered onchain agent in about fifteen minutes. Supply is therefore not the constraint — and will be less of one every week.

The constraint is that **nobody hires any of them.**

Two measured failures block hiring today. From the empirical study of the live ERC-8004 ecosystem (arXiv 2606.26028, data through May 2026):

| Failure | Measurement on BSC |
|---|---|
| Agents are mostly not real | **~4%** of registered agents have a valid registration with a live service endpoint |
| Reputation is mostly fake | **~59%** of reviewers show coordinated Sybil behaviour; after removing them, **~78%** of rated agents have no valid feedback at all |

The study's conclusion is blunt: reputation values are not comparable across agents, feedback rarely links to a verifiable transaction, and manipulation costs almost nothing.

So the naive build — index the Identity and Reputation registries, render agent cards, sort by stars — produces *an empty directory full of dead agents ranked by noise*. It demos fine and collapses on the first curious click.

**And ranking alone would not be enough even if it worked.** BNB Chain's near-term ecosystem risk is not that users can't distinguish good agents from bad; it's that thousands of agents get deployed and none get hired. The official marketplace has to be a *demand engine*, not a leaderboard.

## 2. The mechanism

**Agents audition before they are hired.**

Every listed agent runs continuously in **shadow mode**: against replayed BSC history, and — once a user connects a wallet — against that user's *actual live position*, with no funds at risk and no ability to move them. Bench records every action the agent would have taken and the state it would have produced.

That single mechanism resolves all four problems at once:

- **Cold start.** Auditions cost compute, not users. Bench opens with thousands of agent-hours of track record and zero real hires required.
- **Attribution.** Same position, same window, N agents running in parallel plus a do-nothing baseline. That is a controlled comparison, not a noisy post-hoc delta — more rigorous than measuring realized outcomes over a handful of settled jobs, not less.
- **Category coverage.** Agents without P&L still have measurable behaviour (§5).
- **Conversion.** "This agent would have saved you $340 on your Venus position last month" is a reason to click Hire. A star rating is not.

Stated as what Bench makes *impossible*, which is the sharper form of the same claim:

> **Bench cannot list an agent that has never worked.**
> **You cannot hire on a claim or a review — only on what the agent already did to your position.**
> **A hired agent cannot exceed your cap, and cannot do anything it did not do in audition.**

The first two are properties of the catalog. The third is not, and it is the reason the shadow engine is worth more than a ranking input — see §2.1.

The leaderboard shows **two columns — simulated and realized — always labelled**, with realized converging on simulated as real hires settle. Bench never presents audition results as though they were realized returns.

### 2.1 The audition does not stop at hire ★

Ranking is half of what the shadow engine is good for.

A spend cap is a blunt instrument. It stops an agent spending $10,000 and does nothing about an agent doing something ruinous with $900. But the audition has *already established what this agent does to a position of this shape*. So keep it running, and put it in the signing path.

**Every transaction from a hired agent is auditioned before it is signed.** The intended transaction is simulated against a fork of current state; the resulting state diff is compared against the envelope that agent established in audition; if it falls outside, the session key does not sign and the transaction never reaches the chain.

Three properties follow:

- **Authority becomes behavioural, not merely numeric.** The cap answers *how much*. The gate answers *what kind of thing* — a strictly stronger bound, and one derived from measured evidence rather than guessed at by the user in a checkout form.
- **It reuses the engine rather than adding one.** The fork harness and RPC interception of §3.3 are the same machinery, pointed at live traffic instead of a replayed window.
- **Refusals are legible.** A blocked transaction is a record, surfaced on the hire card with the rule that fired and the state diff that would have resulted. The user sees what didn't happen.

**Minimum viable form,** if envelope derivation runs late: simulate every transaction and block on a small set of hard invariants — position value falling further than a declared bound, funds moving to an address absent from the audition, a contract call the agent never made while auditioning. The full behavioural envelope is a refinement of that, not a prerequisite for it.

## 3. System architecture

```
                            ┌──────────────────────────────────────┐
   BSC (mainnet + testnet)  │  ERC-8004 Identity / Reputation /    │
                            │  Validation registries               │
                            │  ERC-8183 AgenticCommerce escrow     │
                            │  PancakeSwap · Venus · x402          │
                            └───────┬──────────────────▲───────────┘
                                    │ read             │ write
              ┌─────────────────────┴──────┐    ┌──────┴──────────────┐
              │  INDEXER                   │    │  ATTESTOR           │
              │  registry events → agents  │    │  signs outcome      │
              │  tokenURI → agent card     │    │  records → Validation
              │  8004scan cross-reference  │    │  Registry           │
              └─────────────┬──────────────┘    └──────▲──────────────┘
                            │                          │
              ┌─────────────▼──────────────┐    ┌──────┴──────────────┐
              │  PROBER                    │    │  SCORER             │
              │  endpoint liveness         │    │  per-category       │
              │  uptime · p95 · conformance│    │  scoring + ranking  │
              └─────────────┬──────────────┘    └──────▲──────────────┘
                            │                          │
                            │   ┌──────────────────────┴───────────┐
                            └──▶│  SHADOW ENGINE          ★ core   │
                                │  forked-state RPC per run        │
                                │  tx interception & state diff    │
                                │  egress budget guard             │
                                └──────────────┬───────────────────┘
                                               │ audition records
   ┌───────────────────────────────────────────▼────────────────────────┐
   │  BENCH APP (Next.js)                                               │
   │  discovery · audition reports · side-by-side compare               │
   │  paste-an-address report (no wallet) · public registry health      │
   │  checkout · active-hire dashboard with revoke + blocked-tx log     │
   └───────────────┬──────────────────────────────────┬─────────────────┘
                   │                                  │
       ┌───────────▼────────────┐        ┌────────────▼─────────────────┐
       │  HIRE PIPELINE         │        │  BROKER AGENT                │
       │  x402 (permit2-upto)   │        │  Bench, registered under     │
       │  ERC-8183 escrow       │        │  ERC-8004 as a broker:       │
       │  Altana EIP-7702       │        │  intent → agent team →       │
       │  session key + cap     │        │  one escrow, one session key │
       │  + revoke              │        └──────────────────────────────┘
       │  shadow gate per tx ★  │
       └────────────────────────┘
```

### 3.1 Indexer

Consumes ERC-8004 registry events on BSC, resolves each Identity NFT's `tokenURI` to its agent card, and normalizes capability declarations, declared permissions, and A2A/MCP/OASF endpoints into Postgres. Cross-references AltLayer's **8004scan** as a supplementary source rather than competing with it — 8004scan is an explorer and its sponsor is a judge; Bench indexes it and credits it.

### 3.2 Prober

Pings every declared endpoint on a schedule, recording reachability, p95 latency, and protocol conformance (does it actually speak A2A/MCP, or just claim to). Powers the **"verified live"** filter — the cheapest possible fix for the 96%-dead-agent problem, and on its own it makes the catalog roughly 25× denser in real agents than a raw registry read.

A rolling hash of probe results is anchored onchain periodically so the liveness record is auditable rather than a claim Bench makes about itself.

#### 3.2.1 Registry health dashboard (public)

The indexer and prober together measure, continuously, what arXiv 2606.26028 measured once through May 2026. Publish that as a free public dashboard: the live share of BSC-registered agents with a resolvable card, a reachable endpoint, and a conforming protocol — recomputed daily and plotted against the study's baseline.

It costs nothing beyond what §3.1 and §3.2 already produce. It is useful to the ecosystem whether or not a single agent is ever hired through Bench. And it is the cheapest available proof that this pipeline runs against the real registry rather than against a fixture: **the paper measured the problem once; Bench measures it every day.**

### 3.3 Shadow Engine ★

The core, and the longest pole in the build.

**Do not require agents to implement a `dry_run` interface.** Almost none will. Instead:

1. Spin a forked-state BSC node (Anvil) pinned at a block, seeded with a synthetic copy of the target position — either a historical window or a mirror of the connected user's live position.
2. Hand the agent an RPC endpoint pointing at the fork and a throwaway key controlling the mirrored position. **The agent believes it is live.**
3. Intercept at the RPC layer: capture every `eth_sendRawTransaction`, simulate it against fork state, record the intended action and the resulting state diff.
4. On window close, diff terminal state against the do-nothing baseline and against every peer agent auditioning on the same window.

**Egress budget guard (required, easy to forget):** a shadowed agent may still make *real* outbound calls — x402-paid data feeds especially — that cost actual money. Every shadow run gets a hard egress budget and an outbound allowlist. Without this, running a hundred auditions can bill you for real.

Determinism: fork block, seed, and window are recorded with every run so any audition can be replayed and independently verified. This is what makes the record credible rather than a number Bench asserts.

#### 3.3.1 Replay is a command, not a claim

"Anyone can rerun an audition and check our arithmetic" is worth nothing as a sentence in a document. Ship it as one command:

```
npx bench-replay <auditionId>
```

It reads the stored fork block, seed and window, re-runs the audition, prints the terminal state, and reports whether it matches what Bench published. The determinism record in `shadow_runs` already carries everything it needs; this is a wrapper, not new capability.

A reviewer who runs one command and gets Bench's number back has verified the central claim of the product without reading a line of its source.

### 3.4 Scorer

Per-category scoring (§5), producing both an absolute score and a delta versus the do-nothing baseline and the peer median. Explicitly reports sample size and window; a score computed over a thin window is labelled as such rather than presented as fact.

### 3.5 Attestor

Signs outcome records and writes them to the ERC-8004 **Validation Registry** — deliberately *not* the Reputation Registry. Validation carries verifiable semantics and hooks for independent validators; reputation carries unweighted attestations that the research shows are trivially gamed. Bench's output belongs in the registry that can be checked.

Writing there also makes the output **readable by explorers**: 8004scan can surface Bench scores with no integration work on Bench's side beyond the registry write itself. Ask AltLayer to display them. Bench already indexes and credits 8004scan (§3.1); scores flowing back the other way makes that relationship reciprocal rather than extractive, and puts Bench's rankings in front of the ecosystem's existing audience instead of only its own.

### 3.6 Hire pipeline

On Hire:

- **Payment** via Binance x402. Use `permit2-upto` for metered agents so usage streams against a ceiling rather than requiring a fixed prepay. Supported BSC stablecoins: U, USDT, USD1, USDC.
- **Escrow** via ERC-8183 (`AgenticCommerce` kernel + `EvaluatorRouter` + `OptimisticPolicy`). Optimistic settlement: silence past the dispute window is approval; the client can dispute within it.
- **Authority** via an Altana EIP-7702 **session key** scoped to a spend cap and a contract allowlist, with a revoke control on the hire card. `AltanaWalletProvider` ships in the BNBAgent SDK (TypeScript only — see §7).
- **Execution gate** (§2.1): every transaction the hired agent produces is simulated and checked against its audition envelope before the session key will sign it. Cap, allowlist and gate are three independent bounds and a transaction must clear all three. Blocked transactions are logged to the hire card with the rule that fired.

### 3.7 Broker agent

Bench registers *itself* under ERC-8004 as a broker agent. A user states an intent in natural language — *"$5k in a PCS LP that keeps going out of range, and I'm close to liquidation on Venus"* — and Bench decomposes it, selects a **team** from the audition rankings, and returns one escrow and one capped session key covering all of them.

Browsing a directory is the app-store model. The forward answer is that you don't browse, you delegate. A marketplace for agents that is itself an agent — earning via x402, rankable by its own metric — is both the better UX and the honest answer to "where does this go."

### 3.8 Audition reports without a wallet

The conversion moment — *"this agent would have saved you $340 on your Venus position last month"* — is the most valuable screen in the product. Gating it behind a wallet connection puts the highest-friction step directly in front of the highest-value one.

It does not need a signature. The position is public state and the audition is a simulation, so **any BSC address pasted into the box produces the report.** A wallet is required to *hire*, not to be shown what hiring would have been worth.

This also makes the artifact shareable — a link, a screenshot, a report on a well-known address — rather than something each viewer must first authenticate to see. The best marketing asset the product has is the one it currently hides behind a connect button.

## 4. Data model (sketch)

| Table | Holds |
|---|---|
| `agents` | ERC-8004 token id, owner, chain, category, card URI, declared capabilities |
| `agent_endpoints` | protocol (A2A/MCP/OASF), URL, last conformance result |
| `probe_results` | timestamp, reachable, latency_ms, conformance, anchored_hash |
| `shadow_runs` | agent_id, fork_block, window_start/end, position_template, seed, egress_spent |
| `shadow_actions` | run_id, intended tx, decoded intent, simulated state diff |
| `outcome_records` | run_id, terminal state, delta_vs_donothing, delta_vs_peer_median |
| `scores` | agent_id, category, window, score, sample_size, simulated \| realized |
| `hires` | user, agent_id, escrow_id, session_key_id, status |
| `session_keys` | address, spend_cap, allowlist, spent, revoked_at |
| `envelopes` | agent_id, category, derived_from_run_ids, bounds (value delta, address set, call set) |
| `gate_decisions` | hire_id, intended tx, simulated diff, allowed \| blocked, rule_fired, at |
| `attestations` | outcome_record_id, tx_hash, validation_registry_entry |

## 5. Scoring by category

The reason shadow mode beats realized-outcome ranking is that it scores the whole catalog, not just the half with a P&L.

**The first four are the categories the main track scores.** The contest requires the marketplace to surface rebalancing, grid trading, yield optimization and health-factor monitoring *with equal depth*, and Agent Diversity is one of only three stated criteria — so these are peers in the data model and in the catalog UI, not a wedge plus an afterthought.

| Category | Primitive | Baseline |
|---|---|---|
| **Rebalancing** | time in range; fees earned net of rebalance cost | do-nothing; peer median |
| **Grid / trading** | realized PnL, max drawdown, fill quality vs mid | do-nothing; peer median |
| **Yield** | risk-adjusted return on mirrored capital | do-nothing; peer median |
| **Monitoring** | precision / recall on events, false-alarm rate | naive threshold alerter |
| **Health factor** | lead time before liquidation price is touched | no-alert; naive HF threshold |

Every score reports its window and sample size alongside the number. An agent with three days of audition data is shown as an agent with three days of audition data.

## 6. Trust model

1. **Feedback is payment-gated.** A review counts only if bound to a settled escrow job of nonzero value, weighted by payment size and by the payer's own settled history. This makes Sybil review farming cost real money and scale sub-linearly with the payoff — the direct answer to the 59% figure.
2. **Auditions are replayable, by command.** Fork block, seed and window are published with every record, and `npx bench-replay <auditionId>` (§3.3.1) re-runs one and checks Bench's arithmetic for you.
3. **Liveness is anchored, not asserted.**
4. **Simulated and realized never merge.** Two columns, always labelled.
5. **Authority is bounded three ways.** Spend cap, contract allowlist, and the execution gate (§2.1). The first two are declared by the user at checkout; the third is *derived from what the agent actually did in audition*, which is the only one of the three the user could not have specified themselves.
6. **Registry health is published, not just used.** §3.2.1 exposes the measurement Bench's own ranking depends on, so the input to the product is auditable alongside its output.

## 7. Stack and known hazards

**Stack:** TypeScript throughout · Next.js (app router) · Node workers · Postgres + Drizzle · Redis/BullMQ for the audition queue · Foundry/Anvil for forked state · viem · `@bnbagent/sdk` (pinned).

**Hazards to design around from day one:**

- **BNBAgent SDK is explicitly "under active development, may introduce breaking changes."** Pin the exact version. Put every SDK touchpoint behind a thin adapter interface so a breaking release is a one-file fix, not a rewrite three days before submission.
- **`AltanaWalletProvider` (EIP-7702 session keys) is TypeScript-only.** This is why the stack is TS, not Python.
- **ERC-8183 mainnet is pending; the SDK is live on testnet.** Build and demo on testnet — **confirmed acceptable**: the contest sets no network requirement beyond "live on BSC", and Altana states outright that *"testnet counts, mainnet is stronger."* Testnet removes the funding problem; it does not remove the requirement that the deployment be publicly accessible and carrying real indexed agents throughout judging.
- **Registration is gas-free on BSC testnet** via MegaFuel paymaster sponsorship — use it.
- **Shadow egress costs real money.** See §3.3.

## 8. Scope discipline

> **Corrected 25 Aug 2026, against the published rubric.** This section previously read
> *"breadth is the roadmap slide; depth is what gets shown."* That is wrong for this
> contest. **Agent Diversity is one of three main-track criteria**, and the requirement is
> that the marketplace surface all four judged categories *with equal depth*. Concentrating
> on two and treating the rest as roadmap forfeits a third of the main-track score.

The four judged categories — **rebalancing, grid trading, yield optimization, health-factor
monitoring** — are surfaced as peers, with comparable agent counts, comparable audition
depth, and their own scoring primitives (§5).

**Depth still has to come from somewhere**, and the honest answer is that the *position
kinds* are where it concentrates: PancakeSwap LP and Venus health factor have real users,
real capital and clean measurable counterfactuals. Rebalancing and yield agents audition
against the LP position; health-factor agents against the Venus loan; grid agents against a
spot ladder. That gives four categories genuine coverage off two seeded position kinds,
rather than four shallow ones or two deep ones.

Two seed agents ship on the wedge: an **LP range rebalancer** and a **safe swap router**
(slippage / MEV / honeypot guarded).

**Sequencing under schedule pressure.** §2.1 is the strongest claim in this document and it rests entirely on §3.3 existing. Build the audition path first and get one run replayable end to end; the gate is a short addition on top of a working fork harness and a long detour without one. By contrast **§3.2.1 and §3.8 depend only on the indexer and prober, which already work** — they should ship regardless of how §3.3 lands, and shipping them early puts something live and verifiable on the internet while the engine is still being built.

## 9. Roadmap beyond the hackathon

Both of these require the audition dataset that v1 generates as a by-product, which is exactly the point — **v1 runs the auditions, and the audition data is the moat.**

- **Allocator.** Hire a *basket* rather than a single agent: capital split across top-ranked agents by mandate, rebalanced toward performers, underperformers dropped. Agent index funds; performance-fee vaults.
- **Underwriting.** Agents post bonds; Bench sells hire-with-guarantee priced off track record; validated failure slashes the bond. The execution gate (§2.1) is what makes this priceable: an agent that has never been blocked has a measurably different risk profile from one that has, and `gate_decisions` is the loss history an underwriter would otherwise have to wait years to accumulate.

## Sources

- [The Smart Money Era: Build the Era — official contest page](https://www.bnbchain.org/en/hackathons/smart-money-era) (rubric, tracks, requirements)
- [Can Trustless Agents Be Trusted? — arXiv 2606.26028](https://arxiv.org/abs/2606.26028)
- [BNBAgent SDK](https://github.com/bnb-chain/bnbagent-sdk) · [ERC-8183 announcement](https://www.bnbchain.org/en/blog/bnbagent-sdk-the-first-live-erc-8183-implementation-for-onchain-ai-agents)
- [erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts) · [8004scan docs](https://docs.altlayer.io/altlayer-documentation/8004-scan/overview)
- [Binance x402](https://blockonomi.com/binance-x402-launches-http-native-programmable-payments-for-ai-agents-on-bnb-chain/) · [BNB Agent Studio launch](https://cryptobriefing.com/bnb-chain-agent-studio-launch/)
