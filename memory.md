# Bench — Working Memory

Persistent context for anyone (human or agent) picking this project up mid-flight. Keep it current; it is the file to read first.

**Last updated:** 27 Aug 2026 (persistence landed; the app serves Postgres, not fixtures)

---

## What Bench is, in one sentence

An AI agent marketplace on BNB Smart Chain where agents **audition on your real position before you pay** — Bench runs every listed agent in shadow mode against replayed history and the user's live position, ranks on what they would have done, then hires the winners under a revocable spend cap.

## Why it exists

Built for **The Smart Money Era: Build the Era** — https://www.bnbchain.org/en/hackathons/smart-money-era. Main track pays $30,000 plus adoption as the official BNB Agent Studio marketplace.

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
| **No Connect Wallet in the header** | Nothing before hiring needs a signature (§3.8), so a permanent wallet CTA is a prominent button that goes nowhere — and it argues against the product's own strongest claim, which is *"no wallet needed, paste any address."* The header CTA is **Read your report**. Wallet connection belongs in the Phase 4 hire flow, at the point it is actually required. |
| **Don't require agents to support `dry_run`** | Nobody implements it. Intercept at the RPC layer against a forked node instead — the agent believes it is live. |

## Open questions — ask the organizers, unanswered as of 16 Aug

Answers change what gets built. Asking also signals a serious counterparty.

1. What does "officially adopted as a standalone product" mean contractually — IP assignment, licence, maintenance obligation, ongoing funding?
2. What licence is required for submissions?
3. ~~Is the full scoring rubric published?~~ **ANSWERED 25 Aug — pulled from the contest page. See §The rubric below. It changed the scope.**
4. ~~Mainnet or testnet for judging, given ERC-8183 mainnet is pending?~~ **ANSWERED 25 Aug — testnet is allowed.** Main track: *"Agents surfaced on your marketplace must be live on BSC"* with no network qualifier, alongside *"your submission must be functional and publicly accessible during judging."* Altana is explicit: *"Testnet counts, mainnet is stronger."* So the testnet plan stands, which is fortunate — ERC-8183 mainnet is pending regardless. **Testnet removes the funding and risk problem; it does not remove the liveness problem.** A judge opening the deployment between 9 and 23 Sep must find real indexed BSC agents, not fixtures.

## The rubric — pulled 25 Aug 2026, verbatim where quoted

**This should have been read on day one.** It contradicted a locked decision; see the
correction in ARCHITECTURE.md §8.

### Main track — Build the BNB Agent Studio Marketplace ($30,000 + adoption)

Three criteria. Weights are not published.

| Criterion | Published wording |
|---|---|
| **Functionality** | *"The full journey works end to end: land, find an agent by category, understand what it does, activate it, with minimal friction."* |
| **Data Quality** | *"Real-time, accurate data that goes beyond basic counts."* |
| **Agent Diversity** | Must surface all four categories equally: **rebalancing, grid trading, yield optimization, health factor monitoring**. |

Hard requirements:

- surface agents across the four categories **with equal depth**
- **functional and publicly accessible during judging**
- **agents must be live on BSC**
- one entry per team; open globally

**What this changes, and it is not small:**

1. **Agent Diversity is a third of the stated criteria**, and §8 previously said breadth was
   a roadmap slide. Corrected: the four categories are peers in the type system, the
   catalog and the scoring table. `rebalancing` did not exist as a category and now does.
2. **"activate it" sits inside criterion one.** The hire pipeline is not a Phase 4 nicety —
   it is part of the journey Functionality scores. It cannot be cut to the roadmap.
3. **"agents must be live on BSC" plus "publicly accessible during judging"** means fixtures
   do not survive judging. The indexer has to be pointed at the real registry, and the
   deployment has to stay up 9–23 Sep.
4. **"data that goes beyond basic counts"** is an argument for the registry-health
   dashboard and for audition deltas — both already built — over an agent-count leaderboard.

### TermiX Challenge ($6,000 / $3,000 / $1,000) — the only published weights

| Weight | Criterion |
|---|---|
| 30% | **Value of Services** — *"real working agents at a price and speed that beat the alternative. TermiX will hire from your marketplace and evaluate the results."* |
| 30% | **Proven Agent Advantage** — measured results, backed by a required Agent Advantage Report |
| 20% | **High-Stakes Categories & Track Record** — trading and security agents prioritised |
| 20% | **Marketplace Quality** — *"find, compare, hire, without instructions"* |

