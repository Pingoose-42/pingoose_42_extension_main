#!/usr/bin/env bash
# Run from the user's GNOME desktop terminal, without sudo.
set -euo pipefail
package_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

if [[ $# -gt 0 ]]; then
    printf 'Usage: %s (run in a GNOME desktop terminal without sudo)\nThe session will not restart automatically.\n' "$0"
    [[ $# -eq 1 && ( "$1" == '--help' || "$1" == '-h' ) ]] && exit 0
    exit 1
fi
if [[ $EUID -eq 0 || -n "${SUDO_USER:-}" ]]; then
    printf '%s\n' 'Error: Run as your desktop user without sudo.' >&2
    exit 1
fi
for dependency in gnome-extensions gnome-shell glib-compile-schemas; do
    command -v "$dependency" >/dev/null || { printf 'Missing required command: %s\n' "$dependency" >&2; exit 1; }
done
/usr/bin/gjs -c "imports.gi.versions.Gtk='3.0'; imports.gi.versions.WebKit2='4.0'; imports.gi.versions.Soup='2.4'; const {Gtk, WebKit2, Soup}=imports.gi;"

# Validate the running session before replacing any installed files.
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
        raise RuntimeError(f'GNOME {version} is not supported. Supported versions: {supported}')
    if os.environ.get('XDG_SESSION_TYPE') not in ('x11', 'wayland'):
        raise RuntimeError('Run in a GNOME desktop terminal (check XDG_SESSION_TYPE).')
except Exception as error:
    sys.exit(f'Pre-installation check failed: {error}')
PY

# Match the running Shell's extension directory, not the invoking terminal's
# XDG_DATA_HOME (Codex and the desktop can have different environments).
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
        raise SystemExit('Installation aborted: Unexpected extension path.')
    if str(target).startswith(('/usr/', '/opt/')):
        raise SystemExit('Installation aborted: Cannot overwrite a system extension with a user installation.')
    print(target.parent.parent.parent)
PYDATA
)
if [[ -n "$active_data_home" ]]; then
    export XDG_DATA_HOME="$active_data_home"
    printf 'Using the active GNOME installation path: %s/gnome-shell/extensions/pingoose@local\n' "$XDG_DATA_HOME"
fi

build=$(mktemp -d)
trap 'rm -rf -- "$build"' EXIT
(
    cd -- "$package_dir"
    gnome-extensions pack --force --out-dir="$build" --extra-source=config --extra-source=ui --extra-source=services --extra-source=worker --extra-source=models --extra-source=preferences --extra-source=assets --extra-source=dev .
)
# Include the actual source revision without modifying the working tree.
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
# Install the locally built package directly; the GNOME CLI can fail copying
# across the desktop's home/USB filesystem boundary after removing the old copy.
/usr/bin/python3 - "$build/pingoose@local.shell-extension.zip" <<'PYINSTALL'
import os, zipfile
from pathlib import Path
root = Path(os.environ.get('XDG_DATA_HOME') or Path.home() / '.local/share')
target = root / 'gnome-shell/extensions/pingoose@local'
target.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(__import__('sys').argv[1]) as archive:
    # Remove only known legacy modules and development UI from older installs.
    for name in ['webview.js','evaluations.js','slotsService.js','systemSessionHook.js','chat.js','chatPanel.js','token_refresher.py','42intra.png','pingoose.svg','assets/penguin.svg','devOptions.js']:
        (target / name).unlink(missing_ok=True)
    if 'dev/devOptions.js' not in archive.namelist():
        (target / 'dev/devOptions.js').unlink(missing_ok=True)
    for entry in archive.infolist():
        relative = Path(entry.filename)
        if relative.is_absolute() or '..' in relative.parts:
            raise SystemExit('Invalid package path')
        destination = target / relative
        if entry.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(archive.read(entry))
            destination.chmod(0o644)
print(f'Package installed: {target}')
PYINSTALL

printf '%s\n' 'Installation complete. Reload your session manually or log out and back in to apply the changes.'
