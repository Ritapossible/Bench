"""The deterministic engine: screening, settlement, coercion, consensus.

The replay is covered by `test_vectors.py`, against the TypeScript. This file
covers everything the vectors cannot: the parts that have no counterpart in
Bench because they exist only on-chain - what a validator will ratify, what a
hostile model answer does, and which way each ambiguity falls.
"""

from __future__ import annotations

import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "lib"))

from arbiter_core import (  # noqa: E402
    CRIT_MET,
    CRIT_UNMET,
    CRIT_UNRESOLVED,
    GROUND_BREACH,
    GROUND_DELIVERY,
    ORIGIN_CLAIMANT,
    ORIGIN_INDEPENDENT,
    ORIGIN_MARKETPLACE,
    ORIGIN_RESPONDENT,
    ORIGIN_UNCLASSIFIED,
    REASON_ANSWER_WINDOW_OPEN,
    REASON_BAD_HIRE_KEY,
    REASON_HIRE_NOT_FOUND,
    REASON_NOT_CLIENT,
    REASON_NOT_RESPONDENT,
    REASON_SETTLED,
    REASON_WINDOW_CLOSED,
    RULING_DISMISSED,
    RULING_UNRESOLVED,
    RULING_UPHELD,
    STATE_ABSTAINED,
    STATE_DISMISSED,
    STATE_OPEN,
    STATE_UPHELD,
    Limits,
    apply_confidence_floor,
    canonical_json,
    canonical_leader_verdict,
    canonicalize_verdict,
    classify_source,
    replay_actions,
    derive_ruling,
    dispute_salt,
    has_independent_evidence,
    hire_key,
    independence,
    registrar_of,
    screen_adjudication,
    screen_answer,
    screen_hire_key,
    screen_open,
    settle,
    terms_digest,
    verdicts_agree,
)

LIMITS = Limits(
    max_sources=6,
    max_source_bytes=200_000,
    min_confidence=75,
    confidence_tol=15,
    max_extensions=2,
    extension_period=86_400,
    answer_period=86_400,
    min_bond=10_000_000_000_000_000,
)

DOMAINS = {
    "claimant": "client.example",
    "respondent": "agent.example",
    "marketplace": "bench-bnb.vercel.app",
}


# --- evidence classification ---------------------------------------------


def test_the_marketplace_is_not_an_independent_source() -> None:
    """The single most load-bearing line in the engine.

    Bench listed the agent, ranked it and takes a cut. Its API is the most
    convenient evidence in any Bench dispute and the least disinterested, and
    folding it into `independent` would flatter every ruling made on it.
    """
    assert classify_source("https://bench-bnb.vercel.app/api/runs/1", DOMAINS) == (
        ORIGIN_MARKETPLACE
    )
    assert classify_source("https://bscscan.com/tx/0xabc", DOMAINS) == ORIGIN_INDEPENDENT


def test_a_party_is_recognised_by_any_subdomain() -> None:
    assert classify_source("https://status.agent.example/up", DOMAINS) == ORIGIN_RESPONDENT
    assert classify_source("https://client.example/ticket", DOMAINS) == ORIGIN_CLAIMANT


def test_a_lookalike_domain_is_not_a_party() -> None:
    assert classify_source("https://notagent.example/x", DOMAINS) == ORIGIN_INDEPENDENT
    assert classify_source("https://agent.example.evil.test/x", DOMAINS) == ORIGIN_INDEPENDENT


def test_userinfo_cannot_disguise_a_host() -> None:
    """`https://evidence.example@attacker.test/` fetches from attacker.test.

    Reading as one host and fetching from another is how a party smuggles a
    page it controls past the independence tally, so the URL is refused rather
    than classified.
    """
    assert classify_source("https://agent.example@attacker.test/x", DOMAINS) == (
        ORIGIN_UNCLASSIFIED
    )


def test_plain_http_is_never_evidence() -> None:
    assert classify_source("http://agent.example/x", DOMAINS) == ORIGIN_UNCLASSIFIED
    assert classify_source("ftp://agent.example/x", DOMAINS) == ORIGIN_UNCLASSIFIED
    assert classify_source("not a url", DOMAINS) == ORIGIN_UNCLASSIFIED


