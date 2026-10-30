const assert = require('node:assert/strict');
const { due, immediateAllowed } = require('../models/startReminders');
const now = Date.parse('2026-10-29T05:00:00Z');
const row = { id: '1', project: 'Libft', begin: new Date(now + 5 * 60000).toISOString() };
assert.equal(due([row], 'evaluation', 5, now).length, 1);
assert.equal(due([row], 'evaluation', 4, now).length, 0);
assert.equal(due([row], 'evaluation', 0, now + 5 * 60000).length, 1);
assert.equal(due([row], 'evaluation', 0, now + 6 * 60000).length, 0);
assert.equal(due([row], 'evaluation', 5, now + 6 * 60000).length, 0);
assert.equal(
    due(
        [
            { ...row, role: 'evaluator' },
            { ...row, id: '2', role: 'evaluated' },
        ],
        'evaluation',
        5,
        now
    ).length,
    2
);
for (const subscribed of [false, null, undefined]) {
    assert.equal(due([{ ...row, subscribed }], 'agenda', 5, now).length, 0);
    assert.equal(due([{ ...row, subscribed }], 'agenda', 0, now + 5 * 60000).length, 0);
}
assert.equal(due([{ ...row, subscribed: true }], 'agenda', 5, now).length, 1);
assert.equal(due([{ ...row, subscribed: true }], 'agenda', 0, now + 5 * 60000).length, 1);
assert.equal(immediateAllowed({ id: 'intrapy:1' }, { get_boolean: () => false }), false);
assert.equal(
    immediateAllowed(
        { id: 'start:evaluation:1', startReminder: true },
        { get_boolean: () => false }
    ),
    true
);
assert.equal(
    immediateAllowed({ id: 'agenda:1', category: 'agenda' }, { get_boolean: () => false }),
    false
);
assert.equal(
    immediateAllowed({ id: 'agenda-feedback:1', category: 'agenda' }, { get_boolean: () => false }),
    true,
    'disabling new-agenda announcements must not suppress required feedback'
);
console.log('PASS: reminder boundaries, both evaluation roles, and immediate notification gating');
