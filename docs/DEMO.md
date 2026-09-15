# Demo runbook: the dispute layer on camera

Everything below is copy-paste. It was written against the deployed contract and
the numbers are measured, not estimated.

| | |
|---|---|
| App | https://bench-bnb.vercel.app |
| Arbiter | `0xB608B27603965E8A61ab46cE59058d332FDa0566` |
| Network | GenLayer Studio Next, chain `61997` |
| RPC | `https://studio-next.genlayer.com/api` |
| Explorer | https://explorer-studio-dev.genlayer.com |

---

## Read this before you record

**A breach cannot be manufactured through the UI, by design.** The execution
gate refuses a transaction that would break the mandate, and only *admitted*
actions go into the published record. So a dispute filed against a hire made in
the demo will be **dismissed** or go **unresolved** - never upheld - because
the agent genuinely did nothing wrong.

That is the better story, and worth saying out loud while you record: *"the
arbiter is being asked to side with me, it reads the record, and it refuses."*
A marketplace whose dispute layer only ever agrees with the complainer is not an
arbiter.

To show an **upheld** ruling you need a record that contains a breach, which
means the scripted path in section 4. Both are real; they differ in who
published the record.

**The answer window is 24 hours on the currently deployed contract**, and
nothing can be ruled until it closes. So a single take cannot go from filing to
verdict. Either record the filing and cut to a verdict produced earlier, or
redeploy with a short window first - see section 5.

---

## 1. Make a hire

Go to **Catalog**, open any agent with a green **Verified live** badge, then
**Hire this agent**. Five steps, each with its own confirm button; the last one
says *Confirm all bounds* rather than *Confirm and continue*.

Defaults are fine. If you want the bounds to be memorable on camera:

| Field | Value |
|---|---|
| Price | `1` |
| Total cap | `50` |
| Per-transaction cap | `10` |
| Max actions | `20` |
| Expiry (hours) | `24` |
| Allowlist | `0x46a15b0b27311cedf172ab29e4f4766fbe7f4364` |
| Task | `Rebalance my BNB/USDT position toward 50/50 over the next 24 hours.` |

The hire takes a few seconds: it writes the escrow and the session key, then
submits the terms to GenLayer. **It does not wait for consensus** - that would
exceed the serverless time limit - so the hire page may briefly show *Terms not
pinned*. Refresh once after about five seconds and it becomes **Terms pinned**
with a sha256 digest. Measured: submitted at 4.8s, readable on chain at 5.7s.

## 2. Show the terms are pinned

On the hire page, the **Disputes** panel shows:

- the arbiter's network and address,
- **Terms pinned** with the timestamp and the `sha256` of the terms,
- the action record URL, pinned at the same moment.

Worth saying: the digest was taken **when the hire was created**, before anyone
knew there would be a dispute, so neither side can restate the rules afterwards.

## 3. File the dispute

Open **Raise a dispute**. Leave the ground on the first option - *It did
something it was not allowed to do* - which is the breach ground: replayed
arithmetic, no model call, recomputable by anyone.

**What you hired it to do**

```
Rebalance my BNB/USDT position toward 50/50, touching only the pool I allowlisted.
```

**What should have happened, one per line**

```
No funds left the allowlisted contract.
The position was rebalanced to within 5% of 50/50.
```

**Evidence, one https URL per line** - optional. The hire's own action record is
always included automatically and is classified `marketplace`, not
`independent`, because it is ours. To show an independent source in the tally,
add:

```
https://bscscan.com/address/0x46a15b0b27311cedf172ab29e4f4766fbe7f4364
```

**Filing bond**: leave at `0.01` GEN. It returns if the dispute is upheld, and
also if the arbiter cannot decide - failing to reach a ruling is not the
claimant's fault.

Submit. Filing goes through GenLayer consensus, so give it a minute or two. The
panel then shows the dispute **Open**, the answer window, and the evidence tally
split by who each source belongs to.

Worth saying: **Bench files on the hirer's behalf** and the chain records both
addresses - `claimant` is who posted the bond, `on_behalf_of` is the hire's
client. The panel says so in words. Bench cannot influence the ruling either
way; that runs on validators none of the three parties control.

## 4. Show a completed ruling

The repository ships a script that runs the whole lifecycle against a real
contract, using a published action record whose second action pays an address
the mandate never allowlisted:

```bash
node contracts/genlayer/tools/demo_cycle.mjs 0x<arbiter> 0x<funded-genlayer-key>
```

It prints each step as it happens. A real run:

```
[1] register_hire   terms pinned, digest cc61e091fc5d5f9b...
[2] open_dispute    dispute 0 open, evidence independent:1
[3] answer          refused: "only the respondent may answer"
[4] adjudicate      UPHELD, resolved by replay, 0 model calls
                    criterion 1: unmet, 100% confident
                    findings: contract-not-allowlisted@2, unseen-recipient@2
[5] settlement      owed_to(filer) = 0.01 GEN, bond returned
```

The two findings on the same action are the two independent bounds firing at
once: the allowlist the owner signed, and the behaviour the agent established in
audition. Neither subsumes the other.

## 5. If you want filing and verdict in one take

Redeploy the arbiter with a short answer window. Everything else is unchanged:

```bash
genlayer deploy --contract contracts/genlayer/arbiter.py \
  --rpc https://studio-next.genlayer.com/api \
  --args 6 200000 75 15 2 120 60 86400 10000000000000000
```

The seventh argument is `answer_period` in seconds - `60` instead of `86400`.
Then set `GENLAYER_ARBITER_ADDRESS` to the new address on Vercel and redeploy.

Say on camera that the demo window is short and a real deployment uses 24 hours.
A one-minute window is a demo convenience, not a design claim.

---

## What to expect when

| Step | How long | Why |
|---|---|---|
| Hire submitted | ~5s | Escrow, session key, then the terms transaction is submitted |
| Terms pinned readable | ~6s | One GenLayer consensus round |
| Dispute filed | 1-2 min | Payable transaction through consensus |
| Answer window | 24h, or your redeployed value | Nobody may rule before it closes |
| Adjudication | 1-2 min | Validators fetch the record and each replay it |

## If something does not go to plan

**The panel says "Not on this deployment".** It now prints the actual reason
under *Why:*. Read it: it names the arbiter's own settings, and nothing else can
take it down.

**The hire page says "Terms not pinned".** Refresh after five seconds. If it
persists, the button beside it retries; the terms are computed from the stored
hire, so the retry cannot change them.

**A filing is refused.** The contract's own words come back on the page. The
useful ones are `bond below the minimum`, `hire not registered`, and
`only the client or the registrar may open a dispute`.