def test_independence_tallies_what_a_ruling_rests_on() -> None:
    tally = independence(
        [ORIGIN_INDEPENDENT, ORIGIN_RESPONDENT, ORIGIN_RESPONDENT, ORIGIN_MARKETPLACE]
    )
    assert tally[ORIGIN_INDEPENDENT] == 1
    assert tally[ORIGIN_RESPONDENT] == 2
    assert has_independent_evidence(tally) is True

    assert has_independent_evidence(independence([ORIGIN_MARKETPLACE, ORIGIN_CLAIMANT])) is False


# --- screening ------------------------------------------------------------


def test_only_the_client_may_open_a_dispute() -> None:
    assert screen_open(True, "0xAbC", "0xabc").ok is True  # case-insensitive
    assert screen_open(True, "0xabc", "0xdef").reason == REASON_NOT_CLIENT


def test_only_the_respondent_may_answer_and_only_in_time() -> None:
    assert screen_answer(STATE_OPEN, "0xabc", "0xabc", 10, 100).ok is True
    assert screen_answer(STATE_OPEN, "0xabc", "0xdef", 10, 100).reason == REASON_NOT_RESPONDENT
    assert screen_answer(STATE_OPEN, "0xabc", "0xabc", 100, 100).ok is False
    assert screen_answer(STATE_UPHELD, "0xabc", "0xabc", 10, 100).reason == REASON_SETTLED


def test_adjudication_waits_for_the_respondent() -> None:
    """The gate that makes this a dispute layer rather than a complaints box.

    A ruling taken before the answer window closes is a ruling on an evidence
    set the claimant chose alone - and the independence tally would show a clean
    sweep of claimant-origin sources while looking perfectly orderly.
    """
    early = screen_adjudication(
        state=STATE_OPEN, now=50, answer_end=100, window_end=1000,
        criteria_count=1, source_count=1,
    )
    assert early.reason == REASON_ANSWER_WINDOW_OPEN

    ready = screen_adjudication(
        state=STATE_OPEN, now=150, answer_end=100, window_end=1000,
        criteria_count=1, source_count=1,
    )
    assert ready.ok is True


def test_adjudication_refuses_a_settled_or_lapsed_dispute() -> None:
    settled = screen_adjudication(
        state=STATE_DISMISSED, now=150, answer_end=100, window_end=1000,
        criteria_count=1, source_count=1,
    )
    assert settled.reason == REASON_SETTLED

    lapsed = screen_adjudication(
        state=STATE_OPEN, now=2000, answer_end=100, window_end=1000,
        criteria_count=1, source_count=1,
    )
    assert lapsed.reason == REASON_WINDOW_CLOSED


# --- settlement -----------------------------------------------------------


def test_an_unresolved_ruling_extends_before_it_abstains() -> None:
    assert settle(RULING_UNRESOLVED, 0, LIMITS) == (STATE_OPEN, True)
    assert settle(RULING_UNRESOLVED, 1, LIMITS) == (STATE_OPEN, True)
    assert settle(RULING_UNRESOLVED, 2, LIMITS) == (STATE_ABSTAINED, False)


def test_abstained_is_not_a_synonym_for_dismissed() -> None:
    """The distinction both parties' histories depend on.

    After abstention the escrow's own optimistic default applies and money moves
    as it would have without a dispute - but the record says the arbiter could
    not decide, not that the agent was cleared. Collapsing the two would let a
    respondent bank an exoneration it never received.
    """
    assert settle(RULING_UNRESOLVED, 99, LIMITS)[0] == STATE_ABSTAINED
    assert settle(RULING_DISMISSED, 0, LIMITS)[0] == STATE_DISMISSED
    assert STATE_ABSTAINED != STATE_DISMISSED


def test_a_decided_ruling_never_extends() -> None:
    assert settle(RULING_UPHELD, 0, LIMITS) == (STATE_UPHELD, False)
    assert settle(RULING_DISMISSED, 0, LIMITS) == (STATE_DISMISSED, False)


# --- ruling ---------------------------------------------------------------


