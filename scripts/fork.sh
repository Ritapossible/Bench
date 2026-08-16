#!/usr/bin/env bash
# Reproducible BSC fork for shadow-engine work.
#
# Requires an ARCHIVE node. A pruned RPC cannot serve historical state and
# fails confusingly partway through an audition rather than at startup.
#
#   ./scripts/fork.sh                 # fork at BENCH_FORK_BLOCK or latest
#   ./scripts/fork.sh 44000000        # fork at an explicit block
set -euo pipefail

: "${BSC_ARCHIVE_RPC_URL:?set BSC_ARCHIVE_RPC_URL (must be an archive node)}"

BLOCK="${1:-${BENCH_FORK_BLOCK:-}}"
PORT="${BENCH_FORK_PORT:-8545}"

args=(--fork-url "$BSC_ARCHIVE_RPC_URL" --port "$PORT" --chain-id 56)
if [ -n "$BLOCK" ]; then
  args+=(--fork-block-number "$BLOCK")
fi

echo "anvil ${args[*]}"
exec anvil "${args[@]}"
