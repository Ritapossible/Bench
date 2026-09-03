# contracts

**Empty on purpose, and this file is the reason.**

This directory holds a `foundry.toml` and no Solidity. An audit flagged it as a
dead directory, which is fair on the evidence, so here is the state:

Bench deploys no contracts. Everything it does on chain is a read - the
ERC-8004 Identity Registry, token balances, Chainlink feeds - and everything it
does to a position happens on a forked chain that is thrown away. The shadow
engine is driven from TypeScript (`packages/adapters/src/shadow`), not from
forge scripts, because the thing being simulated is an *agent*, not a contract.

Two pieces of Solidity are designed and not written:

- **The probe-digest anchor.** `Erc8004RegistryClient.anchorProbeDigest` is
  unimplemented and the anchor queue refuses to register without a signer and a
  validation registry, so nothing pretends this exists. It needs a target
  contract before it can be written.
- **An ERC-8183 evaluator**, if Bench ever arbitrates its own disputes rather
  than settling optimistically.

The `foundry.toml` stays because CI installs Foundry for `anvil`, which the
audition engine genuinely does need. A previous CI job ran `forge build` and
`forge test` against this directory; both exit 0 on an empty project, so the job
was permanently green and certified nothing. It was replaced with a check that
the worker image builds and `anvil` is on its PATH - a signal that can fail.