def test_one_unmet_criterion_upholds() -> None:
    assert derive_ruling([CRIT_MET, CRIT_UNMET]) == RULING_UPHELD
    assert derive_ruling([CRIT_MET, CRIT_MET]) == RULING_DISMISSED
    assert derive_ruling([CRIT_MET, CRIT_UNRESOLVED]) == RULING_UNRESOLVED
    assert derive_ruling([]) == RULING_UNRESOLVED


def test_the_confidence_floor_is_deliberately_one_sided() -> None:
    """Upholding takes money from a party that may have delivered.

    Dismissing leaves the escrow to settle exactly as the parties already agreed
    it would. Only the first needs conviction, and applying the floor to both
    would let a hesitant model clear an agent it was unsure about.
    """
    readings = apply_confidence_floor(
        [
            {"id": 1, "status": CRIT_UNMET, "confidence": 50},
            {"id": 2, "status": CRIT_MET, "confidence": 50},
        ],
        LIMITS.min_confidence,
    )
    assert readings[0]["status"] == CRIT_UNRESOLVED
    assert readings[1]["status"] == CRIT_MET


# --- coercion -------------------------------------------------------------


def test_canonicalization_is_total() -> None:
    """Any answer at all must produce a well-formed verdict.

    A fault here is an unclassified VM failure validators cannot compare, and it
    would be reachable by anyone able to write on a page the dispute cites.
    """
    allowed = frozenset({1, 2})
    for hostile in (
        "not json at all",
        "",
        "[]",
        '{"criteria": "a string"}',
        '{"criteria": [null, 7, {"id": "x"}]}',
        "{}",
        None,
        12345,
    ):
        out = canonicalize_verdict(hostile, allowed, LIMITS)
        assert [c["id"] for c in out["criteria"]] == [1, 2]
        assert out["ruling"] in (RULING_UPHELD, RULING_DISMISSED, RULING_UNRESOLVED)


def test_a_criterion_the_model_ignored_is_unresolved_not_met() -> None:
    out = canonicalize_verdict(
        '{"criteria": [{"id": 1, "status": "met", "confidence": 99}]}',
        frozenset({1, 2}),
        LIMITS,
    )
    assert out["criteria"][1] == {"id": 2, "status": CRIT_UNRESOLVED, "confidence": 0}
    assert out["ruling"] == RULING_UNRESOLVED


def test_ids_outside_the_dispute_are_discarded() -> None:
    """A model citing criterion 9 of a two-criterion dispute is answering a
    question nobody asked, and the likeliest source of the number is text on a
    page one of the parties controls."""
    out = canonicalize_verdict(
        '{"criteria": [{"id": 9, "status": "unmet", "confidence": 100},'
        ' {"id": 1, "status": "met", "confidence": 90}]}',
        frozenset({1}),
        LIMITS,
    )
    assert [c["id"] for c in out["criteria"]] == [1]
    assert out["ruling"] == RULING_DISMISSED


def test_a_ruling_in_the_model_answer_is_ignored() -> None:
    """The model is never asked for one, so a ruling appearing in its answer is
    an echo of injected text or a hallucination. Either way the contract rules.
    """
    out = canonicalize_verdict(
        '{"ruling": "upheld", "criteria": [{"id": 1, "status": "met", "confidence": 95}]}',
        frozenset({1}),
        LIMITS,
    )
    assert out["ruling"] == RULING_DISMISSED


def test_confidence_is_clamped() -> None:
    out = canonicalize_verdict(
        '{"criteria": [{"id": 1, "status": "unmet", "confidence": 10000}]}',
        frozenset({1}),
        LIMITS,
    )
    assert out["criteria"][0]["confidence"] == 100


def test_a_duplicate_id_keeps_the_first_reading() -> None:
    out = canonicalize_verdict(
        '{"criteria": [{"id": 1, "status": "met", "confidence": 90},'
        ' {"id": 1, "status": "unmet", "confidence": 99}]}',
        frozenset({1}),
        LIMITS,
    )
    assert out["criteria"][0]["status"] == CRIT_MET


def test_a_validator_never_faults_on_peer_input() -> None:
    assert canonical_leader_verdict(None, frozenset({1}), LIMITS) is None
    assert canonical_leader_verdict("garbage", frozenset({1}), LIMITS) is not None


