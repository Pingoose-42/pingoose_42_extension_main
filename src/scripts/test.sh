#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
if [[ $# -gt 1 || ( $# -eq 1 && $1 != --sockets ) ]]; then
    echo 'Usage: bash src/scripts/test.sh [--sockets]' >&2
    exit 2
fi
while IFS= read -r -d '' file; do
    node --check "$file"
done < <(find src -type f -name '*.js' ! -path 'src/tests/*' -print0)
for test in src/tests/*.cjs; do
    [[ "$test" == src/tests/helpers.cjs ]] && continue
    node "$test"
done
python3 src/tests/updater.py
python3 src/tests/installer.py
bash -n install.sh src/scripts/install.sh src/scripts/test.sh
glib-compile-schemas --strict --dry-run src/schemas
if [[ ${1:-} == --sockets ]]; then
    for name in scoped-loopback rejection-loopback probe seat-migration self-loopback; do
        gjs "src/tests/chat-$name.js"
    done
fi
printf '%s\n' 'All requested checks passed.'
