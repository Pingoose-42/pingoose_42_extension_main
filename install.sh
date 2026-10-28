#!/usr/bin/env bash
set -euo pipefail

download() {
    curl --fail --silent --show-error --location \
        --proto '=https' --proto-redir '=https' --tlsv1.2 \
        --connect-timeout 10 --max-time 180 --retry 2 --output "$2" "$1"
}

main() (
    if [[ $# -gt 0 ]]; then
        printf '%s\n' 'Usage: bash install.sh' \
            'Run in your GNOME desktop terminal without sudo.'
        [[ $# -eq 1 && ( $1 == --help || $1 == -h ) ]] && exit 0
        exit 1
    fi
    if [[ $EUID -eq 0 || -n "${SUDO_USER:-}" ]]; then
        printf '%s\n' 'Error: Run as your desktop user without sudo.' >&2
        exit 1
    fi

    if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
        source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
        if [[ -f "$source_dir/src/scripts/install.sh" ]]; then
            exec bash "$source_dir/src/scripts/install.sh"
        fi
    fi
    for dependency in curl python3 mktemp; do
        command -v "$dependency" >/dev/null || {
            printf 'Missing required command: %s\n' "$dependency" >&2
            exit 1
        }
    done

    temporary=$(mktemp -d)
    trap 'rm -rf -- "$temporary"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    repository=Pingoose-42/pingoose_42_extension_main
    download "https://api.github.com/repos/$repository/commits/main" "$temporary/commit.json"
    commit=$(python3 - "$temporary/commit.json" <<'PY'
import json
import re
import sys

with open(sys.argv[1]) as stream:
    response = json.load(stream)
sha = response.get('sha') if isinstance(response, dict) else None
if not isinstance(sha, str) or not re.fullmatch('[0-9a-f]{40}', sha):
    sys.exit('GitHub returned an invalid commit.')
print(sha)
PY
    )
    # Use one revision for both the helper and the source it installs.
    download "https://raw.githubusercontent.com/$repository/$commit/src/worker/updater.py" "$temporary/updater.py"
    printf 'Installing Pingoose at %s\n' "$commit"
    python3 "$temporary/updater.py" bootstrap \
        --repository "https://github.com/$repository" --commit "$commit"
)

# Define the entry point before executing a script received through stdin.
main "$@"
