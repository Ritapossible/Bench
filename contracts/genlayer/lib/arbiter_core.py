# NOT AN INTELLIGENT CONTRACT -- build input for contracts/genlayer/arbiter.py.
#
# Declares no `gl.Contract` and imports no GenLayer SDK. `genvm-lint` against
# this file reports E105 (No contract class found), correctly.
"""Deterministic engine for the Arbiter: screening, replay, coercion, settlement.

Nothing here touches the network or a model. Everything is a pure function over
plain values, which is what makes the interesting parts testable without a chain
-- and the interesting parts are the replay and the consensus comparison, not
the plumbing.

**The replay is a second implementation of a rulebook that already exists** in
`packages/core/src/types/dispute.ts`, and that is a deliberate, uncomfortable
choice. The alternative is asking Bench for the answer, and Bench lists the
agent, ranks it and takes a cut of the hire: a marketplace that adjudicates
disputes about its own listings is marking its own homework. So the rule runs
here, where neither party controls it.

Duplication without a conformance check is how two implementations drift until
one of them quietly becomes wrong. `tests/vectors.json` is generated from the
TypeScript and asserted by both suites; a change to either rulebook that the
other does not follow fails on both sides.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass

# --- error classification -------------------------------------------------

# Validators reach consensus on failures as well as successes, so a raised
# message carries a class prefix naming the comparison rule.
ERROR_EXPECTED = "[EXPECTED]"  # deterministic business logic -- must match exactly
ERROR_EXTERNAL = "[EXTERNAL]"  # external 4xx, deterministic -- must match exactly
ERROR_TRANSIENT = "[TRANSIENT]"  # network/5xx, nondeterministic -- both agree
ERROR_LLM = "[LLM_ERROR]"  # model misbehavior -- always disagree, force rotation

ERROR_PREFIXES = (ERROR_EXPECTED, ERROR_EXTERNAL, ERROR_TRANSIENT, ERROR_LLM)

# --- grounds --------------------------------------------------------------

# Which question the arbiter is being asked, and what it costs to answer.
#
#   BREACH    "it did something it was not allowed to do"
#             -> replay the signed terms over the recorded actions.
#                Zero model calls. Arithmetic. Nothing to argue with.
#   DELIVERY  "it did not do the job"
#             -> one model call over evidence both parties pinned.
#
# Prefer BREACH wherever the complaint can be phrased as a rule the mandate
# already carries: it is free, deterministic, and a reviewer can recompute it
# from the stored terms and the stored actions with no network and no model.
GROUND_BREACH = "BREACH"
GROUND_DELIVERY = "DELIVERY"
GROUNDS = (GROUND_BREACH, GROUND_DELIVERY)

# --- states ---------------------------------------------------------------

# ANSWERABLE and ADJUDICABLE are deliberately not stored. Each is OPEN plus the
# passage of time, and storing derived state means a value that only becomes
# true when somebody remembers to write it.
STATE_OPEN = "OPEN"
STATE_UPHELD = "UPHELD"
STATE_DISMISSED = "DISMISSED"
STATE_ABSTAINED = "ABSTAINED"

TERMINAL_STATES = (STATE_UPHELD, STATE_DISMISSED, STATE_ABSTAINED)

# --- rulings and criterion statuses ---------------------------------------

RULING_UPHELD = "upheld"
RULING_DISMISSED = "dismissed"
RULING_UNRESOLVED = "unresolved"
RULINGS = (RULING_UPHELD, RULING_DISMISSED, RULING_UNRESOLVED)

CRIT_MET = "met"
CRIT_UNMET = "unmet"
CRIT_UNRESOLVED = "unresolved"
CRIT_STATUSES = (CRIT_MET, CRIT_UNMET, CRIT_UNRESOLVED)

RESOLVED_REPLAY = "replay"
RESOLVED_MODEL = "model"

# --- evidence origin ------------------------------------------------------

# MARKETPLACE is its own category rather than part of INDEPENDENT, and that is
# the single most load-bearing line in this file. Bench is not a bystander to a
# dispute about a Bench hire: it listed the agent, it ranked it, and it takes a
# cut. Its API is the most convenient evidence available and the least
# independent, and a tally that hid that would flatter every ruling made on it.
ORIGIN_INDEPENDENT = "independent"
ORIGIN_CLAIMANT = "claimant"
ORIGIN_RESPONDENT = "respondent"
ORIGIN_MARKETPLACE = "marketplace"
ORIGIN_UNCLASSIFIED = "unclassified"
ORIGINS = (
    ORIGIN_INDEPENDENT,
    ORIGIN_CLAIMANT,
    ORIGIN_RESPONDENT,
    ORIGIN_MARKETPLACE,
    ORIGIN_UNCLASSIFIED,
)

# --- reason codes ---------------------------------------------------------

# Stable strings so a caller can distinguish "not yet due" from "already
# settled" without matching on prose.
REASON_NOT_FOUND = "dispute not found"
REASON_SETTLED = "already settled"
REASON_ANSWER_WINDOW_OPEN = "respondent may still answer"
REASON_WINDOW_CLOSED = "claim window has closed"
REASON_NO_CRITERIA = "no criteria to rule on"
REASON_NO_SOURCES = "no evidence to read"
REASON_NOT_RESPONDENT = "only the respondent may answer"
REASON_ANSWER_WINDOW_CLOSED = "answer window has closed"
REASON_HIRE_NOT_FOUND = "hire not registered"
REASON_HIRE_EXISTS = "hire already registered"
REASON_NOT_CLIENT = "only the client may open a dispute"
REASON_TERMS_MISMATCH = "terms do not match the digest recorded at hire time"
REASON_NO_TERMS = "adjudicating a breach needs the terms it was hired under"
REASON_BAD_HIRE_KEY = "hire_id must be prefixed with the registrant's own address"
REASON_BOND_TOO_SMALL = "filing bond is below the minimum"

U256_MAX = (1 << 256) - 1


@dataclass(frozen=True)
class Limits:
    """Construction-time bounds. Fixed forever; there are no admin setters."""

    max_sources: int
    max_source_bytes: int
    min_confidence: int
    confidence_tol: int
    max_extensions: int
    extension_period: int
    answer_period: int
    min_bond: int


@dataclass(frozen=True)
class Screen:
    ok: bool
    reason: str = ""


# --- text handling --------------------------------------------------------


def normalize(body: str) -> str:
    """Collapse the differences two nodes will see fetching the same page.

    Whitespace runs and line endings differ between CDN edges for reasons that
    have nothing to do with content. Normalizing before digesting is what makes
    a digest comparison survive a page being served from two places at once.
    """
    return re.sub(r"\s+", " ", body.replace("\r\n", "\n")).strip()


def clip(body: str, limit: int) -> str:
    return body if len(body) <= limit else body[:limit]


def digest(body: str) -> str:
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def canonical_json(value: object) -> str:
    """One byte string per value, so a digest of it means something.

    Sorted keys and no spaces: two encoders that disagree about either would
    produce different digests for the same terms, and the whole point of
    pinning the terms is that neither party can restate them later.
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def terms_digest(terms: object) -> str:
    return digest(canonical_json(terms))


