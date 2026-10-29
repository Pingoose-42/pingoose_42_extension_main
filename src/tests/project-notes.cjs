const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
let nextID = 0;
const ctx = vm.createContext({
    imports: {
        models: { projectNotes: require('../models/projectNotes') },
        gi: { Gio: {}, GLib: { uuid_string_random: () => 'new-id-' + ++nextID } },
        byteArray: {},
        misc: {
            extensionUtils: {
                getCurrentExtension: () => ({
                    imports: { models: { projectNotes: require('../models/projectNotes') } },
                }),
            },
        },
    },
});
vm.runInContext(fs.readFileSync('src/services/projectNotes.js', 'utf8'), ctx);
let stored = [
    {
        id: 'old',
        project: 'libft',
        projectName: 'Libft',
        login: 'alice',
        kind: 'todo',
        title: '',
        body: '[x] first\n\n[ ] second\nthird',
        created: 1,
    },
];
ctx.read = () => ({
    rows: require('../models/projectNotes').splitTasks(structuredClone(stored)),
    etag: 'tag',
});
ctx.write = (rows, etag) => {
    assert.equal(etag, 'tag');
    stored = structuredClone(rows);
};
const tasks = ctx.list();
assert.equal(tasks.length, 3);
assert.equal(tasks[0].body, '[x] first');
assert.equal(ctx.list()[1].id, tasks[1].id);
ctx.remove(tasks[1].id);
assert.equal(ctx.list().length, 2);
assert.equal(ctx.list()[1].body, 'third');
ctx.save({ ...ctx.list()[1], body: 'edited' });
assert.equal(ctx.list()[0].body, '[x] first');
ctx.save({
    project: '__my_projects__',
    projectName: 'My Projects',
    login: 'alice',
    kind: 'todo',
    title: '',
    body: 'a\nb',
});
assert.equal(ctx.list().length, 4);
assert.notEqual(ctx.list()[2].id, ctx.list()[3].id);
assert.equal(require('../models/projectNotes').grouped(ctx.list())[0].name, 'My Projects');
const long = 'x'.repeat(3000);
ctx.save({
    project: 'libft',
    projectName: 'Libft',
    login: 'alice',
    kind: 'note',
    title: 'Long note',
    body: long,
});
assert.equal(ctx.list().find((n) => n.kind === 'note').body, long);
console.log(
    'PASS: legacy tasks split stably; individual delete/edit preserves siblings; new tasks and general notes group correctly'
);
