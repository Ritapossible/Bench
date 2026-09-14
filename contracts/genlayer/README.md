# Arbiter

**Who rules when a hired agent did not deliver, and why it cannot be Bench.**

> The escrow could always be marked disputed. Nothing ever ruled on it. This is
> the thing that rules on it — and the reason it runs somewhere else.

---

## The hole this fills

Bench has carried a `disputed` escrow status since its first week, and
`EscrowClient.dispute(jobId, reason)` has been callable the whole time. Neither
has an adjudicator. A disputed job sits disputed, the window closes, and
ERC-8183's optimistic rule releases the money to the agent anyway.

The status was a label on a hole, and the hole is the hard part:

- Deciding whether an agent delivered is a **judgment**. A conventional chain
  cannot perform one — it has no way to read a page, weigh what it says, and
  have other nodes agree that the weighing was reasonable.
- Neither party can be trusted to perform it, because the parties who care are
  precisely the parties who must not decide.
- **And Bench must not decide either.** Bench lists the agent, ranks it on its
  own leaderboard, and takes a cut of the hire. A marketplace adjudicating
  disputes about its own listings is marking its own homework.

That third constraint is the one that shapes everything below. It is why the
ruling runs on GenLayer validators rather than in `@bench/services`, why
`marketplace` is its own category in the evidence tally, and why the adapter for
a deployment with no arbiter **refuses every call instead of returning a
plausible verdict**.

---

## Two grounds, two costs

| | `BREACH` | `DELIVERY` |
|---|---|---|
| The claim | "it did something it was not allowed to do" | "it did not do the job" |
| How it settles | replay the signed terms over the recorded actions | one model call over evidence both parties pinned |
| Cost | **zero model calls** | one model call |
| Guarantee | arithmetic over a mandate the owner signed — nothing to argue with | a judgment, with a confidence attached and a floor under it |
| Fails when | the action record is missing or contested | evidence is ambiguous or silent |

**Prefer `BREACH` wherever the complaint can be phrased as a rule the mandate
already carries.** It is deterministic, free, and a reviewer can recompute it
from the stored terms and the stored actions with no network and no model.

> *"It wasted my money"* is a judgment.
> *"It spent past the cap I signed"* is arithmetic — and a stronger case.
> *"It paid an address I never allowlisted"* is arithmetic twice over.

Most complaints that sound like the second column are the first in disguise, and
rewriting one into the other is almost always an upgrade.

---

## The replay is Bench's own gate, run backwards

`checkMandate` and `checkAgainstEnvelope` in `@bench/core` decide whether a
transaction may be *signed*. The same two rules, over the sequence that actually
happened, decide whether one *should have been*.

This matters more than it sounds. A dispute layer with its own rulebook could
find a breach the gate would have allowed, or clear one it would have refused —
and then two parts of the same system disagree about what the agent was
permitted to do, with money resting on the difference.

**So why can a breach happen at all, given a gate?** Three ways, all real:

1. The behavioural envelope is **advisory** below three auditions, and the gate
   lets those through by design.
2. The mandate's caps bind the session key on-chain; the envelope binds only
   what passes through Bench.
3. An agent holding a session key can submit **directly to the chain** without
   asking Bench anything.

The replay is what notices afterwards.

### One rulebook, two implementations, and how they are held together

The replay exists twice: once in `packages/core/src/types/dispute.ts`, once in
`lib/arbiter_core.py`. That is deliberate and uncomfortable. The alternative is
asking Bench for the answer, which is the thing this layer exists to prevent.

Duplication without a conformance check is how two implementations drift until
one of them is quietly wrong. So:

```
contracts/genlayer/tools/gen_vectors.mts   generates from the TypeScript
contracts/genlayer/tests/vectors.json      15 cases, the shared target
contracts/genlayer/tests/test_vectors.py   asserts the Python reproduces them
packages/core/test/dispute-vectors.test.ts asserts the TypeScript still produces them
.github/workflows/ci.yml                   regenerates and diffs the file
```

The CI diff matters: a file both suites read is a file someone could edit to
make both suites pass.

**It earned its keep immediately.** Two genuine mismatches, both now cases:

- **The action ceiling rounds up; the value ceiling rounds down.** The
  TypeScript computes one in floating point with `Math.ceil` and the other in
  `BigInt`. Three observed actions at 50% tolerance is a ceiling of *five*, not
  four — so a four-action hire would have passed Bench's gate and been found in
  breach by the chain.
