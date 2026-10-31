#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
if [[ $# -gt 1 || ( $# -eq 1 && $1 != --sockets ) ]]; then
    echo 'Usage: bash src/scripts/test.sh [--sockets]' >&2
    exit 2
fi
exec node src/scripts/test.cjs "$@"