**Required deliverable:** an Agent Advantage Report covering **at least three real tasks**
comparing agent vs non-agent on **time, cost and output quality**, with **at least one from
trading, stock or security**. Bench's audition reports are this, generated rather than
hand-built — but the three-task-with-one-trading shape is a specific submission artifact
that has to be produced deliberately.

### ⚠️ The most operationally demanding sentence on the whole page

> *"TermiX will hire from your marketplace and evaluate the results."*

A judge is going to click **Hire** and expect an agent to do a job. That is not a demo
video, it is a stranger driving the hire path unattended, on infrastructure that has to be
up. Combined with *"land, find an agent by category, understand what it does, **activate
it**"* in the main-track Functionality criterion, the conclusion is the same from two
directions: **the hire pipeline is load-bearing, and a working checkout is worth more than
another scoring refinement.**

It also means the seed agents must actually perform. An agent that ranks well and then does
nothing when hired is worse than not listing it.

### Altana (50,000 XP, winner takes all) — concrete and not yet met

- live onchain transactions visible in the Altana explorer (testnet or mainnet)
- agents on **their own Altana wallets** with **real session limits**
- sessions **registered in Keystore**
- **user-facing revocation controls**

The revocation control is designed (§3.6) and the session key is on the plan; the Keystore
registration and per-agent Altana wallets are not, and are a Phase 4 requirement rather than
a nice-to-have if this track is being entered.

### PancakeSwap (1,000 CAKE)

Agent must *"deliver a real benefit to PancakeSwap traders or liquidity providers."*

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

Main track **$30,000 + adoption**. Partner tracks: TermiX **$6k / $3k / $1k**, PancakeSwap
**1,000 CAKE**, Altana **50,000 XP** (winner takes all), AltLayer 8004scan Pro + AltLLM
credits. One coherent build qualifies across them; most teams will enter one.

Multi-track submission is **not addressed** on the contest page, and the main track says
"one entry per team". Worth confirming with the organisers before relying on the
five-track plan in plan.md.

## Traps already identified — do not relearn these

- **The obvious build loses.** Registry read + agent cards + star sort = an empty directory of dead agents ranked by noise. Twenty teams will ship it.
- **Ranking rigor alone loses too.** BNB Chain's real problem is that deployed agents never get hired. The marketplace must be a demand engine, not a leaderboard.
- **Don't overclaim statistical rigor.** Risk-adjusted delta over a dozen settled jobs is meaningless, and TermiX judges trade for a living. Shadow mode exists partly because it produces defensible sample sizes; report window and n next to every score anyway.
- **Shadow runs can spend real money** via outbound x402 data calls. Hard egress budget per run, plus an outbound allowlist. *(Enforced 27 Aug. It was written on 25 Aug and not called for two days - writing a control and wiring it are separate jobs, and only the second one protects anything.)*
- **Don't build another explorer.** 8004scan is that, and its sponsor is judging.

## Hire pipeline — built 25 Aug, from the vault's P12

The idea vault's strongest pattern (seven projects, three ecosystems) says agent
authority is *the* problem of this era, and ranks enforcement mechanisms by strength.
Bench sits on the **signed-mandate-plus-public-trace** rung — the one PolyDesk won with,
and the one the vault flags as under-explored because it needs no special hardware.

Built accordingly, and deliberately not as a demo path:

- **Mandate** (`core/types/mandate.ts`) — canonically encoded, length-delimited so no
  field containing a separator can encode as a different mandate under the same
  signature. Bounds: total cap, per-tx cap, allowlist, expiry, action limit.
- **Enforcement layering** (ARCHITECTURE §3.6.1) — each rule at the layer that can hold
  it. A cap enforced only in the client is a cap the client can be talked out of.
- **Decision trace** — hash-chained, so editing any entry invalidates the tail.
  `verifyTrace` returns the index of the first tampered entry.
- **Consent checklist** — ordered, refuses to skip ahead. A single "I agree" means
  nothing; the summary step stops anyone confirming bounds they never saw together.
- **Envelope snapshotted at hire time**, not re-derived. Otherwise an agent could widen
  its own bound by auditioning differently after being hired.
- **Idempotent by request key**, including for failed hires — retrying a charge is the
  client's decision with a new key, never something to do silently.

