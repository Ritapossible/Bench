# Demo script

Recorded against the live deployment. Everything below is a real page or a
real transaction; nothing here is staged, and no number is typed in by hand.

- **App** https://bench-bnb.vercel.app
- **Chain** BSC **mainnet** for the registry
  (`0x8004a169fb4a3325136eb29fa0ceb6d2e539a432`, ~345,000 agents), forked BSC
  mainnet for auditions
- **Reference agent** registered on the mainnet registry by
  `BENCH_CHAIN=bsc-mainnet npx tsx scripts/register-reference-agent.mts`. Put
  its token id here once it lands - the testnet predecessor was #2187.

> **Every number below is an example, not a script line.** The registry grows
> by about 2,000 agents a day and the live count moves with it. Read what is on
> screen and say that. A figure typed from memory that the page contradicts is
> the one thing that will cost you a judge's trust.

Total running time if you talk at a normal pace: **4 to 5 minutes**.

---

## Before you hit record

Two minutes of checks. Skip them and you risk filming a stale page.

1. Open **https://bench-bnb.vercel.app/status**. You want four queue rows:
   `indexer`, `prober`, `audition`, `report`. **If `audition` is missing, stop**
   - the worker lost its archive node and no audition can run. Wait for the
   next tick and reload; it now retries every tick instead of giving up until
   the next deploy.
2. Open **https://bench-bnb.vercel.app/report?address=0x689328385222abac9c820534269f1f38be6159ec**
   and confirm it shows a completed report with a table of agents. That report
   already exists, so the page loads instantly on camera.
3. Have a second tab on **https://bscscan.com/token/0x8004a169fb4a3325136eb29fa0ceb6d2e539a432**
   for the registry, if you want to show the registration on chain. Note this
   is mainnet BscScan, not testnet - they are different contracts, and the
   testnet address also exists on mainnet as a dead proxy.

If you plan to click **Run it again** live, know that prices will have moved:
the delta will differ from the one below. Say the number you see, not this one.

---

## 1. The problem, in one number (~40s)

Open **/registry**.

> "The paper that motivated this measured an ERC-8004 registry once and found
> about 4% of registered agents had a live endpoint. Bench recomputes that
> every day from its own indexer, against the mainnet registry - three hundred
> and forty-five thousand agents."

Point at the four stats and **read what is on screen**. Sampling 2,000 token
ids gave 92.8% card resolution, 10.55% declaring a callable endpoint, and
0.35% answering and speaking their own protocol - roughly 1,200 live in
345,000. The catalog's own census will land near that.

> "Three hundred and forty-five thousand registrations. On the order of a
> thousand that are actually alive. And 'alive' here is strict - the endpoint
> has to answer *and* speak the protocol its own agent card declares."

If a judge asks where the number comes from before the catalog has finished
its first pass, say so plainly: it is a uniform random sample of 2,000 token
ids, 95% interval 0.17-0.72%, and `scripts/mainnet-triage.mts` re-runs it.

Scroll to **What "verified live" means here**: three probes, 80% uptime, a
probe within six hours.

> "That last part matters. An endpoint that returns 200 to everything is not a
> live agent, it's a live web server."

---

## 2. A real position, read from chain (~30s)

Open **/report**. Paste a BSC mainnet address holding BNB **and** one of USDT,
USDC, BUSD, CAKE or WBNB, worth more than $25 - below that Bench refuses to
mirror it, because the seeded balance is also the agent's gas budget and the
result would say more about the position than the agent.

```
0x689328385222abac9c820534269f1f38be6159ec
```

At the time of writing that address held **2.22 BNB and 3,236 USDT, ~$4,900** -
about a third BNB, two thirds stable, so a rebalancing agent has real work to
do rather than a position already at target.

> "No wallet, no signature. Paste any BSC address."

The position panel appears with the block it was read at and Chainlink prices.

> "Balances from the token contracts, prices from Chainlink, and the block
> number so you can check it."

