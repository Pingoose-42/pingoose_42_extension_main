const assert = require('node:assert/strict');
const { controller } = require('./helpers.cjs');
const now = Date.now();
const Reminder = controller('services/startReminders.js', {
    imports: {
        misc: {
            extensionUtils: {
                getCurrentExtension: () => ({
                    imports: { models: { startReminders: require('../models/startReminders') } },
                }),
            },
        },
    },
});
const delivered = [];
let sent = [];
const settings = {
    get_strv: () => sent,
    get_boolean: () => true,
    get_int: () => 5,
    set_strv: (_key, rows) => {
        sent = rows;
    },
};
const reminder = new Reminder(settings, (message) => delivered.push(message));
const row = {
    id: 'agenda',
    name: 'Registered event',
    begin: new Date(now + 60000).toISOString(),
    subscribed: false,
};
reminder.tick([], [row]);
assert.equal(sent.length, 0);
assert.equal(delivered.length, 0);
row.subscribed = true;
reminder.tick([], [row]);
assert.equal(delivered.length, 1);
reminder.tick([], [row]);
assert.equal(delivered.length, 1);
row.subscribed = false;
reminder.tick([], [row]);
assert.equal(delivered.length, 1);
const restarted = new Reminder(settings, (message) => delivered.push(message));
row.subscribed = true;
restarted.tick([], [row]);
assert.equal(delivered.length, 1);
assert.equal(delivered[0].title, 'Agenda starting soon');
console.log(
    'PASS: subscribe after a skipped reminder, unsubscribe, deduplication and restart persistence'
);
