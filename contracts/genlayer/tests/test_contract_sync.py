"""The deployed artifact must match the libraries it was built from.

GenLayer deploys exactly one file and performs no module bundling, so
`arbiter.py` carries inlined copies of `lib/arbiter_core.py` and
`lib/arbiter_prompts.py`. Those libraries are the source of truth - they are
what the rest of this suite imports and what a reader should edit - and the
contract is generated from them.

Which means the contract can go stale, and a stale contract is the worst kind
of wrong: the tests pass against a rulebook that is not the one deployed. This
file is the guard. It fails if `python tools/build_contract.py` would change
anything, so drift cannot reach a reviewer or a chain unnoticed.
"""

from __future__ import annotations

import ast
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONTRACT = ROOT / "arbiter.py"
BUILDER = ROOT / "tools" / "build_contract.py"


def test_the_checked_in_contract_is_not_stale() -> None:
    result = subprocess.run(
        [sys.executable, str(BUILDER), "--check"],
        capture_output=True,
        text=True,
        cwd=str(ROOT),
    )
    assert result.returncode == 0, (
        "arbiter.py is stale. Run `python tools/build_contract.py`.\n"
        f"{result.stdout}{result.stderr}"
    )


def test_the_contract_parses() -> None:
    ast.parse(CONTRACT.read_text(encoding="utf-8"))


def test_the_contract_declares_exactly_one_contract_class() -> None:
    tree = ast.parse(CONTRACT.read_text(encoding="utf-8"))
    classes = [
        node.name
        for node in tree.body
        if isinstance(node, ast.ClassDef)
        and any(
            isinstance(base, ast.Attribute) and base.attr == "Contract" for base in node.bases
        )
    ]
    assert classes == ["Arbiter"]


def test_every_public_method_is_accounted_for() -> None:
    """The ABI a reviewer reads should be the ABI that deploys.

    Enumerated rather than counted, because a method appearing here without
    anyone noticing is exactly how an unintended write ships.
    """
    tree = ast.parse(CONTRACT.read_text(encoding="utf-8"))
    contract = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "Arbiter"
    )

    views: list[str] = []
    writes: list[str] = []
    for node in contract.body:
        if not isinstance(node, ast.FunctionDef):
            continue
        for dec in node.decorator_list:
            text = ast.unparse(dec)
            if text.startswith("gl.public.view"):
                views.append(node.name)
            elif text.startswith("gl.public.write"):
                writes.append(node.name)

    assert sorted(views) == [
        "dispute",
        "disputes_for",
        "evidence_independence",
        "hire",
        "limits",
        "owed_to",
        "total",
    ]
    assert sorted(writes) == [
        "adjudicate",
        "answer",
        "expire",
        "open_dispute",
        "register_hire",
        "withdraw",
        "withdraw_to",
    ]


def test_only_withdrawal_moves_value_out() -> None:
    """`emit_transfer` must appear in exactly one place.

    Settlement credits a ledger; getting value out is a separate,
    caller-initiated act. A second transfer site would be a second way for the
    bond to leave, and the reentrancy ordering is only correct in the one that
    exists.
    """
    tree = ast.parse(CONTRACT.read_text(encoding="utf-8"))
    calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "emit_transfer"
    ]
    # Call sites, not mentions: the docstrings explaining why there is only one
    # of these are part of why there is only one of these.
    assert len(calls) == 1


def test_the_libraries_declare_no_contract() -> None:
    for name in ("arbiter_core.py", "arbiter_prompts.py"):
        tree = ast.parse((ROOT / "lib" / name).read_text(encoding="utf-8"))
        assert not [
            node for node in tree.body if isinstance(node, ast.ClassDef) and node.bases
        ], f"{name} should be a build input, not a contract"