- **Revocation is a moment, not a flag.** The action before the kill switch was
  authorised and the one after it was not; a single boolean has to pick one
  answer for a hire where both are true. Spending after revocation is the breach
  a hirer is angriest about, and it was unrepresentable.

---

## Both sides file

This is what makes it a dispute layer rather than a complaints box.

```
register_hire   terms pinned by digest, at hire time
   |
open_dispute    the client files, and posts a bond      -> answer window opens
   |
answer          only the respondent, only before it closes
   |
adjudicate      refuses until the answer window has closed
   |
   +-> UPHELD      escrow refunds; bond returns to the claimant
   +-> DISMISSED   agent delivered; bond goes to the respondent
   +-> unresolved  window extends, up to max_extensions
   +-> ABSTAINED   arbiter could not decide; bond returns to the claimant
```

A ruling taken before the answer window closes is a ruling on an evidence set
the claimant chose alone — and the independence tally would show a clean sweep
of claimant-origin sources while looking perfectly orderly.

**`ABSTAINED` is deliberately not a synonym for `DISMISSED`.** After abstention
the escrow's own optimistic default applies and money moves as it would have
without a dispute, but the record says the arbiter *could not decide* rather
than that the agent was *cleared*. Collapsing the two would let a respondent
bank an exoneration it never received.

### The filing bond

Returns to the claimant on `UPHELD` and on `ABSTAINED`. Goes to the respondent
only on `DISMISSED`.

Abstention returning the bond is not generosity: charging the claimant for the
arbiter's inability to decide would make filing a hard dispute a losing bet
whatever the truth, and only easy complaints would ever get made.

---

## The record the replay reads

A breach ruling is arithmetic over two things: the terms, pinned by digest at
hire time, and **the action record**, fetched at adjudication from a URL pinned
at the same moment.

```
GET /api/hires/<id>/actions

{"hire_id": "h_…",
 "actions": [{"seq": 1, "at": 1767225600, "to": "0x…", "value": "100",
              "data": "0x38ed1739", "token": "0x…"}],
 "revoked_at": null}
```

Three decisions inside that small object:

**Only admitted actions are in it.** The decision trace holds every proposal
including the refused ones, hash-chained, and it is a different artifact
answering a different question. A refused proposal never reached a chain;
replaying one would find a breach in Bench's own gate correctly saying no.

**`revoked_at` travels in the record, not in the terms.** Terms are digest-pinned
at hire time, before anyone knows there will be a dispute — and revocation
happens afterwards. A `revoked_at` inside the digest would therefore be empty
for every hire that has not yet gone wrong, which makes *"it kept spending after
I revoked"* — the breach a hirer is angriest about — unprovable by construction.
So it is published as part of what happened, and held to the same standard as
the rest of the record.

**A missing record is not an empty record.** `404` and `{"actions": []}` are
different claims: the first goes `unresolved`, the second can dismiss. A hire
with no stored actions answers `404` rather than clearing an agent on evidence
Bench does not have.

Bench is the record's likeliest publisher, and the arbiter treats it that way —
`marketplace`, never `independent`. Every fetched copy must agree or the dispute
goes unresolved, which is what makes publishing a competing record worth
something. **Publishing nothing is not neutrality**: an arbiter with no record to
read answers `unresolved` every time, and that quietly favours whoever is
already holding the money.

---

## Evidence has an owner, and the tally says so

`evidence_independence()` is free to call and is the view worth putting in
front of a user.

| Origin | What it means |
|---|---|
| `independent` | Neither party, and not Bench. |
| `claimant` | Chosen by the side that complained. |
| `respondent` | Chosen by the side answering. |
| **`marketplace`** | **Ours.** Bench listed this agent, ranks it, and takes a cut. |
| `unclassified` | Not an https URL this could attribute. |

`marketplace` being its own category rather than part of `independent` is the
single most load-bearing decision in the engine. Bench's API is the most
convenient evidence in any Bench dispute and the least disinterested, and a
tally that hid that would flatter every ruling made on it.

It is a **host comparison, not an opinion** — no trust in the contract's
judgment is required and anyone can recompute it from the URLs alone. Userinfo
is refused outright: `https://evidence.example@attacker.test/` reads as one host
and fetches from another, which is exactly how a party would smuggle a page it
controls past the tally.