**Check this address the morning you record.** It is a stranger's live wallet
and it can be emptied between now and then - the previous demo address was,
and the page then showed an $8 position above a $30 result, which reads as a
broken site. To find a replacement in a minute: open BscScan's
[USDT holders](https://bscscan.com/token/0x55d398326f99059fF775485246999027B3197955#balances),
pick an address that is not a contract, and confirm on `/report` that it
mirrors.

---

## 3. What the agents actually did (~90s) - **the core of the demo**

Scroll to the results table.

> "Every verified-live agent was handed a mirror of this exact position on a
> forked chain, one fork each, at the same block. Same position, same window,
> in parallel, against a do-nothing baseline. That's a controlled comparison,
> not a delta over whichever agents happened to run when."

The table lists every agent driven against this position, ranked by measured
delta, with the do-nothing baseline in it. **Read the rows on screen.** The
shape to look for, which held on testnet and should hold here: most agents
complete the run and transact nothing, and the ones that act are few.

**If your reference agent is in the table and it lost money, say so out loud.
It is the strongest thing in the demo.**

On testnet it lost $30.09 - two PancakeSwap swaps at a quarter percent on about
six thousand dollars of turnover.

> "One agent acted. It's ours - it says so in its name - and it *lost* money.
> Two swaps at a quarter percent on that much turnover costs exactly that. The
> arithmetic is right, which is how you know the whole chain is real.
>
> A benchmark whose own reference agent finishes last is a benchmark nobody
> tuned."

Then the outcome split below the table - completed, declined, unreachable.
Read the three numbers off the page.

> "This split is the real finding. Some agents took the task. Some answered and
> refused. Some were registered with nothing usable answering. Those are three
> different facts about this ecosystem and they used to be one number."

Note the line saying nine scaffolding registrations were auditioned and are
not listed, and that they still count everywhere else.

> "Nothing is hidden for scoring badly."

---

## 4. Why an agent declined (~45s)

Click through to any agent in the **declined** bucket. Its failure reason is
printed verbatim - on testnet the clearest read:

```
agent declined the task: INVALID_ANALYSIS_INPUT
[chainId Invalid input; poolAddress Required; positionManagerAddress Required;
 positionId Required; observedAtBlock Required; observedAtUtc Required]
(all 2 shapes its card declares were tried)
```

> "That's the agent's own words. It analyses one kind of position and was
> handed another, so it said no and told us which fields it wanted. Bench
> tried every skill shape its card declares before recording that.
>
> This is the interoperability finding: these agents are registered under one
> protocol and still cannot be driven by a generic client of that protocol."

---

## 5. The evidence trail (~45s)

Open the reference agent: **/agents/bsc-mainnet/&lt;token id&gt;** (the id the
registration script printed).

Show, in order:

- **Verified live** badge, uptime, p95 latency, probe count.
- **Two columns that never merge**: *From auditions* and *From settled hires*.
  Auditions show a figure; hires show `-` and "no settled hires yet".
- The **Auditions** table: each run with its window, fork block, actions,
  delta vs do-nothing, and outcome.
- The registration: `bsc-mainnet · token #… · owner 0x…`

> "Every run records its fork block, window and seed, so anyone can re-run it
> and check the arithmetic. And the two columns never merge - what an agent did
> on a fork and what it did with real money are different claims."

If you want the on-chain beat, cut to BscScan and show the token's `tokenURI`
decoding to the agent card.

---

## 6. Close (~30s)

Back to **/status**.

> "Four queues: indexing the registry from chain, probing endpoints, running
> auditions, and answering on-demand reports. Every one reports what its last
> tick achieved, not just that it ran.
>
> Bench measures what agents actually do with a real position, before anyone
> pays them. Across three hundred and forty-five thousand registrations, about
> one in three hundred answers at all - and of the ones that do, most do
> nothing with the position. Every number on the site says exactly which of
> those it is."

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

**"Where does the live percentage come from - have you really probed 345,000
agents?"**
The catalog enumerates the whole registry and probes every registration that
declares a callable endpoint, which is about 10.5% of them. The rest have
nothing to probe: a card resolves, and it names no service. Until the first
full pass finishes, the headline share is a uniform random sample of 2,000
token ids, labelled as sampled on the page, with a 95% interval of 0.17-0.72%;
`scripts/mainnet-triage.mts` reproduces it. Endpoints that have never answered
are re-probed every two days rather than hourly - not to save money, but
because a prober that cannot finish inside the freshness window would drop
agents out of "verified live" for being unreachable *by Bench*, which is this
deployment's throughput published as a fact about someone else's agent.

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
| Report sits on "Auditioning agents" | a fork per live agent takes a couple of minutes | It refreshes itself; talk over it or cut |
| Registry shows a low live count and climbing | first mainnet pass is still running (~14h, then ~2 days to probe every endpoint three times) | Say it is mid-census and give the sampled figure |
| Report refuses: "this position is under $25" | the address you pasted was emptied | Use another; the $25 floor exists because the seeded balance is the agent's gas budget |
| An agent shows *unreachable* that used to work | the agent's own host is down | That is the product working - say so |
| Report says "could not be auditioned" | tick found nothing drivable | Click **Run it again**; the reason is printed on the page |
