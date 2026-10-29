const { Gio, GLib, St } = imports.gi;
const Me = imports.misc.extensionUtils.getCurrentExtension();
let frames = null;
function create(size = 24) {
    frames ||= Array.from(
        { length: 24 },
        (_, i) =>
            new Gio.FileIcon({
                file: Gio.File.new_for_path(
                    Me.path +
                        '/assets/spinner/spinner-' +
                        String(i).padStart(2, '0') +
                        '-symbolic.svg'
                ),
            })
    );
    const icon = new St.Icon({ gicon: frames[0], icon_size: size, accessible_name: 'Loading' });
    const preferences = St.Settings.get();
    let timer = 0;
    const stop = () => {
        if (timer) GLib.source_remove(timer);
        timer = 0;
    };
    const sync = () => {
        stop();
        if (!icon.mapped || !preferences.enable_animations) return;
        const start = GLib.get_monotonic_time();
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
            icon.gicon =
                frames[Math.floor((((GLib.get_monotonic_time() - start) / 1000) * 24) / 800) % 24];
            return GLib.SOURCE_CONTINUE;
        });
    };
    const signal = preferences.connect('notify::enable-animations', sync);
    icon.connect('notify::mapped', sync);
    icon.connect('destroy', () => {
        stop();
        preferences.disconnect(signal);
    });
    sync();
    return icon;
}
