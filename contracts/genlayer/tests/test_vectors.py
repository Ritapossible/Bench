"""The Python replay must reproduce the TypeScript replay, case for case.

This file is the whole justification for implementing one rulebook twice.

The Arbiter cannot ask Bench whether an agent breached its mandate: Bench lists
the agent, ranks it on its own leaderboard and takes a cut of the hire, so a
ruling computed there is a marketplace grading its own listing. The rule
therefore runs on validators none of the parties control, which means a second
implementation, which means drift - unless something holds them together.

`tests/vectors.json` is generated from the TypeScript by
`tools/gen_vectors.mts` and asserted from both sides. A change to either
rulebook that the other does not follow fails here and in
`packages/core/test/dispute-vectors.test.ts`, in CI, before it can reach a
chain and start deciding disputes differently from the gate that let the
transactions through.

Two real mismatches were caught this way while the vectors were being written,
and both are now cases in the file: the action ceiling rounds up while the value
ceiling rounds down, and revocation is a moment in time rather than a flag.
"""

from __future__ import annotations

import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "lib"))

from arbiter_core import (  # noqa: E402
    MANDATE_RULES,
    binding_findings,
    hire_key,
    registrar_of,
    replay_actions,
    ruling_from_replay,
    terms_digest,
    RULING_DISMISSED,
    RULING_UNRESOLVED,
    RULING_UPHELD,
)

VECTORS = pathlib.Path(__file__).resolve().parent / "vectors.json"


def _load() -> dict:
    if not VECTORS.exists():  # pragma: no cover - a checkout without the file
        pytest.fail(
            f"{VECTORS.name} is missing. Generate it with "
            "`npx tsx contracts/genlayer/tools/gen_vectors.mts`."
        )
    data = json.loads(VECTORS.read_text(encoding="utf-8"))
    assert data["version"] == 1, "vector format changed; update both readers"
    return data


_DATA = _load()
CASES = _DATA["cases"]
KEY_CASES = _DATA["keys"]


def _normalize(terms: dict) -> dict:
    """Integers arrive as strings so JSON cannot lose a wei of precision."""
    mandate = dict(terms["mandate"])
    mandate["total_cap"] = int(mandate["total_cap"])
    mandate["per_tx_cap"] = int(mandate["per_tx_cap"])
    envelope = dict(terms["envelope"])
    envelope["max_single_value"] = int(envelope["max_single_value"])
    envelope["max_cumulative_value"] = int(envelope["max_cumulative_value"])
    return {"mandate": mandate, "envelope": envelope, "policy": terms["policy"]}


def _actions(raw: list) -> list:
    return [{**a, "value": int(a["value"])} for a in raw]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_replay_matches_typescript(case: dict) -> None:
    audit = replay_actions(_actions(case["actions"]), _normalize(case["terms"]))

    got = [{"rule": f["rule"], "seq": f["seq"]} for f in audit["findings"]]
    want = [{"rule": f["rule"], "seq": f["seq"]} for f in case["expect"]["findings"]]

    # Order is part of the contract, not an accident. Both implementations
    # report a transaction's authorization rules before its behavioural ones,
    # so a reader sees "you were not allowed to do this" before "and it was also
    # out of character" - and a diff of two rulings lines up.
    assert got == want, case["why"]
    assert audit["envelope_advisory"] == case["expect"]["envelope_advisory"]
    assert audit["actions_considered"] == case["expect"]["actions_considered"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_terms_digest_matches_typescript(case: dict) -> None:
    """The value that decides whether a dispute can be adjudicated at all.

    `adjudicate` refuses unless the terms it is handed hash to what was pinned
    at hire time. Two implementations that encode the same terms differently
    would make every adjudication fail as "terms do not match the digest
    recorded at hire time" - which reads as one party rewriting the deal and is
    actually a codec disagreeing with itself across a language boundary.

    Note the terms here are the raw JSON from the vector file, with integers
    still spelled as strings. That is deliberate: it is the shape that crosses
    the wire, so it is the shape whose digest has to agree.
    """
    assert terms_digest(case["terms"]) == case["terms_hash"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_binding_findings_never_exceed_reported(case: dict) -> None:
    audit = replay_actions(_actions(case["actions"]), _normalize(case["terms"]))
    binding = binding_findings(audit)
    assert len(binding) <= len(audit["findings"])
    if audit["envelope_advisory"]:
        # An envelope built from one audition describes one run's habits.
        # Reporting it is useful; upholding a dispute on it would punish an
        # agent for doing something slightly different the first time.
        assert all(f["rule"] in MANDATE_RULES for f in binding)


def test_a_clean_hire_is_dismissed_and_a_breach_is_upheld() -> None:
    clean = next(c for c in CASES if c["name"] == "clean hire")
    breach = next(c for c in CASES if c["name"] == "the wrong token entirely")

    assert (
        ruling_from_replay(replay_actions(_actions(clean["actions"]), _normalize(clean["terms"])))
        == RULING_DISMISSED
    )
    assert (
        ruling_from_replay(
            replay_actions(_actions(breach["actions"]), _normalize(breach["terms"]))
        )
        == RULING_UPHELD
    )


def test_an_empty_record_clears_nobody() -> None:
    """Nothing was read, so nothing was cleared.

    A hire whose action record could not be fetched is exactly the case where an
    interested party benefits from a confident answer, and `dismissed` would be
    one. The dispute goes unresolved and the window extends.
    """
    empty = next(c for c in CASES if c["name"] == "empty record")
    audit = replay_actions(_actions(empty["actions"]), _normalize(empty["terms"]))
    assert audit["actions_considered"] == 0
    assert ruling_from_replay(audit) == RULING_UNRESOLVED


def test_a_thin_envelope_cannot_uphold_on_its_own() -> None:
    thin = next(c for c in CASES if c["name"] == "thin envelope still reports, still cannot bind")
    audit = replay_actions(_actions(thin["actions"]), _normalize(thin["terms"]))
    assert audit["envelope_advisory"] is True
    rules = {f["rule"] for f in audit["findings"]}
    assert "unseen-recipient" in rules  # reported
    assert "unseen-recipient" not in {f["rule"] for f in binding_findings(audit)}  # not binding

    # This case also breaches the signed mandate, so it still upholds - on the
    # ground that does bind. Strip that and the same actions clear.
    assert ruling_from_replay(audit) == RULING_UPHELD

    permissive = _normalize(thin["terms"])
    permissive["mandate"]["allowlist"] = [
        str(a["to"]).lower() for a in thin["actions"] if a["to"]
    ]
    relaxed = replay_actions(_actions(thin["actions"]), permissive)
    assert {f["rule"] for f in binding_findings(relaxed)} == set()
    assert ruling_from_replay(relaxed) == RULING_DISMISSED


@pytest.mark.parametrize("case", KEY_CASES, ids=lambda c: c["hire_id"])
def test_the_hire_key_matches_the_typescript(case: dict) -> None:
    """Access control, not arithmetic - and the worst thing to get quietly wrong.

    A digest that disagrees across the boundary raises "terms do not match";
    a *key* that disagrees raises nothing at all. Bench would register under one
    row and read from another, `disputes_for` would come back empty, and a hire
    with a live dispute would render as a hire with none. Both sides lower-case
    the registrar for the same reason: checksum casing is presentation, and two
    spellings of one account must not be two hires.
    """
    assert hire_key(case["registrar"], case["hire_id"]) == case["key"]
    assert registrar_of(case["key"]) == case["registrar"].lower()
