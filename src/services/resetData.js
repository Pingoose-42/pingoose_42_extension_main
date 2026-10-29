const { Gio, GLib } = imports.gi;
const ByteArray = imports.byteArray;
// Remove only extension-owned files, without following links. Preserve directories
// so the notes file monitor remains attached after a reset.
function clearDirectory(path) {
    const directory = Gio.File.new_for_path(path);
    let info;
    try {
        info = directory.query_info(
            'standard::type,unix::uid',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );
    } catch (error) {
        if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) return;
        throw error;
    }
    if (
        info.get_file_type() !== Gio.FileType.DIRECTORY ||
        info.get_attribute_uint32('unix::uid') !== new Gio.Credentials().get_unix_user()
    )
        throw Error('Invalid extension data directory');
    const children = directory.enumerate_children(
        'standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null
    );
    try {
        let child;
        while ((child = children.next_file(null))) {
            const file = directory.get_child(child.get_name());
            if (child.get_file_type() === Gio.FileType.DIRECTORY) clearDirectory(file.get_path());
            else file.delete(null);
        }
    } finally {
        children.close(null);
    }
}
function clearAll() {
    const calendarSource = Gio.File.new_for_path(
        GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'evolution',
            'sources',
            'pingoose-agenda.source',
        ])
    );
    if (calendarSource.query_exists(null)) calendarSource.delete(null);
    for (const base of new Set([
        GLib.get_user_state_dir(),
        GLib.get_user_cache_dir(),
        GLib.get_user_data_dir(),
    ]))
        clearDirectory(GLib.build_filenamev([base, 'pingoose']));
    const state = GLib.build_filenamev([GLib.get_user_state_dir(), 'pingoose']);
    GLib.mkdir_with_parents(state, 0o700);
    for (const name of ['signed-out', 'web-login-only'])
        Gio.File.new_for_path(`${state}/${name}`).replace_contents(
            ByteArray.fromString('1'),
            null,
            false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
}
