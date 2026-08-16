# Bench — Project Overview & Architecture

> Status: design doc, pre-implementation. Written 16 Aug 2026.

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

The leaderboard shows **two columns — simulated and realized — always labelled**, with realized converging on simulated as real hires settle. Bench never presents audition results as though they were realized returns.

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
   │  checkout · active-hire dashboard with revoke                      │
   └───────────────┬──────────────────────────────────┬─────────────────┘
                   │                                  │
       ┌───────────▼────────────┐        ┌────────────▼─────────────────┐
       │  HIRE PIPELINE         │        │  BROKER AGENT                │
       │  x402 (permit2-upto)   │        │  Bench, registered under     │
       │  ERC-8183 escrow       │        │  ERC-8004 as a broker:       │
       │  Altana EIP-7702       │        │  intent → agent team →       │
       │  session key + cap     │        │  one escrow, one session key │
       │  + revoke              │        └──────────────────────────────┘
       └────────────────────────┘
```

### 3.1 Indexer

Consumes ERC-8004 registry events on BSC, resolves each Identity NFT's `tokenURI` to its agent card, and normalizes capability declarations, declared permissions, and A2A/MCP/OASF endpoints into Postgres. Cross-references AltLayer's **8004scan** as a supplementary source rather than competing with it — 8004scan is an explorer and its sponsor is a judge; Bench indexes it and credits it.

### 3.2 Prober

Pings every declared endpoint on a schedule, recording reachability, p95 latency, and protocol conformance (does it actually speak A2A/MCP, or just claim to). Powers the **"verified live"** filter — the cheapest possible fix for the 96%-dead-agent problem, and on its own it makes the catalog roughly 25× denser in real agents than a raw registry read.

A rolling hash of probe results is anchored onchain periodically so the liveness record is auditable rather than a claim Bench makes about itself.

### 3.3 Shadow Engine ★

The core, and the longest pole in the build.

**Do not require agents to implement a `dry_run` interface.** Almost none will. Instead:

1. Spin a forked-state BSC node (Anvil) pinned at a block, seeded with a synthetic copy of the target position — either a historical window or a mirror of the connected user's live position.
2. Hand the agent an RPC endpoint pointing at the fork and a throwaway key controlling the mirrored position. **The agent believes it is live.**
3. Intercept at the RPC layer: capture every `eth_sendRawTransaction`, simulate it against fork state, record the intended action and the resulting state diff.
4. On window close, diff terminal state against the do-nothing baseline and against every peer agent auditioning on the same window.

**Egress budget guard (required, easy to forget):** a shadowed agent may still make *real* outbound calls — x402-paid data feeds especially — that cost actual money. Every shadow run gets a hard egress budget and an outbound allowlist. Without this, running a hundred auditions can bill you for real.

Determinism: fork block, seed, and window are recorded with every run so any audition can be replayed and independently verified. This is what makes the record credible rather than a number Bench asserts.

### 3.4 Scorer

Per-category scoring (§5), producing both an absolute score and a delta versus the do-nothing baseline and the peer median. Explicitly reports sample size and window; a score computed over a thin window is labelled as such rather than presented as fact.

### 3.5 Attestor

Signs outcome records and writes them to the ERC-8004 **Validation Registry** — deliberately *not* the Reputation Registry. Validation carries verifiable semantics and hooks for independent validators; reputation carries unweighted attestations that the research shows are trivially gamed. Bench's output belongs in the registry that can be checked.

### 3.6 Hire pipeline

On Hire:

- **Payment** via Binance x402. Use `permit2-upto` for metered agents so usage streams against a ceiling rather than requiring a fixed prepay. Supported BSC stablecoins: U, USDT, USD1, USDC.
- **Escrow** via ERC-8183 (`AgenticCommerce` kernel + `EvaluatorRouter` + `OptimisticPolicy`). Optimistic settlement: silence past the dispute window is approval; the client can dispute within it.
- **Authority** via an Altana EIP-7702 **session key** scoped to a spend cap and a contract allowlist, with a revoke control on the hire card. `AltanaWalletProvider` ships in the BNBAgent SDK (TypeScript only — see §7).

### 3.7 Broker agent

Bench registers *itself* under ERC-8004 as a broker agent. A user states an intent in natural language — *"$5k in a PCS LP that keeps going out of range, and I'm close to liquidation on Venus"* — and Bench decomposes it, selects a **team** from the audition rankings, and returns one escrow and one capped session key covering all of them.

Browsing a directory is the app-store model. The forward answer is that you don't browse, you delegate. A marketplace for agents that is itself an agent — earning via x402, rankable by its own metric — is both the better UX and the honest answer to "where does this go."

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
| `attestations` | outcome_record_id, tx_hash, validation_registry_entry |

## 5. Scoring by category

The reason shadow mode beats realized-outcome ranking is that it scores the whole catalog, not just the half with a P&L.

| Category | Primitive | Baseline |
|---|---|---|
| **Yield** | risk-adjusted return on mirrored capital | do-nothing; peer median |
| **Grid / trading** | realized PnL, max drawdown, fill quality vs mid | do-nothing; peer median |
| **Monitoring** | precision / recall on events, false-alarm rate | naive threshold alerter |
| **Health factor** | lead time before liquidation price is touched | no-alert; naive HF threshold |

Every score reports its window and sample size alongside the number. An agent with three days of audition data is shown as an agent with three days of audition data.

## 6. Trust model

1. **Feedback is payment-gated.** A review counts only if bound to a settled escrow job of nonzero value, weighted by payment size and by the payer's own settled history. This makes Sybil review farming cost real money and scale sub-linearly with the payoff — the direct answer to the 59% figure.
2. **Auditions are replayable.** Fork block, seed, and window are published with every record; anyone can rerun an audition and check Bench's arithmetic.
3. **Liveness is anchored, not asserted.**
4. **Simulated and realized never merge.** Two columns, always labelled.

## 7. Stack and known hazards

**Stack:** TypeScript throughout · Next.js (app router) · Node workers · Postgres + Drizzle · Redis/BullMQ for the audition queue · Foundry/Anvil for forked state · viem · `@bnbagent/sdk` (pinned).

**Hazards to design around from day one:**

- **BNBAgent SDK is explicitly "under active development, may introduce breaking changes."** Pin the exact version. Put every SDK touchpoint behind a thin adapter interface so a breaking release is a one-file fix, not a rewrite three days before submission.
- **`AltanaWalletProvider` (EIP-7702 session keys) is TypeScript-only.** This is why the stack is TS, not Python.
- **ERC-8183 mainnet is pending; the SDK is live on testnet.** Build and demo on testnet; confirm the judging target with the organizers (see memory.md open questions).
- **Registration is gas-free on BSC testnet** via MegaFuel paymaster sponsorship — use it.
- **Shadow egress costs real money.** See §3.3.

## 8. Scope discipline

The wedge for the hackathon build is **PancakeSwap LP positions and Venus health factor**. Both have real users with real capital, clean measurable counterfactuals, and a live partner track. Two seed agents ship there: an **LP range rebalancer** and a **safe swap router** (slippage / MEV / honeypot guarded).

Other categories are indexed, probed, and auditioned, but are not the demo. Breadth is the roadmap slide; depth is what gets shown.

## 9. Roadmap beyond the hackathon

Both of these require the audition dataset that v1 generates as a by-product, which is exactly the point — **v1 runs the auditions, and the audition data is the moat.**

- **Allocator.** Hire a *basket* rather than a single agent: capital split across top-ranked agents by mandate, rebalanced toward performers, underperformers dropped. Agent index funds; performance-fee vaults.
- **Underwriting.** Agents post bonds; Bench sells hire-with-guarantee priced off track record; validated failure slashes the bond.

## Sources

- [BNB Chain — Build the Era hackathon](https://www.bnbchain.org/en/blog/build-the-era-build-the-official-bnb-agent-studio-marketplace)
- [Can Trustless Agents Be Trusted? — arXiv 2606.26028](https://arxiv.org/abs/2606.26028)
- [BNBAgent SDK](https://github.com/bnb-chain/bnbagent-sdk) · [ERC-8183 announcement](https://www.bnbchain.org/en/blog/bnbagent-sdk-the-first-live-erc-8183-implementation-for-onchain-ai-agents)
- [erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts) · [8004scan docs](https://docs.altlayer.io/altlayer-documentation/8004-scan/overview)
- [Binance x402](https://blockonomi.com/binance-x402-launches-http-native-programmable-payments-for-ai-agents-on-bnb-chain/) · [BNB Agent Studio launch](https://cryptobriefing.com/bnb-chain-agent-studio-launch/)