# --- consensus ------------------------------------------------------------


def _verdict(status: str, confidence: int) -> dict:
    return canonicalize_verdict(
        {"criteria": [{"id": 1, "status": status, "confidence": confidence}]},
        frozenset({1}),
        LIMITS,
    )


def test_validators_agree_on_the_ruling_not_the_bytes() -> None:
    assert verdicts_agree(_verdict(CRIT_MET, 90), _verdict(CRIT_MET, 95), LIMITS) is True


def test_confidence_tolerance_does_not_span_the_threshold() -> None:
    """74 and 76 are two points apart and mean opposite things.

    A tolerance applied across the floor would let them ratify each other into
    different rulings, which is the one disagreement consensus exists to catch.
    """
    below = _verdict(CRIT_UNMET, 74)  # floored to unresolved
    above = _verdict(CRIT_UNMET, 76)  # stands as unmet
    assert below["ruling"] == RULING_UNRESOLVED
    assert above["ruling"] == RULING_UPHELD
    assert verdicts_agree(below, above, LIMITS) is False


def test_a_wide_confidence_gap_on_the_same_side_still_disagrees() -> None:
    assert verdicts_agree(_verdict(CRIT_MET, 80), _verdict(CRIT_MET, 99), LIMITS) is False


def test_different_rulings_never_agree() -> None:
    assert verdicts_agree(_verdict(CRIT_MET, 90), _verdict(CRIT_UNMET, 90), LIMITS) is False


# --- digests --------------------------------------------------------------


def test_terms_digest_ignores_key_order_and_whitespace() -> None:
    """Two encoders disagreeing about formatting would produce different digests
    for identical terms, and the failure would look like tampering."""
    a = {"mandate": {"total_cap": 1, "per_tx_cap": 2}, "policy": {}}
    b = {"policy": {}, "mandate": {"per_tx_cap": 2, "total_cap": 1}}
    assert terms_digest(a) == terms_digest(b)
    assert canonical_json(a) == canonical_json(b)


def test_terms_digest_changes_when_the_terms_do() -> None:
    a = {"mandate": {"total_cap": 1}}
    b = {"mandate": {"total_cap": 2}}
    assert terms_digest(a) != terms_digest(b)


def test_the_prompt_salt_is_per_dispute() -> None:
    assert dispute_salt(1, "abc") != dispute_salt(2, "abc")
    assert dispute_salt(1, "abc") != dispute_salt(1, "abd")
    assert dispute_salt(1, "abc") == dispute_salt(1, "abc")


def test_grounds_are_the_two_the_contract_knows() -> None:
    assert GROUND_BREACH == "BREACH"
    assert GROUND_DELIVERY == "DELIVERY"


# --- registration keys ----------------------------------------------------


def test_a_hire_id_must_name_the_account_registering_it() -> None:
    """Registration is open to anyone, so the key has to close the race.

    The party holding both halves of a hire when it is created is the
    marketplace, which is neither the client nor the respondent - so
    `register_hire` cannot be restricted to a party. Keyed on a bare id, anyone
    who learned an id first could claim it, name themselves client, and leave
    the real client permanently unable to open a dispute.

    Bench's ids are opaque, and "hard to guess" is not an access control.
    """
    assert screen_hire_key("0xabc/h_1", "0xABC").ok is True  # case-insensitive
    assert screen_hire_key("h_1", "0xabc").reason == REASON_BAD_HIRE_KEY
    assert screen_hire_key("0xdef/h_1", "0xabc").reason == REASON_BAD_HIRE_KEY
    # A prefix with nothing after it is not an id.
    assert screen_hire_key("0xabc/", "0xabc").ok is False
    assert screen_hire_key("", "0xabc").ok is False


def test_the_key_says_who_registered_the_hire() -> None:
    # `registered_by` is also a stored field, but reading it off the key means a
    # caller can tell before it fetches anything - and a hire registered by
    # neither party nor the marketplace is worth a second look.
    assert hire_key("0xBench", "h_1") == "0xbench/h_1"
    assert registrar_of(hire_key("0xBench", "h_1")) == "0xbench"
    assert registrar_of("no-slash") == ""