# --- evidence classification ---------------------------------------------


def _host_of(url: str) -> str | None:
    """Hostname of an https URL, or None for anything this will not read.

    Deliberately strict and hand-rolled: the contract runtime has no URL
    parser worth trusting with adversarial input, and everything this rejects
    is something a party should not be citing anyway. Userinfo is refused
    outright -- `https://evidence.example@attacker.test/` reads as the former
    and fetches from the latter.
    """
    if not isinstance(url, str):
        return None
    if not url.startswith("https://"):
        return None
    rest = url[len("https://") :]
    authority = rest.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
    if "@" in authority:
        return None
    host = authority.split(":", 1)[0].lower().rstrip(".")
    if host == "" or " " in host:
        return None
    return host


def covers(domain: str, host: str) -> bool:
    """`a.example` is covered by `example`; `notexample.com` is not by `example.com`."""
    d = (domain or "").strip().lower().lstrip(".")
    if d == "":
        return False
    return host == d or host.endswith("." + d)


def classify_source(url: str, domains: dict) -> str:
    """Where one evidence URL comes from, relative to the people arguing.

    A host comparison, not an opinion, which is what makes the tally worth
    showing: it requires no trust in the contract's judgment and anyone can
    recompute it from the URLs alone.

    The marketplace is tested first. Bench hosting a party's page does not make
    that page independent of Bench.
    """
    host = _host_of(url)
    if host is None:
        return ORIGIN_UNCLASSIFIED
    if covers(str(domains.get("marketplace", "")), host):
        return ORIGIN_MARKETPLACE
    if covers(str(domains.get("claimant", "")), host):
        return ORIGIN_CLAIMANT
    if covers(str(domains.get("respondent", "")), host):
        return ORIGIN_RESPONDENT
    return ORIGIN_INDEPENDENT


