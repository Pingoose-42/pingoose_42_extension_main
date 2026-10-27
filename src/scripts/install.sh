#!/usr/bin/env bash
# GNOME 데스크톱에 로그인한 일반 사용자 계정으로 실행한다.
set -euo pipefail
package_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

if [[ $# -gt 0 ]]; then
    printf '사용법: bash %s\nGNOME 데스크톱 터미널에서 sudo 없이 실행하세요.\n' "$0"
    [[ $# -eq 1 && ( "$1" == '--help' || "$1" == '-h' ) ]] && exit 0
    exit 1
fi
if [[ $EUID -eq 0 || -n "${SUDO_USER:-}" ]]; then
    printf '%s\n' 'GNOME 데스크톱에 로그인한 일반 사용자 계정으로, sudo 없이 실행하세요.' >&2
    exit 1
fi
for dependency in gnome-extensions gnome-shell glib-compile-schemas; do
    command -v "$dependency" >/dev/null || { printf '필요한 명령을 찾을 수 없습니다: %s\n' "$dependency" >&2; exit 1; }
done
/usr/bin/gjs -c "imports.gi.versions.Gtk='3.0'; imports.gi.versions.WebKit2='4.0'; imports.gi.versions.Soup='2.4'; const {Gtk, WebKit2, Soup}=imports.gi;"

# 설치 파일을 바꾸기 전에 GNOME 버전과 로그인 세션을 확인한다.
/usr/bin/python3 - "$package_dir" <<'PY'
import json, os, sys
from gi.repository import Gio, GLib
try:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    version = bus.call_sync('org.gnome.Shell', '/org/gnome/Shell',
        'org.freedesktop.DBus.Properties', 'Get',
        GLib.Variant('(ss)', ('org.gnome.Shell.Extensions', 'ShellVersion')),
        None, Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
    with open(os.path.join(sys.argv[1], 'metadata.json')) as source:
        supported = json.load(source)['shell-version']
    if str(version).split('.')[0] not in supported:
        raise RuntimeError(f'GNOME {version}에서는 설치할 수 없습니다. 지원 버전: {supported}')
    if os.environ.get('XDG_SESSION_TYPE') not in ('x11', 'wayland'):
        raise RuntimeError('GNOME 데스크톱 터미널에서 실행하세요. XDG_SESSION_TYPE은 x11 또는 wayland여야 합니다.')
except Exception as error:
    sys.exit(f'설치에 필요한 환경을 확인하지 못했습니다: {error}')
PY

# 터미널과 Shell의 환경 변수가 다를 수 있으므로, 실행 중인 Shell의 확장 경로를 따른다.
active_data_home=$(/usr/bin/python3 - <<'PYDATA'
from pathlib import Path
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
info = bus.call_sync('org.gnome.Shell', '/org/gnome/Shell',
    'org.gnome.Shell.Extensions', 'GetExtensionInfo',
    GLib.Variant('(s)', ('pingoose@local',)), None,
    Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
path = info.get('path', '')
if path:
    target = Path(path)
    if target.parent.name != 'extensions' or target.parent.parent.name != 'gnome-shell':
        raise SystemExit('설치 경로를 확인할 수 없습니다. 기존 확장이 gnome-shell/extensions 아래에 있는지 확인해 주세요.')
    if str(target).startswith(('/usr/', '/opt/')):
        raise SystemExit('시스템에 설치된 확장을 사용자 설치로 덮어쓸 수 없습니다.')
    print(target.parent.parent.parent)
PYDATA
)
if [[ -n "$active_data_home" ]]; then
    export XDG_DATA_HOME="$active_data_home"
    printf '설치 경로: %s/gnome-shell/extensions/pingoose@local\n' "$XDG_DATA_HOME"
fi

build=$(mktemp -d)
trap 'rm -rf -- "$build"' EXIT
(
    cd -- "$package_dir"
    gnome-extensions pack --force --out-dir="$build" --extra-source=config --extra-source=ui --extra-source=services --extra-source=worker --extra-source=models --extra-source=preferences --extra-source=assets --extra-source=dev .
)
# 소스에서 읽은 설치 버전을 패키지 안에 기록한다.
/usr/bin/python3 - "$package_dir" "$build/pingoose@local.shell-extension.zip" <<'PYRECEIPT'
import importlib.util, json, sys, zipfile
from pathlib import Path
root = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('updater', root / 'worker/updater.py')
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)
receipt = updater.source_receipt(root)
with zipfile.ZipFile(sys.argv[2], 'a') as archive:
    archive.writestr('config/installed.json', json.dumps(receipt))
PYRECEIPT
# GNOME 설치 명령은 파일시스템이 다른 경로 사이에서 복사에 실패할 수 있어, 패키지를 직접 푼다.
/usr/bin/python3 - "$build/pingoose@local.shell-extension.zip" <<'PYINSTALL'
import os, zipfile
from pathlib import Path
root = Path(os.environ.get('XDG_DATA_HOME') or Path.home() / '.local/share')
target = root / 'gnome-shell/extensions/pingoose@local'
target.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(__import__('sys').argv[1]) as archive:
    # 이전 버전에서 사용하던 파일 중 제거 대상이 명확한 모듈과 개발 UI를 정리한다.
    for name in ['webview.js','evaluations.js','slotsService.js','systemSessionHook.js','chat.js','chatPanel.js','token_refresher.py','42intra.png','pingoose.svg','assets/penguin.svg','devOptions.js']:
        (target / name).unlink(missing_ok=True)
    if 'dev/devOptions.js' not in archive.namelist():
        (target / 'dev/devOptions.js').unlink(missing_ok=True)
    for entry in archive.infolist():
        relative = Path(entry.filename)
        if relative.is_absolute() or '..' in relative.parts:
            raise SystemExit('설치 패키지에 확장 디렉터리를 벗어나는 경로가 있습니다.')
        destination = target / relative
        if entry.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(archive.read(entry))
            destination.chmod(0o644)
print(f'Pingoose를 설치했습니다: {target}')
PYINSTALL

printf '%s\n' 'GNOME Shell을 다시 시작하거나 로그아웃 후 로그인하면 설치한 버전이 적용됩니다.'
