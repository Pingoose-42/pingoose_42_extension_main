const { Gio } = imports.gi;
const ByteArray = imports.byteArray;

function validCampus(value) {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 100 &&
        value === value.trim() &&
        !/[\x00-\x1f\x7f]/.test(value)
    );
}
function target(directory, identity) {
    if (!/^[a-z0-9_-]{1,64}$/.test(identity.login || '')) throw new Error('Invalid account');
    return Gio.File.new_for_path(`${directory}/profile-campus-${identity.login}.json`);
}
function read(directory, identity) {
    try {
        const file = target(directory, identity);
        const info = file.query_info(
            'standard::type,standard::size,unix::uid,unix::mode',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );
        if (
            info.get_file_type() !== Gio.FileType.REGULAR ||
            info.get_size() > 4096 ||
            info.get_attribute_uint32('unix::uid') !== new Gio.Credentials().get_unix_user() ||
            info.get_attribute_uint32('unix::mode') & 0o077
        )
            return null;
        const [, bytes] = file.load_contents(null);
        const saved = JSON.parse(ByteArray.toString(bytes));
        return saved.version === 1 &&
            saved.subject === identity.subject &&
            saved.login === identity.login &&
            validCampus(saved.campus)
            ? saved.campus
            : null;
    } catch (_) {
        return null;
    }
}
function write(directory, identity, campus) {
    if (!validCampus(campus)) return;
    target(directory, identity).replace_contents(
        ByteArray.fromString(
            JSON.stringify({
                version: 1,
                subject: identity.subject,
                login: identity.login,
                campus,
            })
        ),
        null,
        false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
        null
    );
}