def independence(origins: list) -> dict:
    tally = {o: 0 for o in ORIGINS}
    for origin in origins:
        key = origin if origin in tally else ORIGIN_UNCLASSIFIED
        tally[key] += 1
    return tally


def has_independent_evidence(tally: dict) -> bool:
    return int(tally.get(ORIGIN_INDEPENDENT, 0)) > 0


def hire_key(registrar: str, hire_id: str) -> str:
    """The storage key for a registration: the registrant, then the id.

    **A hire id alone cannot be the key.** `register_hire` is open to anyone -
    it has to be, because the party holding both halves of a hire at the moment
    it is created is the marketplace, which is neither the client nor the
    respondent. Keyed on the bare id, anyone who learned an id before Bench
    registered it could register it first, name themselves client, and leave the
    real client permanently unable to open a dispute: `REASON_HIRE_EXISTS` for
    ever, with no way to correct it.

    Bench's hire ids are opaque, so that attack needs a guess. Resting an
    access-control property on an id being hard to guess is exactly the kind of
    weak guarantee this codebase does not build on. Prefixing the id with the
    registrant's own address removes the race entirely: two registrars cannot
    collide, the key says who registered it, and no caller needs a second
    argument to look one up.
    """
    return f"{registrar.lower()}/{hire_id}"


def screen_hire_key(key: str, sender: str) -> Screen:
    """A registration key must name the account presenting it."""
    prefix = f"{sender.lower()}/"
    if not isinstance(key, str) or not key.startswith(prefix) or len(key) <= len(prefix):
        return Screen(False, REASON_BAD_HIRE_KEY)
    return Screen(True)


def registrar_of(key: str) -> str:
    """Who registered a hire, read straight off its key."""
    return key.split("/", 1)[0] if "/" in key else ""


# --- the replay -----------------------------------------------------------

# Rule names. These are the strings `packages/core` uses; the conformance
# vectors compare them, so a rename on either side has to happen on both.
MANDATE_RULES = (
    "revoked",
    "expired",
    "per-tx-cap-exceeded",
    "total-cap-exceeded",
    "contract-not-allowlisted",
    "action-limit-reached",
    "wrong-token",
)
ENVELOPE_RULES = (
    "unseen-recipient",
    "unseen-call",
    "value-exceeds-observed",
    "cumulative-value-exceeds-observed",
    "action-count-exceeds-observed",
    "position-drop-exceeds-observed",
)


def _selector_of(data: str) -> str:
    """First four bytes of calldata. A bare value transfer contributes '0x'."""
    if not isinstance(data, str):
        return "0x"
    return data[:10].lower() if len(data) >= 10 else "0x"


def _value_ceiling(value: int, bps: int) -> int:
    """Headroom over an observed value maximum.

    Floor division, matching the TypeScript, which does this in BigInt and
    therefore truncates. The two rulebooks must round identically or a hire
    lands on the boundary and the chain and the marketplace disagree about
    whether it breached.
    """
    return (value * (10_000 + bps)) // 10_000