### A doctored action record is answerable

The record of what the agent did is evidence, not scripture, and its most
convenient publisher is the marketplace. So every pinned source that carries a
record is fetched and **they must agree**: if the claimant's copy and the
respondent's differ, the ground cannot settle and the dispute goes unresolved.

The respondent's remedy against a falsified record is to publish its own — and
this is what makes publishing it worth anything.

---

## The model reads; the contract rules

`exec_prompt` is never told that a dispute exists, who the parties are, which
side pinned which source, that money moves, or what any answer would cause.
`derive_ruling` turns per-criterion readings into an outcome by fixed rule.

Injected text has no lever to pull because **no lever appears in the prompt**.

Four properties bound what a hostile evidence page can do:

1. The model is asked to perceive, never to decide. *(what the prompt omits)*
2. Criterion ids are coerced against the dispute's own set. *(`arbiter_core`)*
3. Untrusted spans are fenced with delimiters derived from a per-dispute salt a
   page author cannot predict. *(`arbiter_prompts`)*
4. Canonicalization is total: any answer at all — prose, an empty object, a list
   where a dict belongs — produces a well-formed verdict. *(`arbiter_core`)*

**Where this is a mitigation and not a fix.** A respondent controls its own
status page and can write on it whatever would clear it. Fencing does not change
that. The compensating control is the independence tally, which is shown next to
the ruling: whoever can inject into a page they control can already just write
the claim plainly, and injection buys them nothing page control did not already
grant.

Sources are also rendered in a fixed order with **no marking of which party
pinned them**, because telling the model whose case a document supports is
precisely the lever property 1 removes.

---

## Agent to agent

The contract does not know what a person is. `client` and `respondent` are
addresses; a human's wallet and another agent's session key are the same thing
to it. An agent that hires another agent and is let down files exactly the
dispute a human would, through the same methods, with the same windows.

This is the case with no existing mechanism at all — neither party is a legal
person, so neither can sue, and the amounts are far too small for arbitration to
be worth invoking.

---

## Fail closed, toward no ruling

Every ambiguous, malformed, unreachable or hostile case resolves to
`unresolved`: nothing moves and the window extends.

Note this is the **opposite direction** from MandateVault, which fails closed
toward denial. The direction is a property of what an error costs, not a house
style: there a wrongful approval spends money that does not come back; here a
wrongful ruling takes money from a party who may have done nothing wrong. Fail
toward whichever outcome is reversible.

The confidence floor is one-sided for the same reason. An `unmet` reading below
`min_confidence` is downgraded to `unresolved`; a `met` reading is not. Upholding
takes money from a party that may have delivered, so it needs conviction;
dismissing leaves the escrow to settle exactly as the parties already agreed it
would.

---

## Layout

```
arbiter.py             the deployable artifact - generated, do not hand-edit
lib/arbiter_core.py    the deterministic engine: replay, coercion, consensus
lib/arbiter_prompts.py prompt construction, with untrusted spans fenced
tools/build_contract.py inlines lib/ into arbiter.py (GenLayer deploys one file)
tools/gen_vectors.mts  generates the conformance vectors from the TypeScript
tests/                 84 tests: engine, conformance, artifact freshness
```

`lib/*.py` are the source of truth and what the tests import. Neither declares a
contract class; `genvm-lint` reports E105 against them, correctly.

---

## Working on it

```bash
# after any change to lib/
python tools/build_contract.py

# the whole suite
python -m pytest contracts/genlayer/tests -q

# after any change to the rulebook on either side
npx tsx contracts/genlayer/tools/gen_vectors.mts
python -m pytest contracts/genlayer/tests -q
npx vitest run packages/core/test/dispute-vectors.test.ts
```

`tests/test_contract_sync.py` fails if the checked-in `arbiter.py` is stale, so
a contract that no longer matches the libraries it was built from cannot reach a
reviewer or a chain unnoticed. It also enumerates the public ABI — a method
appearing there unnoticed is how an unintended write ships — and asserts that
`emit_transfer` is called in exactly one place.

---

## Deploying

Deployed on **Studio Next** — chain `61997`, RPC `https://studio-next.genlayer.com/api`,
explorer `https://explorer-studio-dev.genlayer.com/`.

