const { Gio, GLib } = imports.gi;
const ByteArray = imports.byteArray;
function file() {
    const directory = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'pingoose']);
    GLib.mkdir_with_parents(directory, 0o700);
    return Gio.File.new_for_path(directory + '/favorite-seats.json');
}
function read() {
    try {
        const target = file();
        if (!target.query_exists(null)) return [];
        const info = target.query_info(
            'standard::size',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );
        if (info.get_size() > 65536) return [];
        const [, bytes] = target.load_contents(null);
        const data = JSON.parse(ByteArray.toString(bytes));
        return Array.isArray(data)
            ? data
                  .filter(
                      ([login, state]) =>
                          /^[a-z0-9_-]{1,64}$/.test(login) &&
                          state &&
                          (state.seat === null || /^c\d+r\d+s\d+$/i.test(state.seat)) &&
                          Number.isFinite(state.at)
                  )
                  .slice(0, 50)
            : [];
    } catch (_) {
        return [];
    }
}
function write(seats) {
    file().replace_contents(
        ByteArray.fromString(JSON.stringify([...seats])),
        null,
        false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
        null
    );
}
