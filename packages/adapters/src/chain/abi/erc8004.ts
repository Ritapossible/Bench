/**
 * ============================================================================
 * ERC-8004 ABI fragments — VERIFY AGAINST THE DEPLOYED REGISTRY BEFORE MAINNET
 * ============================================================================
 *
 * Every ABI Bench uses lives in this one file so that "check these against the
 * real contracts" is a single, finishable task rather than a hunt.
 *
 * Status of each fragment:
 *
 *   IDENTITY_REGISTRY_ABI — safe. ERC-8004 identity is an ERC-721, so
 *     `Transfer`, `ownerOf`, and `tokenURI` are standard and cannot drift.
 *     A registration is a Transfer from the zero address. Reading the catalog
 *     through ERC-721 rather than through an ERC-8004-specific event is a
 *     deliberate choice: it is the part of the interface guaranteed by a
 *     finalised standard.
 *
 *   REGISTERED_EVENT — UNVERIFIED. A registry-specific event would give us the
 *     tokenURI without an extra call per agent, which matters when indexing
 *     thousands of agents. Confirm the real signature against the deployed
 *     contract, then switch the indexer to it as a fast path. Until then the
 *     indexer uses the ERC-721 route above and pays for the extra reads.
 *
 *   VALIDATION_REGISTRY_ABI — UNVERIFIED. Bench writes here (never to the
 *     Reputation Registry). Confirm before the Phase 3 attestor goes live;
 *     a wrong signature fails at send time, not silently, but it fails.
 */

export const IDENTITY_REGISTRY_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** UNVERIFIED — see header. Not wired into the indexer yet, by design. */
export const REGISTERED_EVENT = {
  type: 'event',
  name: 'Registered',
  inputs: [
    { name: 'agentId', type: 'uint256', indexed: true },
    { name: 'tokenURI', type: 'string', indexed: false },
    { name: 'owner', type: 'address', indexed: true },
  ],
} as const;

/** UNVERIFIED — see header. Validation, never Reputation. */
export const VALIDATION_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'validationRequest',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'validatorAddress', type: 'address' },
      { name: 'agentId', type: 'uint256' },
      { name: 'dataHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'validationResponse',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'dataHash', type: 'bytes32' },
      { name: 'response', type: 'uint8' },
    ],
    outputs: [],
  },
] as const;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