```bash
genlayer deploy --contract contracts/genlayer/arbiter.py \
  --rpc https://studio-next.genlayer.com/api \
  --args 6 200000 75 15 2 86400 86400 604800 10000000000000000
```

| # | Parameter | Default | Meaning |
|---|---|---|---|
| 1 | `max_sources` | `6` | Evidence URLs per dispute. Six rather than three because **two parties file**, and half is reserved for the respondent — a ceiling one side could exhaust would be a censorship mechanism. |
| 2 | `max_source_bytes` | `200000` | Per-source truncation, applied after normalization. |
| 3 | `min_confidence` | `75` | Below this an `unmet` reading is `unresolved`. The threshold money can move across. |
| 4 | `confidence_tol` | `15` | Validator tolerance, applied **only** when both values sit on the same side of `min_confidence`. |
| 5 | `max_extensions` | `2` | How many `unresolved` rulings before the arbiter abstains. |
| 6 | `extension_period` | `86400` | Seconds added per extension. |
| 7 | `answer_period` | `86400` | How long the respondent has to file before anyone may rule. |
| 8 | `claim_period` | `604800` | How long the dispute stays adjudicable. |
| 9 | `min_bond` | `10000000000000000` | 0.01 GEN. The floor a filing must pay. A bond the docs call a deterrent and the contract does not enforce is not a deterrent. |

Fixed at construction. There are no admin setters — an arbiter whose thresholds
the deployer can move afterwards is an arbiter the deployer controls.

Then set on Bench:

```
GENLAYER_RPC_URL=https://studio-next.genlayer.com/api
GENLAYER_CHAIN=studio-next
GENLAYER_ARBITER_ADDRESS=0x…
GENLAYER_MARKETPLACE_DOMAIN=bench-bnb.vercel.app
BENCH_PUBLIC_WEB_URL=https://bench-bnb.vercel.app
```

`GENLAYER_MARKETPLACE_DOMAIN` is a **disclosure about Bench's own interest**,
which is why it is configured rather than derived from a request header a caller
controls. `BENCH_PUBLIC_WEB_URL` is where the action record is published;
validators fetch it from outside the process, so a localhost origin makes every
breach dispute unresolvable.

Without an RPC and an address the dispute layer reports itself unavailable,
every write refuses, and the hire page says so in as many words. That is the
intended behaviour of an unconfigured deployment, not a degraded one.

### A hire is keyed on the address that registered it

`register_hire` stores under `<registrar>/<hireId>`, not under the bare id, and
refuses a key that does not begin with the caller's own address.

Registration has to be open to anyone: the party holding both halves of a hire
at the moment it is created is the marketplace, which is neither the client nor
the respondent. Keyed on the bare id, whoever learned an id first could register
it, name themselves client, and leave the real client permanently unable to open
a dispute — `hire already registered`, for ever, with no way to correct it.
Bench's ids are opaque, so that attack needs a guess, and resting access control
on an id being hard to guess is not a guarantee this codebase builds on.

Bench's adapter forms the key from its signing key's own address. A deployment
that reads disputes without holding a key must set
`GENLAYER_REGISTRAR_ADDRESS`, because a reader that cannot name the registrar
cannot name a hire — and it refuses to start rather than answering every lookup
with an empty list, which would render a live dispute as no dispute.

---

## What this does not claim

- **It is not deployed by this repository.** The contract builds, lints as one
  contract class, and passes 91 tests; an address on a live network is a
  separate act and this document does not pretend to one.
- **`register_hire` is called by Bench**, because Bench is the party holding both
  halves at hire time. `registered_by` is a public view for exactly that reason,
  and a hire registered by neither party nor the marketplace is worth a second
  look.
- **The ERC-20 blind spot is real.** The interceptor records `to`, `value` and
  `data`; `value` is always the native token, so a token transfer is a
  zero-value call whose amount lives inside `data`. A mandate denominated in a
  token whose transfers this cannot decode is bounded by its allowlist and its
  action limit, not by its spend caps. Such a complaint belongs on `DELIVERY`,
  where a model can read a block explorer.
- **A model is still a model.** `DELIVERY` rulings carry a confidence and a
  floor, and the honest reading of one is "this is what a majority of validators
  concluded from these documents", not "this is what happened".