**Still stubs:** `X402PaymentClient` and `Erc8183EscrowClient`. The lifecycle around them
is driven and tested; the chain calls are not written. That plus per-agent Altana wallets
and Keystore registration is what remains of Phase 4.

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

  **Execution gate (§2.1) landed early, ahead of Phase 4.** The plan said to build it as soon as Phase 2 worked, and Phase 2 works. `deriveEnvelope` / `checkAgainstEnvelope` are pure and live in `@bench/core` alongside `isVerifiedLive`, so there is one definition of "in policy". `startGatedSession` puts them in the transport path — the *same interceptor* as an audition, which is the whole argument: the bound is derived from behaviour that machinery observed, not guessed at in a checkout form. Six rules with tolerance over observed maxima; envelopes under three auditions are advisory rather than enforced. `npm run gate:demo` runs the demo's beat 2 and proves the refusal from chain state.

  **Design note worth keeping:** the agent gets a plain `transaction rejected` JSON-RPC error. It learns that it failed, not why — the reasoning is Bench's and is shown to the owner. Handing an agent the rule it tripped is handing it the map around the fence.

  **Frontend.** Five routes live, monochrome design system, colour reserved for state. All data behind the `BenchData` interface in `apps/web/src/lib/data` — fixtures today, one file to swap. Wallet deliberately unwired: nothing before hiring needs a signature. `vercel.json` + `npm run build:web` deploy with Root Directory left at `.`.

- **27 Aug 2026 - persistence, and five controls that were reported as enforced but were not.**

  The two things standing between this and a production system were that hires lived in
  process memory and the web app read fixtures. Both are closed. What made the day worth
  writing down is what fell out of closing them: **every gap found was a control the code
  claimed to apply and did not.** They are worth listing as a class, because the same
  mistake will be available again in Phase 4.

  1. **The envelope's cumulative bounds could never fire.** `authorizeAction` took the
     agent's spending history as a parameter and every call site passed zero, so each
     action claimed to be the agent's first. Both bounds now read persisted mandate state.
     A bound evaluated against numbers the caller supplies is not a bound; it is a report
     that one was checked.
  2. **The consent checklist was decorative.** The checkout server action built the consent
     list itself, always complete, so `consentComplete` could not fail. A user who skipped
     all five confirmations got the same hire as one who read them. The client now submits
     what it actually recorded.
  3. **The egress guard was never called.** Declared as a dependency of `AuditionRunner`
     and unused, so a shadowed agent had unmetered network access - the thing the guard
     exists to prevent, and flagged in this file since 25 Aug. The agent now receives its
     network through the runner rather than finding it, scoped per run. A missing guard
     denies the network rather than granting it.
  4. **The fixtures overclaimed liveness.** The fixture clock was frozen at 25 Aug, so its
     probes were days old, and "verified live" means probed within six hours. The fixture
     path hid it by passing the same frozen clock into `isVerifiedLive`; the Postgres path
     could not, and reported zero live agents where the page reported twelve. Overclaiming
     liveness is the exact failure this project exists to correct.
  5. **The integration tests were not running in CI**, so they reported as passing by
     skipping - and `fmt:check` had been red repo-wide for weeks, so the pipeline was
     failing regardless of any commit.

  **Persistence.** `PgHireStore` and `PgAuditionStore` against checked-in migrations, run
  by the migrator under an advisory lock rather than `drizzle-kit push`. Hire idempotency
  is a UNIQUE index and `INSERT ... ON CONFLICT DO NOTHING`, because read-then-write dedupe
  is a TOCTOU race that charges twice - tested with twelve writers racing one key. Traces
  are verified on read, so editing the row they live in is detectable.

  **The app serves Postgres** when `DATABASE_URL` is set and fixtures otherwise, decided
  once at boot and warned about loudly in production. `npm run db:seed` writes a known
  catalog through the indexer's own repository, so a deployment has real rows before the
  registry address lands - and it cross-checks the verified-live SQL against
  `isVerifiedLive`, which was the duplication guarded only by a comment.

  **The build no longer needs a database.** CI caught it: the same `npm run build` passed
  without `DATABASE_URL` and failed with it. Catalog pages render per request now, so a
  deploy cannot be failed by a database blip.

  **An end-to-end browser test of the hire path**, because the rubric says TermiX hires
  unaided. "The orchestrator is correct" and "a stranger can finish this" fail differently.

  **Still blocked on inputs, not code** - all four need something from outside the repo:
  `BSC_ARCHIVE_RPC_URL` (turns on the `pcs-lp` and `venus-loan` seeders and the window
  library), `ERC8004_IDENTITY_REGISTRY` + start block (replaces the seed with indexed
  agents - **fixtures do not survive judging**), x402 facilitator and ERC-8183 addresses
  (both clients are simulated adapters behind their real interfaces, labelled in the UI),
  and Altana access for per-agent wallets and EIP-7702 session keys. **Organiser questions
  are still unsent.**
