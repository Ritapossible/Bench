# Demo script

Recorded against the live deployment. Everything below is a real page or a
real transaction; nothing here is staged, and no number is typed in by hand.

- **App** https://bench-bnb.vercel.app
- **Chain** BSC testnet for the registry, forked BSC mainnet for auditions
- **Reference agent** ERC-8004 token
  [#2187](https://testnet.bscscan.com/tx/0x03db85323cb9344d6a434a1715238160f059c10489732381943154accbd07d5a)

Total running time if you talk at a normal pace: **4 to 5 minutes**.

---

## Before you hit record

Two minutes of checks. Skip them and you risk filming a stale page.

1. Open **https://bench-bnb.vercel.app/status**. You want four queue rows:
   `indexer`, `prober`, `audition`, `report`. **If `audition` is missing, stop**
   - the worker lost its archive node and no audition can run. Wait for the
   next tick and reload; it now retries every tick instead of giving up until
   the next deploy.
2. Open **https://bench-bnb.vercel.app/report?address=0xca7c95fc431204af7eb9b16b6db1fd9f80ee243c**
   and confirm it shows a completed report with a table of agents. That report
   already exists, so the page loads instantly on camera.
3. Have a second tab on **https://testnet.bscscan.com/token/0x8004A818BFB912233c491871b3d84c89A494BD9e**
   for the registry, if you want to show the registration on chain.

If you plan to click **Run it again** live, know that prices will have moved:
the delta will differ from the one below. Say the number you see, not this one.

---

## 1. The problem, in one number (~40s)

Open **/registry**.

> "The paper that motivated this measured the ERC-8004 registry on BNB Chain
> once, and found about 4% of registered agents had a live endpoint. Bench
> recomputes that every day from its own indexer."

Point at the four stats. Today they read roughly:

| Registered | Card resolves | Verified live | Live share |
| --- | --- | --- | --- |
| 2,194 | 1,485 | 20 | 0.9% |

> "Two thousand registrations. Twenty that are actually alive. And 'alive'
> here is strict - the endpoint has to answer *and* speak the protocol its own
> agent card declares."

Scroll to **What "verified live" means here**: three probes, 80% uptime, a
probe within six hours.

> "That last part matters. An endpoint that returns 200 to everything is not a
> live agent, it's a live web server."

---

## 2. A real position, read from chain (~30s)

Open **/report**. Paste:

```
0xca7c95fc431204af7eb9b16b6db1fd9f80ee243c
```

> "No wallet, no signature. Paste any BSC address."

The position panel appears: **~$16,288 - 2.54 BNB and 14,388 USDT**, with the
block it was read at and Chainlink prices.

> "Balances from the token contracts, prices from Chainlink, and the block
> number so you can check it."

---

## 3. What the agents actually did (~90s) - **the core of the demo**

Scroll to the results table.

> "Every verified-live agent was handed a mirror of this exact position on a
> forked chain, one fork each, at the same block. Same position, same window,
> in parallel, against a do-nothing baseline. That's a controlled comparison,
> not a delta over whichever agents happened to run when."

The table reads (yours will differ slightly):

| Agent | Category | Actions | vs doing nothing |
| --- | --- | --- | --- |
| Do nothing | baseline | 0 | +$0.00 |
| BNB Grid Trader | Grid trading | 0 | +$0.00 |
| bubbleaiagent | Other | 0 | +$0.00 |
| IVL Rebalancer | Rebalancing | 0 | +$0.00 |
| My Personal Holon - Swahili Translation | Other | 0 | +$0.00 |
| **Bench Reference Rebalancer (operated by Bench)** | Rebalancing | **2** | **−$30.09** |

**Say the awkward part out loud. It is the strongest thing here.**

> "One agent acted. It's ours - it says so in its name - and it *lost* thirty
> dollars. Two PancakeSwap swaps at a quarter percent on about six thousand
> dollars of turnover is thirty dollars. The arithmetic is right, which is how
> you know the whole chain is real.
>
> A benchmark whose own reference agent finishes last is a benchmark nobody
> tuned."

Then the outcome split below the table:

| How the runs ended | Agents |
| --- | --- |
| Completed - took the task and finished | 14 |
| Declined - answered, and said no | 5 |
| Unreachable - registered, but nothing usable answered | 1 |

> "This split is the real finding. Fourteen agents took the task. Five answered
> and refused. One was registered and unreachable. Those are three different
> facts about this ecosystem and they used to be one number."

Note the line saying nine scaffolding registrations were auditioned and are
not listed, and that they still count everywhere else.

> "Nothing is hidden for scoring badly."

---

## 4. Why an agent declined (~45s)

Click through to a declined agent - **ProofEra LP Risk Evidence Agent** is the
clearest. Its failure reason reads:

```
agent declined the task: INVALID_ANALYSIS_INPUT
[chainId Invalid input; poolAddress Required; positionManagerAddress Required;
 positionId Required; observedAtBlock Required; observedAtUtc Required]
(all 2 shapes its card declares were tried)
```

> "That's the agent's own words. It analyses PancakeSwap V3 LP positions and it
> was handed a spot balance, so it said no and told us which fields it wanted.
> Bench tried every skill shape its card declares before recording that.
>
> This is the interoperability finding: these agents are registered under one
> protocol and still cannot be driven by a generic client of that protocol."

---

## 5. The evidence trail (~45s)

Open the reference agent: **/agents/bsc-testnet/2187**.

Show, in order:

- **Verified live** badge, uptime, p95 latency, probe count.
- **Two columns that never merge**: *From auditions* and *From settled hires*.
  Auditions show a figure; hires show `-` and "no settled hires yet".
- The **Auditions** table: each run with its window, fork block, actions,
  delta vs do-nothing, and outcome.
- The registration: `bsc-testnet · token #2187 · owner 0x9CA0DFd6…`

> "Every run records its fork block, window and seed, so anyone can re-run it
> and check the arithmetic. And the two columns never merge - what an agent did
> on a fork and what it did with real money are different claims."

If you want the on-chain beat, cut to BscScan and show token #2187's
`tokenURI` decoding to the agent card.

---

## 6. Close (~30s)

Back to **/status**.

> "Four queues: indexing the registry from chain, probing endpoints, running
> auditions, and answering on-demand reports. Every one reports what its last
> tick achieved, not just that it ran.
>
> Bench measures what agents actually do with a real position, before anyone
> pays them. Today most of them do nothing, one of them loses thirty dollars,
> and every number on the site says exactly which of those it is."

---

## Things to be honest about if a judge asks

Have these ready. Each one is a strength if you say it first.

**"Why is your own agent losing money?"**
Because a rebalance costs two swap fees and the position didn't move enough to
pay for them. It's the honest result for this window. It also proves the
harness measures cost, not just upside.

**"Why are all the other agents at zero?"**
They completed the run and chose not to transact. Most reachable agents on this
registry are read-only analysts or ERC-8183 sellers - they don't manage
positions at all. That is the finding, not a gap in the measurement.

**"Is this simulated?"**
The position, the chain state, the pool liquidity, the gas and the agents are
all real, and the EVM really executes the transactions. The only thing that
does not happen is the broadcast. The page says "measured, not estimated" for
that reason. What a fork cannot reproduce is the market reacting - no competing
flow, no MEV - and the page says that too.

**"Could an agent cheat the score?"**
It could until yesterday: the fork RPC is public by construction and anvil's
cheat codes were reachable through it, so an agent could have written itself a
balance. The interceptor now runs a method allowlist - read-only calls plus
`eth_sendRawTransaction`, which is decoded, gated and recorded. Unsigned sends
are refused too, because they bypass the record.

**"What is not finished?"**
Probe results are hash-chained but on-chain anchoring is not live on this
deployment. Hiring is Phase 4 - payment and escrow are simulated in the
checkout, and the page says so. Settled-hire scores are empty because no job
has settled.

---

## If something breaks on camera

| Symptom | Cause | What to say |
| --- | --- | --- |
| `audition` missing from /status | worker lost the archive node | Skip to the existing report link; it is already computed |
| Report sits on "Auditioning agents" | ~20 forks take a couple of minutes | It refreshes itself; talk over it or cut |
| An agent shows *unreachable* that used to work | the agent's own host is down | That is the product working - say so |
| Report says "could not be auditioned" | tick found nothing drivable | Click **Run it again**; the reason is printed on the page |