def _action_ceiling(count: int, bps: int) -> int:
    """Headroom over an observed action count.

    Rounds *up*, unlike `_value_ceiling`, and the asymmetry is inherited rather
    than chosen: the TypeScript computes this one in floating point and calls
    `Math.ceil`. Three observed actions at 50% tolerance is a ceiling of five
    there and would be four here under floor division - so a four-action hire
    would pass Bench's gate and be found in breach by the chain. Copied
    deliberately, and the conformance vectors pin it.
    """
    numerator = count * (10_000 + bps)
    return -((-numerator) // 10_000)


def _lower_set(values) -> set:
    return {str(v).lower() for v in (values or [])}


def replay_actions(actions: list, terms: dict, revoked_at=None) -> dict:
    """Replay a hire's recorded actions against the terms it was hired under.

    This is Bench's signing gate, run backwards. The same two checks that decide
    whether a transaction may be signed decide, over the sequence that actually
    happened, whether one should have been.

    `terms` is the structure digest-pinned at hire time, so neither party can
    restate the rules once the hire has gone wrong:

        {"mandate": {"total_cap": int, "per_tx_cap": int, "allowlist": [str],
                     "expires_at": int, "max_actions": int, "token": str},
         "envelope": {"recipients": [str], "selectors": [str],
                      "max_single_value": int, "max_cumulative_value": int,
                      "max_action_count": int, "sample_size": int},
         "policy": {"value_tolerance_bps": int, "action_tolerance_bps": int,
                    "require_known_recipient": bool,
                    "require_known_selector": bool}}

    Each action is judged by the clock when it happened. A mandate that has
    since expired did not expire retroactively over transactions sent while it
    was live, and judging the record against the clock at adjudication would
    find a breach in every hire that ever ran to completion.

    State advances whether or not an action broke a rule, because it happened.
    A replay that skipped spend on a refused action would under-count the total
    and clear a hire that blew its cap on the transaction after the first one
    that went wrong.
    """
    mandate = dict(terms.get("mandate") or {})
    envelope = dict(terms.get("envelope") or {})
    policy = dict(terms.get("policy") or {})

    total_cap = int(mandate.get("total_cap", 0))
    per_tx_cap = int(mandate.get("per_tx_cap", 0))
    allowlist = _lower_set(mandate.get("allowlist"))
    expires_at = int(mandate.get("expires_at", 0))
    max_actions = int(mandate.get("max_actions", 0))
    mandate_token = str(mandate.get("token", "")).lower()
    # Terms first, then the published record.
    #
    # **Revocation cannot live in the pinned terms in practice.** Terms are
    # digest-pinned at hire time, before anyone knows there will be a dispute;
    # revocation happens afterwards. A `revoked_at` inside the digest would
    # therefore be absent for every real hire, and spending past the kill switch
    # - the breach a hirer is angriest about - would be unprovable.
    #
    # So it travels in the action record, which is fetched rather than pinned,
    # and is held to the same standard as the rest of the record: every
    # published copy must agree or the dispute goes unresolved. The terms still
    # win where they carry one, because a pinned value is stronger than a
    # fetched one and the conformance vectors pin it.
    pinned_revocation = mandate.get("revoked_at")
    revoked_at = pinned_revocation if pinned_revocation is not None else revoked_at

    recipients = _lower_set(envelope.get("recipients"))
    selectors = _lower_set(envelope.get("selectors"))
    max_single = int(envelope.get("max_single_value", 0))
    max_cumulative = int(envelope.get("max_cumulative_value", 0))
    max_action_count = int(envelope.get("max_action_count", 0))
    sample_size = int(envelope.get("sample_size", 0))

    value_tol = int(policy.get("value_tolerance_bps", 0))
    action_tol = int(policy.get("action_tolerance_bps", 0))
    require_recipient = bool(policy.get("require_known_recipient", True))
    require_selector = bool(policy.get("require_known_selector", True))

    ordered = sorted(
        [a for a in (actions or []) if isinstance(a, dict)],
        key=lambda a: int(a.get("seq", 0)),
    )

    findings = []
    spent = 0
    action_count = 0

    for entry in ordered:
        seq = int(entry.get("seq", 0))
        when = int(entry.get("at", 0))
        raw_to = entry.get("to")
        to = str(raw_to).lower() if raw_to else None
        value = int(entry.get("value", 0))
        data = str(entry.get("data", "0x"))
        token = str(entry.get("token", mandate_token) or mandate_token).lower()

        def add(rule: str) -> None:
            findings.append({"rule": rule, "seq": seq})

        # --- authorization: the bounds the owner signed
        if revoked_at is not None and when >= int(revoked_at):
            add("revoked")
        if expires_at and when >= expires_at:
            add("expired")
        if mandate_token and token != mandate_token:
            add("wrong-token")
        if value > per_tx_cap:
            add("per-tx-cap-exceeded")
        if spent + value > total_cap:
            add("total-cap-exceeded")
        if action_count + 1 > max_actions:
            add("action-limit-reached")
        if to is None or to not in allowlist:
            add("contract-not-allowlisted")

        # --- behaviour: the bounds the agent earned in audition
        if require_recipient and to is not None and to not in recipients:
            add("unseen-recipient")
        if require_selector and _selector_of(data) not in selectors:
            add("unseen-call")
        if value > _value_ceiling(max_single, value_tol):
            add("value-exceeds-observed")
        if spent + value > _value_ceiling(max_cumulative, value_tol):
            add("cumulative-value-exceeds-observed")
        if action_count + 1 > _action_ceiling(max_action_count, action_tol):
            add("action-count-exceeds-observed")

        spent += value
        action_count += 1

    return {
        "findings": findings,
        "envelope_advisory": sample_size < 3,
        "actions_considered": len(ordered),
    }


def binding_findings(audit: dict) -> list:
    """Which findings can settle a dispute on their own.

    Mandate rules can: the owner signed those bounds and the agent accepted
    them. Envelope rules cannot while the envelope is advisory -- an envelope
    built from fewer than three auditions describes one run's habits rather than
    an agent's behaviour, and upholding on it would punish an agent for doing
    something slightly different the first time. They are still reported.
    """
    findings = list(audit.get("findings") or [])
    if not audit.get("envelope_advisory"):
        return findings
    return [f for f in findings if f.get("rule") in MANDATE_RULES]


# --- ruling ---------------------------------------------------------------


def apply_confidence_floor(readings: list, min_confidence: int) -> list:
    """Downgrade a low-confidence accusation. Never a low-confidence clearance.

    The asymmetry is the point. Upholding takes money from a party that may have
    delivered, so it needs conviction. Dismissing leaves the escrow to settle
    exactly as the parties already agreed it would, so it does not.
    """
    out = []
    for r in readings:
        status = r.get("status")
        confidence = int(r.get("confidence", 0))
        if status == CRIT_UNMET and confidence < min_confidence:
            out.append({**r, "status": CRIT_UNRESOLVED})
        else:
            out.append(dict(r))
    return out


def derive_ruling(statuses: list) -> str:
    """Turn per-criterion readings into a ruling, by fixed rule.

    The model reads; this rules. Separating them is what makes prompt injection
    pointless: the prompt is never told a dispute exists, never told money moves,
    and never given the word "upheld" to aim at. Text inside a fetched page has
    no lever to pull because no lever appears in the prompt.

    One `unmet` upholds -- the claimant only has to be right about one thing.
    All `met` dismisses. Everything else is `unresolved`, which is the direction
    ambiguity must fall: an unresolved dispute extends and costs nobody
    anything, while a wrong ruling in either direction moves money that does not
    come back.
    """
    if not statuses:
        return RULING_UNRESOLVED
    if CRIT_UNMET in statuses:
        return RULING_UPHELD
    if all(s == CRIT_MET for s in statuses):
        return RULING_DISMISSED
    return RULING_UNRESOLVED


def ruling_from_replay(audit: dict) -> str:
    """The deterministic ground's ruling. No model, no confidence, no doubt.

    An empty action record is `unresolved`, not `dismissed`. Nothing was read,
    so nothing was cleared -- and a hire whose record could not be fetched is
    exactly the case where an interested party benefits from a confident answer.
    """
    if int(audit.get("actions_considered", 0)) == 0:
        return RULING_UNRESOLVED
    return RULING_UPHELD if binding_findings(audit) else RULING_DISMISSED


def settle(ruling: str, extensions: int, limits: Limits) -> tuple:
    """(next_state, extend). The only place a ruling becomes a state.

    An `unresolved` ruling extends the window rather than settling, up to
    `max_extensions`; after that the arbiter abstains. `ABSTAINED` is
    deliberately not a synonym for `DISMISSED`: the escrow's own optimistic
    default then applies and money moves as it would have without a dispute, but
    the record says the arbiter could not decide rather than that the agent was
    cleared, and both parties' histories carry that difference.
    """
    if ruling == RULING_UPHELD:
        return (STATE_UPHELD, False)
    if ruling == RULING_DISMISSED:
        return (STATE_DISMISSED, False)
    if extensions < limits.max_extensions:
        return (STATE_OPEN, True)
    return (STATE_ABSTAINED, False)


# --- screening ------------------------------------------------------------


def screen_registration(exists: bool, client: str, sender: str) -> Screen:
    if exists:
        return Screen(False, REASON_HIRE_EXISTS)
    if not client or not sender:
        return Screen(False, REASON_HIRE_NOT_FOUND)
    return Screen(True)


def screen_open(hire_exists: bool, client: str, sender: str) -> Screen:
    if not hire_exists:
        return Screen(False, REASON_HIRE_NOT_FOUND)
    if str(client).lower() != str(sender).lower():
        return Screen(False, REASON_NOT_CLIENT)
    return Screen(True)


def screen_answer(state: str, respondent: str, sender: str, now: int, answer_end: int) -> Screen:
    if state in TERMINAL_STATES:
        return Screen(False, REASON_SETTLED)
    if str(respondent).lower() != str(sender).lower():
        return Screen(False, REASON_NOT_RESPONDENT)
    if now >= answer_end:
        return Screen(False, REASON_ANSWER_WINDOW_CLOSED)
    return Screen(True)


def screen_adjudication(
    *,
    state: str,
    now: int,
    answer_end: int,
    window_end: int,
    criteria_count: int,
    source_count: int,
) -> Screen:
    """Stage 0. Storage and integers only -- no network, no model, no cost.

    The answer window is a hard gate, not a courtesy. A dispute adjudicated
    before the respondent has had its chance to file evidence is one where the
    claimant chose the whole evidence set, and the independence tally would show
    a clean sweep of claimant-origin sources while looking perfectly orderly.
    """
    if state in TERMINAL_STATES:
        return Screen(False, REASON_SETTLED)
    if now < answer_end:
        return Screen(False, REASON_ANSWER_WINDOW_OPEN)
    if now >= window_end:
        return Screen(False, REASON_WINDOW_CLOSED)
    if criteria_count <= 0:
        return Screen(False, REASON_NO_CRITERIA)
    if source_count <= 0:
        return Screen(False, REASON_NO_SOURCES)
    return Screen(True)


# --- verdict coercion -----------------------------------------------------


def encode_verdict(verdict: dict) -> str:
    return canonical_json(verdict)


def _coerce_reading(raw: object, allowed: frozenset) -> dict | None:
    if not isinstance(raw, dict):
        return None
    try:
        ident = int(raw.get("id"))
    except (TypeError, ValueError):
        return None
    if ident not in allowed:
        return None
    status = raw.get("status")
    if status not in CRIT_STATUSES:
        status = CRIT_UNRESOLVED
    try:
        confidence = int(raw.get("confidence", 0))
    except (TypeError, ValueError):
        confidence = 0
    confidence = max(0, min(100, confidence))
    return {"id": ident, "status": status, "confidence": confidence}


def canonicalize_verdict(raw: object, allowed: frozenset, limits: Limits) -> dict:
    """Total. Any input at all produces a well-formed verdict.

    A model answering with prose, an empty object, a list where a dict belongs,
    or ids for criteria that do not exist must not fault the contract -- a fault
    is an unclassified failure validators cannot compare, and it would be
    reachable by anyone who can write on a page the dispute cites.

    Every criterion the dispute declares gets an entry. Missing ones are
    `unresolved` at confidence zero, which is the truthful reading of an answer
    that did not mention them.
    """
    parsed: object = raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, TypeError, ValueError):
            parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}

    seen: dict = {}
    entries = parsed.get("criteria")
    if isinstance(entries, list):
        for entry in entries:
            reading = _coerce_reading(entry, allowed)
            if reading is not None and reading["id"] not in seen:
                seen[reading["id"]] = reading

    readings = [
        seen.get(i, {"id": i, "status": CRIT_UNRESOLVED, "confidence": 0})
        for i in sorted(allowed)
    ]
    readings = apply_confidence_floor(readings, limits.min_confidence)

    ruling = parsed.get("ruling")
    if ruling not in RULINGS:
        ruling = derive_ruling([r["status"] for r in readings])
    else:
        # A model is never asked for a ruling, so one appearing in its answer is
        # either an echo of injected text or a hallucination. Recompute it from
        # the readings either way: the contract rules, and the only thing the
        # model's opinion could do here is override that.
        ruling = derive_ruling([r["status"] for r in readings])

    resolved_by = parsed.get("resolved_by")
    if resolved_by not in (RESOLVED_REPLAY, RESOLVED_MODEL):
        resolved_by = RESOLVED_MODEL

    try:
        reachable = int(parsed.get("sources_reachable", 0))
    except (TypeError, ValueError):
        reachable = 0

    tally = parsed.get("evidence")
    if not isinstance(tally, dict):
        tally = {o: 0 for o in ORIGINS}
    else:
        tally = {o: int(tally.get(o, 0) or 0) for o in ORIGINS}

    return {
        "ruling": ruling,
        "criteria": readings,
        "resolved_by": resolved_by,
        "sources_reachable": max(0, reachable),
        "evidence": tally,
    }


