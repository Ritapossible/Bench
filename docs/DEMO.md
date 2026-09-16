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

Click **Raise a dispute** on the hire page. Five fields, in order.

### Field 1 - What went wrong

Leave it on the **first** radio: *It did something it was not allowed to do*.

That is the `breach` ground. It settles by replaying the mandate you signed over
the recorded actions: no model call, no confidence score, arithmetic anyone can
recompute. The second option, *It did not do the job*, costs a model call and
returns a judgment instead of a proof.

### Field 2 - What you hired it to do

Paste this. **Change the date to the day you record**, so that when you read it
back off the chain in section 3.1 nobody can claim it was written earlier:

```
Rebalance my BNB/USDT position toward 50/50, touching only the pool I allowlisted. Recorded 16 September 2026.
```

### Field 3 - What should have happened, one per line

Each line is ruled on separately, and one line going against the agent is enough
to uphold. Up to eight lines; two is plenty on camera.

```
No funds left the contract I allowlisted.
The position was rebalanced to within 5% of 50/50.
```

### Field 4 - Evidence, one https URL per line

**Optional, and use at most two.** The hire's own action record is added
automatically, and the claimant's half of the evidence budget is three sources
in total - supply three yourself and the contract refuses with *leave room for
the hire's own record url*.

One is enough to make the point:

```
https://bscscan.com/address/0x46a15b0b27311cedf172ab29e4f4766fbe7f4364
```

Worth narrating: that URL comes back classified `independent`, while Bench's own
action record comes back `marketplace`. **Bench's evidence is not counted as
neutral, because Bench is not neutral** - it lists the agent, ranks it, and takes
a cut of this hire.

### Field 5 - Filing bond

Leave it at **`0.01`** GEN. It is also the contract's minimum, so the form
cannot offer an amount the chain would refuse.

Then press **File it**.

It returns in about five seconds with *"Filed. GenLayer validators are reaching
consensus on it now."* **Wait a minute and refresh the page**, and the dispute
appears below with its state, the answer window, and the evidence tally.

Those five seconds are the submission. The minute is consensus. The page cannot
wait for the second one - a serverless function is killed long before a ruling
round finishes - so it submits, says so, and reads the result back off the
contract when you reload. Measured against the deployed arbiter: filed in 4.7s,
visible on chain 11s later.

### You will not be asked to sign, and you will not pay gas

Worth knowing before you narrate it, because it is the opposite of what a web3
demo usually shows.

**Bench files on the hirer's behalf and pays the GEN.** The hire's client is a
per-browser identity - there is no private key for it anywhere in the world - so
requiring the client's own signature would make the remedy unreachable for every
hire made through a front end that has not asked its user to connect a wallet.
The contract admits the client *or* the address that registered the hire, and
records both: `claimant` is who posted the bond, `on_behalf_of` is the hire's
client.

Connecting a wallet in the header is **identity only**: it signs one message so
your hires survive clearing the browser. It sends no transaction and needs no
balance.

If you would rather the hirer signed and paid themselves, that is the GenLayer
Transaction Kit path and it is a real piece of work, not a setting. It would
also mean anyone testing the demo needs GEN in their browser wallet on a faucet
devnet, which is a worse first experience for a judge than the current one. The
honest sentence for the video is: *"Bench files for you and posts the bond, and
the chain records that it was Bench who filed - but Bench cannot influence the
ruling by a single bit, because that runs on validators none of us control."*

---

## 3.1 Prove the front end really called GenLayer

**Optional.** Filing works without any of this - the panel showing your dispute,
read back from the contract on reload, is already the front end talking to
GenLayer. This is for the moment in the video where someone might reasonably ask
*"is that really on chain, or is it just your database?"*

One command, read-only, and the viewer can run it themselves. Run it **before**
you file and again **after**.

```bash
node contracts/genlayer/tools/verify_dispute.mjs 0xB608B27603965E8A61ab46cE59058d332FDa0566
```

Read-only: no key, no gas, nothing configured. Anyone watching can run the same
command against the same address and get the same answer, which is the
difference between demonstrating an integration and asserting one.

Before filing it prints the dispute count. **The contract already holds one
dispute**, filed during an end-to-end test on 14 September, so the count goes
`1` to `2` and yours is dispute `1`. Worth knowing before you are live: an
unexpected number on screen is the kind of thing that derails a take.

After filing, the new dispute reads back like this - **with your own sentences
in it**:

```
arbiter   0xB608B27603965E8A61ab46cE59058d332FDa0566
chain     GenLayer Studio Next (61997)
disputes  2

--- dispute 1 ---
state        OPEN
ground       BREACH
opened       2026-09-16T...
answer ends  2026-09-17T...
bond         0.01 GEN
claimant     0xaA34e1...   (posted the bond)
on behalf of 0x4886AD...   (the hire's client)

engagement   Rebalance my BNB/USDT position toward 50/50, touching only the
             pool I allowlisted. Recorded 16 September 2026.
criteria
  1. No funds left the contract I allowlisted.
  2. The position was rebalanced to within 5% of 50/50.

evidence, and who each source belongs to
  [marketplace] https://bench-bnb.vercel.app/api/hires/.../actions
  [independent] https://bscscan.com/address/0x46a15b...
```

**The text you typed into the form is now in contract storage on a chain Bench
does not run.** A screenshot of a form proves nothing. The same sentence read
out of GenLayer, by a command the viewer can run themselves, is hard to argue
with.

Three details worth pointing at while it is on screen:

- **`claimant` and `on behalf of` are different addresses.** Bench filed on the
  hirer's behalf, because the hire's client is a per-browser identity with no
  key. The chain records both, so the widening is visible rather than implied.
- **The evidence is attributed.** `marketplace` is our own record;
  `independent` is neither party's.
- **No verdict yet.** Nobody may rule until the answer window closes. A verdict
  taken on one side's documents is one side's verdict.

You can also open the address in the explorer:
https://explorer-studio-dev.genlayer.com

## 4. Show a completed ruling

The repository ships a script that runs the whole lifecycle against a real
contract, using a published action record whose second action pays an address
the mandate never allowlisted:

```bash
node contracts/genlayer/tools/demo_cycle.mjs 0x<arbiter> 0x<funded-genlayer-key>
```

Both tools build on the workspace, so run `npm run build` once first.

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
