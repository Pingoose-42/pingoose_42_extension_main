#!/usr/bin/env bash
set -euo pipefail

# Keep the entry point self-contained: it also runs from stdin via curl | bash.
# Defining main before calling it prevents a truncated download from starting it.
main() (
    repository=https://github.com/Pingoose-42/pingoose_42_extension_main
    ref=main
    requested_ref=false
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --ref)
                [[ $# -ge 2 && -n "$2" ]] || { printf '%s\n' 'Error: --ref requires a branch, tag, or commit.' >&2; exit 2; }
                ref=$2
                requested_ref=true
                shift 2
                ;;
            --help|-h)
                printf '%s\n' \
                    'Usage: install.sh [--ref BRANCH_OR_TAG_OR_COMMIT]' \
                    'Run in a GNOME desktop terminal without sudo.' \
                    'A local source tree installs offline; a standalone or piped script downloads the selected revision.' \
                    'The session will not restart automatically.'
                exit 0
                ;;
            *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
        esac
    done

    if [[ "$requested_ref" == false && -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
        source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
        if [[ -f "$source_dir/src/scripts/install.sh" ]]; then
            exec bash "$source_dir/src/scripts/install.sh"
        fi
    fi
    if [[ $EUID -eq 0 || -n "${SUDO_USER:-}" ]]; then
        printf '%s\n' 'Error: Run as your desktop user without sudo.' >&2
        exit 1
    fi
    for dependency in curl python3; do
        command -v "$dependency" >/dev/null || { printf 'Missing required command: %s\n' "$dependency" >&2; exit 1; }
    done
    encoded_ref=$(python3 -c 'import re, sys, urllib.parse
ref = sys.argv[1]
if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}", ref) or ".." in ref or ref.endswith("/"):
    sys.exit("Invalid source reference.")
print(urllib.parse.quote(ref, safe=""))' "$ref")
    pingoose_tmp=$(mktemp -d)
    trap 'rm -rf -- "$pingoose_tmp"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    curl_options=(--fail --silent --show-error --location --proto '=https' --proto-redir '=https'
                  --tlsv1.2 --connect-timeout 10 --max-time 180 --retry 2)
    curl "${curl_options[@]}" \
        "https://api.github.com/repos/${repository#https://github.com/}/commits/$encoded_ref" \
        --output "$pingoose_tmp/commit.json"
    commit=$(python3 -c 'import json, re, sys
with open(sys.argv[1]) as stream:
    sha = json.load(stream).get("sha", "")
if not isinstance(sha, str) or not re.fullmatch("[0-9a-f]{40}", sha):
    sys.exit("GitHub returned an invalid commit.")
print(sha)' "$pingoose_tmp/commit.json")
    # Fetch the helper from that exact revision, not from a moving branch.
    curl "${curl_options[@]}" \
        "https://raw.githubusercontent.com/${repository#https://github.com/}/$commit/src/worker/updater.py" \
        --output "$pingoose_tmp/updater.py"
    printf 'Installing Pingoose revision %s\n' "$commit"
    python3 "$pingoose_tmp/updater.py" bootstrap \
        --repository "$repository" --branch "$ref" --commit "$commit"
)

main "$@"
