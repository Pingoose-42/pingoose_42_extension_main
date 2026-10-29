const { GLib, Gio } = imports.gi;
imports.searchPath.unshift(GLib.build_filenamev([GLib.get_current_dir(), 'src']));
const Reset = imports.services.resetData;
const Defaults = imports.models.settingsDefaults;
function assert(value, message) {
    if (!value) throw Error(message);
}
const roots = [GLib.get_user_state_dir(), GLib.get_user_cache_dir(), GLib.get_user_data_dir()];
assert(
    roots.every((root) => root.startsWith('/tmp/pingoose-reset-test.')),
    'Use isolated XDG directories'
);
const external = Gio.File.new_for_path(`${roots[0]}/keep.txt`);
external.replace_contents('keep', null, false, Gio.FileCreateFlags.PRIVATE, null);
for (const root of roots) {
    const path = `${root}/pingoose/nested`;
    GLib.mkdir_with_parents(path, 0o700);
    Gio.File.new_for_path(`${path}/private-data`).replace_contents(
        'private',
        null,
        false,
        Gio.FileCreateFlags.PRIVATE,
        null
    );
    Gio.File.new_for_path(`${path}/link`).make_symbolic_link(external.get_path(), null);
}
Reset.clearAll();
for (const root of roots) {
    assert(
        !Gio.File.new_for_path(`${root}/pingoose/nested/private-data`).query_exists(null),
        'Data deleted'
    );
    assert(
        Gio.File.new_for_path(`${root}/pingoose/nested`).query_exists(null),
        'Monitored directory preserved'
    );
}
assert(external.query_exists(null), 'Symlink target preserved');
assert(
    Gio.File.new_for_path(`${roots[0]}/pingoose/signed-out`).query_exists(null),
    'Signed-out marker persists'
);
const settings = new Gio.Settings({ schema_id: 'org.gnome.shell.extensions.pingoose' });
settings.set_string('theme', 'light');
settings.set_boolean('show-profile', false);
settings.set_string('project-default-tab', 'note');
settings.set_strv('section-order', ['chat']);
settings.set_string('reset-request', 'test');
Defaults.restore(settings);
assert(settings.get_string('theme') === 'dark', 'Theme default');
assert(settings.get_boolean('show-profile'), 'Visibility default');
assert(settings.get_string('project-default-tab') === 'todo', 'Tab default');
assert(settings.get_strv('section-order')[0] === 'profile', 'Order default');
assert(settings.get_string('reset-request') === 'test', 'In-flight request retained');
print(
    'PASS: reset data removal, symlink isolation, monitored directories, logout markers, schema defaults'
);
