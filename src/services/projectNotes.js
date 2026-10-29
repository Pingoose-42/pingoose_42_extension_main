const { Gio, GLib } = imports.gi;
const ByteArray = imports.byteArray;
const NotesModel = (() => {
    try {
        return imports.models.projectNotes;
    } catch (_) {
        return imports.misc.extensionUtils.getCurrentExtension().imports.models.projectNotes;
    }
})();

function file() {
    const directory = GLib.build_filenamev([GLib.get_user_state_dir(), 'pingoose', 'notes']);
    if (GLib.mkdir_with_parents(directory, 0o700) !== 0)
        throw Error('Unable to create notes directory');
    const dir = Gio.File.new_for_path(directory);
    const info = dir.query_info(
        'standard::type,unix::uid,unix::mode',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null
    );
    if (
        info.get_file_type() !== Gio.FileType.DIRECTORY ||
        info.get_attribute_uint32('unix::uid') !== new Gio.Credentials().get_unix_user()
    )
        throw Error('Invalid notes directory');
    if ((info.get_attribute_uint32('unix::mode') & 0o777) !== 0o700)
        dir.set_attribute_uint32(
            'unix::mode',
            0o700,
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );
    return dir.get_child('projects.json');
}
function read() {
    const target = file();
    if (!target.query_exists(null)) return { rows: [], etag: null };
    const info = target.query_info(
        'standard::size,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null
    );
    if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > 4000000)
        throw Error('Invalid notes file');
    const [, bytes, etag] = target.load_contents(null);
    const data = JSON.parse(ByteArray.toString(bytes));
    if (data.version !== 1 || !Array.isArray(data.rows)) throw Error('Invalid notes format');
    return { rows: NotesModel.splitTasks(data.rows), etag };
}
function list() {
    return read().rows.sort((a, b) => a.created - b.created);
}
function save(note) {
    const { rows, etag } = read();
    if (note.kind === 'note' && !note.title.trim()) note = { ...note, title: 'Untitled' };
    if (
        !/^[a-zA-Z0-9_-]{1,100}$/.test(note.project) ||
        !['todo', 'note'].includes(note.kind) ||
        (note.kind === 'note' && !note.title.trim()) ||
        note.title.length > 120 ||
        !note.body.trim() ||
        note.body.length > 12000
    )
        throw Error('Invalid note');
    const index = rows.findIndex((row) => row.id === note.id);
    const value = {
        ...note,
        id: note.id || GLib.uuid_string_random(),
        created: index >= 0 ? rows[index].created : Date.now(),
        updated: Date.now(),
    };
    const limit = Math.max(300, rows.length);
    const values =
        note.kind === 'todo'
            ? note.body
                  .split('\n')
                  .filter((line) => line.trim())
                  .map((body, i) => ({
                      ...value,
                      body,
                      id: i === 0 ? value.id : GLib.uuid_string_random(),
                  }))
            : [value];
    if (index >= 0) rows.splice(index, 1, ...values);
    else rows.push(...values);
    if (rows.length > limit) throw Error('Maximum 300 notes');
    write(rows, etag);
    return values[0];
}
function remove(id) {
    const { rows, etag } = read();
    write(
        rows.filter((row) => row.id !== id),
        etag
    );
}
function write(rows, etag) {
    const bytes = ByteArray.fromString(JSON.stringify({ version: 1, rows }));
    if (bytes.length > 4000000) throw Error('Notes storage limit reached');
    file().replace_contents(
        bytes,
        etag,
        false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
        null
    );
}

function clear() {
    write([], null);
}
