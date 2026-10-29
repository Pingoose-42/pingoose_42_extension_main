const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
const bodies = vm.runInNewContext(
    fs.readFileSync('src/models/updateCards.js', 'utf8') + '\nbodies'
);
const changes = Array.from({ length: 320 }, (_, index) => ({
    sha: String(index).padStart(40, '0'),
    message: `Change ${index} ` + 'x'.repeat(60),
}));
const pages = bodies({ changes });
assert.ok(pages.length > 1);
assert.ok(pages.every((page) => page.length <= 950));
for (const change of changes) assert.ok(pages.join('\n').includes(change.message));
assert.match(pages.at(-1), /Alt\+F2/);
assert.match(bodies({ sha: 'a'.repeat(40), message: 'Fix\nbreak' })[0], /Fix break/);
const single = bodies({ sha: 'abcdef0123456789', message: 'Fix calendar reminders' })[0];
assert.equal(single.startsWith('Fix calendar reminders\n\nRestart GNOME Shell:'), true);
assert.equal(single.includes('abcdef0'), false);
let archive = {
    notifications: [{ id: 'older', body: 'old' }],
    received: ['older'],
    tests: [{ devTest: true }],
};
const Controller = vm.runInNewContext(
    fs.readFileSync('src/ui/notifications.js', 'utf8') + '\nController',
    {
        imports: {
            gi: {},
            ui: { main: {}, messageTray: {}, popupMenu: {} },
            misc: {
                extensionUtils: {
                    getCurrentExtension: () => ({
                        imports: {
                            services: {
                                cardStore: {
                                    read: () => archive,
                                    write: (data) => (archive = data),
                                },
                            },
                        },
                    }),
                },
            },
        },
        logError: (error) => {
            throw error;
        },
    }
);
const controller = Object.create(Controller.prototype);
Object.assign(controller, {
    _indicator: { loginOnly: true },
    _notifications: [{ id: 'update:one', category: 'update', body: 'new' }],
});
controller._saveCardState();
controller._saveCardState();
assert.equal(archive.notifications.length, 2);
assert.equal(archive.tests.length, 1);
assert.equal(archive.received.length, 2);
console.log(
    'PASS: complete commit list split within archive limits; pre-login update cards retain existing archive'
);
