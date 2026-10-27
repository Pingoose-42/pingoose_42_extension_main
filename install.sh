#!/usr/bin/env bash
set -euo pipefail

# curl에서 스크립트를 끝까지 받은 뒤 main을 호출한다.
usage() {
    printf '%s\n' \
        '사용법: bash install.sh [--ref REF]' \
        'REF에는 설치할 브랜치, 태그 또는 커밋 SHA를 지정합니다.' \
        '옵션 없이 로컬 소스에서 실행하면 해당 소스를 설치합니다.' \
        '파일 하나만 받았거나 curl로 실행한 경우에는 지정한 버전을 내려받습니다.' \
        '원격 설치에서 --ref를 생략하면 main 브랜치를 설치합니다.' \
        'GNOME 데스크톱 터미널에서 sudo 없이 실행하세요.'
}

fail() {
    printf '설치 실패: %s\n' "$1" >&2
    exit 1
}

download() {
    curl --fail --silent --show-error --location \
        --proto '=https' --proto-redir '=https' --tlsv1.2 \
        --connect-timeout 10 --max-time 180 --retry 2 \
        --output "$2" "$1"
}

resolve_commit() {
    local repository=$1 ref=$2 temporary=$3 encoded_ref
    encoded_ref=$(python3 - "$ref" <<'PYREF'
import re
import sys
import urllib.parse

ref = sys.argv[1]
if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}', ref) or '..' in ref or ref.endswith('/'):
    sys.exit('브랜치, 태그 또는 커밋 SHA가 올바른지 확인해 주세요.')
print(urllib.parse.quote(ref, safe=''))
PYREF
    ) || return 1
    if ! download "https://api.github.com/repos/${repository#https://github.com/}/commits/$encoded_ref" "$temporary/commit.json"; then
        fail 'GitHub에서 설치할 커밋을 확인하지 못했습니다.'
    fi
    python3 - "$temporary/commit.json" <<'PYCOMMIT'
import json
import re
import sys

try:
    with open(sys.argv[1]) as stream:
        response = json.load(stream)
except (OSError, ValueError) as error:
    sys.exit(f'GitHub 응답을 읽지 못했습니다: {error}')
sha = response.get('sha') if isinstance(response, dict) else None
if not isinstance(sha, str) or not re.fullmatch('[0-9a-f]{40}', sha):
    sys.exit('GitHub 응답에 올바른 커밋 SHA가 없습니다.')
print(sha)
PYCOMMIT
}

install_remote() (
    repository=https://github.com/Pingoose-42/pingoose_42_extension_main
    ref=$1
    for dependency in curl python3 mktemp; do
        command -v "$dependency" >/dev/null || fail "필요한 명령을 찾을 수 없습니다: $dependency"
    done

    pingoose_tmp=$(mktemp -d)
    trap 'rm -rf -- "$pingoose_tmp"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    commit=$(resolve_commit "$repository" "$ref" "$pingoose_tmp")

    # 도우미와 설치 소스에 같은 SHA를 사용해, 브랜치가 바뀌어도 선택한 버전을 설치한다.
    if ! download "https://raw.githubusercontent.com/${repository#https://github.com/}/$commit/src/worker/updater.py" "$pingoose_tmp/updater.py"; then
        fail '설치 도우미를 내려받지 못했습니다.'
    fi
    printf 'Pingoose를 설치합니다. 설치할 커밋: %s\n' "$commit"
    python3 "$pingoose_tmp/updater.py" bootstrap \
        --repository "$repository" --branch "$ref" --commit "$commit"
)

main() {
    local ref='' source_dir
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --ref)
                [[ $# -ge 2 && -n "$2" ]] || fail '--ref 뒤에 브랜치, 태그 또는 커밋 SHA를 지정하세요.'
                ref=$2
                shift 2
                ;;
            --help|-h) usage; return 0 ;;
            *) fail "지원하지 않는 옵션입니다: $1" ;;
        esac
    done
    if [[ $EUID -eq 0 || -n "${SUDO_USER:-}" ]]; then
        fail 'GNOME 데스크톱에 로그인한 일반 사용자 계정으로, sudo 없이 실행하세요.'
    fi
    if [[ -z "$ref" && -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
        source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
        if [[ -f "$source_dir/src/scripts/install.sh" ]]; then
            exec bash "$source_dir/src/scripts/install.sh"
        fi
    fi
    install_remote "${ref:-main}"
}

main "$@"