def canonical_leader_verdict(raw: object, allowed: frozenset, limits: Limits) -> dict | None:
    """A validator's read of what the leader returned, or None if unreadable."""
    if raw is None:
        return None
    try:
        return canonicalize_verdict(raw, allowed, limits)
    except Exception:  # noqa: BLE001 - a validator must never fault on peer input
        return None


def verdicts_agree(mine: dict, theirs: dict, limits: Limits) -> bool:
    """What two validators must agree on for a dispute to settle.

    The structured ruling, never the fetched bytes. Two validators fetching one
    URL seconds apart routinely receive different bytes -- CDN edges, rotating
    banners, embedded timestamps -- and requiring byte agreement would fail
    constantly on pages telling both nodes exactly the same thing.

    Confidence is compared only where both readings already sit on the same side
    of the threshold. Two numbers straddling it disagree about the outcome, and
    a tolerance that spanned the boundary would let 74 and 76 ratify each other
    into opposite rulings.
    """
    if mine["ruling"] != theirs["ruling"]:
        return False
    if len(mine["criteria"]) != len(theirs["criteria"]):
        return False
    for a, b in zip(mine["criteria"], theirs["criteria"]):
        if a["id"] != b["id"] or a["status"] != b["status"]:
            return False
        floor = limits.min_confidence
        same_side = (a["confidence"] >= floor) == (b["confidence"] >= floor)
        if not same_side:
            return False
        if abs(a["confidence"] - b["confidence"]) > limits.confidence_tol:
            return False
    return True


def dispute_salt(dispute_id: int, terms_hash: str) -> str:
    """Per-dispute fence material an evidence page author cannot predict."""
    return digest(f"{dispute_id}\x1f{terms_hash}")
