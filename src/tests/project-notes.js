const { GLib, Gio } = imports.gi;
imports.searchPath.unshift(GLib.build_filenamev([GLib.get_current_dir(), 'src']));
const Notes = imports.services.projectNotes;
function assert(value, message) {
    if (!value) throw Error(message);
}
assert(Notes.list().length === 0, 'isolated state starts empty');
const first = Notes.save({
    project: 'libft',
    projectName: 'Libft',
    login: 'fixture',
    kind: 'todo',
    title: '',
    body: '[ ] Read subject',
});
const second = Notes.save({
    project: 'libft',
    projectName: 'Libft',
    login: 'fixture',
    kind: 'note',
    title: 'Notes',
    body: 'Line one\nLine two',
});
assert(Notes.list().length === 2, 'both tabs persist');
assert(Notes.list().find((n) => n.id === first.id).title === '', 'TODO saves without a title');
Notes.save({ ...first, body: '[x] Read subject' });
const updated = Notes.list().find((n) => n.id === first.id);
assert(
    updated.created === first.created && updated.body.startsWith('[x]'),
    'edit preserves creation date'
);
Notes.remove(second.id);
assert(Notes.list().length === 1, 'individual deletion');
const info = Notes.file().query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
assert((info.get_attribute_uint32('unix::mode') & 0o777) === 0o600, 'private notes file');
Notes.clear();
assert(Notes.list().length === 0, 'Delete All clears both kinds');
print('PASS: local notes save/read/update/delete, creation order metadata, private permissions');
const untitled = Notes.save({
    project: 'libft',
    projectName: 'Libft',
    login: 'fixture',
    kind: 'note',
    title: '',
    body: 'Content without title',
});
assert(untitled.title === 'Untitled', 'empty title gets default');
let refused = false;
try {
    Notes.save({ ...untitled, body: '   \n' });
} catch (_) {
    refused = true;
}
assert(refused, 'empty content cannot save');
assert(Notes.list()[0].body === 'Content without title', 'failed save preserves content');
Notes.clear();
print('PASS: Untitled fallback and blank content rejection');