def test_two_registrars_cannot_collide_on_one_id() -> None:
    assert hire_key("0xaaa", "h_1") != hire_key("0xbbb", "h_1")


def test_revocation_may_arrive_with_the_record_rather_than_the_terms() -> None:
    """The kill switch has to be provable, and the pinned terms cannot carry it.

    Terms are digest-pinned at hire time, before anyone knows there will be a
    dispute. Revocation happens afterwards. So a `revoked_at` inside the digest
    is absent for every hire that has not yet gone wrong, and "it kept spending
    after I revoked" - the breach a hirer is angriest about - would be
    unprovable by construction.

    It rides in the published action record instead, held to the same standard
    as everything else in there: every published copy must agree, or the arbiter
    goes unresolved rather than ruling.
    """
    terms = {
        "mandate": {
            "total_cap": 10**18,
            "per_tx_cap": 10**18,
            "allowlist": ["0x" + "33" * 20],
            "expires_at": 2_000_000_000,
            "max_actions": 9,
            "token": "0x" + "55" * 20,
        },
        "envelope": {
            "recipients": ["0x" + "33" * 20],
            "selectors": ["0x38ed1739"],
            "max_single_value": 10**18,
            "max_cumulative_value": 10**18,
            "max_action_count": 9,
            "sample_size": 5,
        },
        "policy": {
            "value_tolerance_bps": 0,
            "action_tolerance_bps": 0,
            "require_known_recipient": True,
            "require_known_selector": True,
        },
    }
    actions = [
        {"seq": 1, "at": 1_000, "to": "0x" + "33" * 20, "value": 1, "data": "0x38ed1739"},
        {"seq": 2, "at": 3_000, "to": "0x" + "33" * 20, "value": 1, "data": "0x38ed1739"},
    ]

    # No revocation anywhere: a clean hire.
    assert replay_actions(actions, terms)["findings"] == []

    # Revoked between the two actions. The first stands, the second does not -
    # revocation is a moment, and a flag could only pick one answer for a hire
    # where both are true.
    found = replay_actions(actions, terms, 2_000)["findings"]
    assert found == [{"rule": "revoked", "seq": 2}]

    # A pinned revocation still wins: the conformance vectors carry one, and a
    # value in the digest is stronger evidence than a value that was fetched.
    pinned = dict(terms)
    pinned["mandate"] = {**terms["mandate"], "revoked_at": 500}
    assert {f["seq"] for f in replay_actions(actions, pinned, 2_000)["findings"]} == {1, 2}


def test_the_registrar_may_file_for_the_client_it_registered() -> None:
    """Otherwise nobody can file at all, which is not a theoretical concern.

    A marketplace hire is created by the marketplace, and the client it names is
    whatever identity that marketplace holds for its user. On Bench that is a
    per-browser id with no private key anywhere in the world, so requiring the
    client's own signature makes the remedy unreachable for every hire made
    through a front end that has not asked its user to connect a wallet - which
    today is every hire. The refusal was real and measured against the deployed
    contract: `only the client may open a dispute`, on a filing the client could
    not possibly have signed.
    """
    client, registrar, stranger = "0xc1", "0xreg", "0xbad"

    # The client still files for itself.
    assert screen_open(True, client, client, registrar).ok is True
    # And the registrar files on its behalf.
    assert screen_open(True, client, registrar, registrar).ok is True

    # Nobody else, registrar named or not. The widening admits one more address,
    # not anyone who asks.
    assert screen_open(True, client, stranger, registrar).reason == REASON_NOT_CLIENT
    assert screen_open(True, client, stranger).reason == REASON_NOT_CLIENT

    # Case-insensitive on both, because an address that differs only in checksum
    # casing is the same account.
    assert screen_open(True, "0xC1", "0xREG", "0xreg").ok is True

    # An empty registrar widens nothing. A hire whose key carries no prefix -
    # one registered before the key was namespaced - must not admit the empty
    # string as a caller.
    assert screen_open(True, client, "", "").reason == REASON_NOT_CLIENT

    # A hire nobody registered is still refused first, whoever is asking.
    assert screen_open(False, client, registrar, registrar).reason == REASON_HIRE_NOT_FOUND
