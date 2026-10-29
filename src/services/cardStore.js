const { Gio, GLib } = imports.gi;
const ByteArray = imports.byteArray;
function file() {
    const directory = GLib.build_filenamev([GLib.get_user_state_dir(), 'pingoose']);
    GLib.mkdir_with_parents(directory, 0o700);
    return Gio.File.new_for_path(directory + '/cards.json');
}
function read() {
    const target = file();
    if (!target.query_exists(null)) return null;
    const info = target.query_info(
        'standard::type,standard::size,unix::uid,unix::mode',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null
    );
    if (
        info.get_file_type() !== Gio.FileType.REGULAR ||
        info.get_size() > 33554432 ||
        info.get_attribute_uint32('unix::uid') !== new Gio.Credentials().get_unix_user() ||
        info.get_attribute_uint32('unix::mode') & 0o077
    )
        throw Error('Invalid card archive');
    const [, bytes] = target.load_contents(null);
    const data = JSON.parse(ByteArray.toString(bytes));
    if (
        data.version !== 1 ||
        data.login !== GLib.get_user_name() ||
        !Array.isArray(data.notifications) ||
        !Array.isArray(data.received) ||
        !Array.isArray(data.tests)
    )
        throw Error('Invalid card archive');
    if (
        data.notifications.some(
            (row) =>
                typeof row.id !== 'string' || typeof row.body !== 'string' || row.body.length > 1000
        ) ||
        data.received.some((id) => typeof id !== 'string') ||
        data.tests.some(
            (row) =>
                !row.devTest ||
                typeof row.id !== 'string' ||
                !Number.isFinite(Date.parse(row.begin))
        )
    )
        throw Error('Invalid card archive');
    return data;
}
function write(data) {
    file().replace_contents(
        ByteArray.fromString(JSON.stringify({ version: 1, login: GLib.get_user_name(), ...data })),
        null,
        false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
        null
    );
}
