const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
const context = {
    imports: {
        gi: { Gio: {}, GLib: {} },
        ui: { main: {}, messageTray: {} },
        misc: { extensionUtils: { getCurrentExtension: () => ({}) } },
    },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('src/services/updater.js', 'utf8'), context);
function fixture(automatic) {
    const updater = Object.create(context.Updater.prototype),
        notices = [],
        installs = [];
    updater._settings = {
        get_boolean: (key) => {
            assert.equal(key, 'auto-update');
            return automatic;
        },
    };
    updater._notify = (...args) => notices.push(args);
    updater._install = (sha) => installs.push(sha);
    return { updater, notices, installs };
}
const update = {
    repository: 'https://github.com/example/repo',
    branch: 'main',
    commit: { sha: 'a'.repeat(40), message: 'Update' },
};
let { updater, notices, installs } = fixture(false);
updater._offer(update);
assert.equal(installs.length, 0);
assert.deepEqual(
    Array.from(notices[0][2], (a) => a[0]),
    ['Yes', 'No']
);
notices[0][2][1][1]();
assert.equal(installs.length, 0);
notices[0][2][0][1]();
assert.equal(installs.length, 0, 'already answered No');
({ updater, notices, installs } = fixture(false));
updater._offer(update);
notices[0][2][0][1]();
notices[0][2][0][1]();
assert.deepEqual(installs, [update.commit.sha]);
({ updater, notices, installs } = fixture(true));
updater._offer(update);
assert.equal(notices.length, 0);
assert.deepEqual(installs, [update.commit.sha]);
console.log('PASS: manual Yes/No once; automatic mode installs the offered SHA');
