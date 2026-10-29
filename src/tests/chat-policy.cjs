const assert = require('node:assert/strict');
const P = require('../models/chatPolicy.js');
const now = Date.parse('2026-10-18T00:00:00Z');
const row = {
    id: '42',
    begin: new Date(now + 899000).toISOString(),
    users: ['peer'],
    seats: { peer: 'c2r3s4' },
    chatConfirmedAt: { peer: now },
};
const grants = P.grantsFrom([row], now);
assert.equal(grants.length, 1);
assert.equal(P.grantsFrom([row], now - 1).length, 0, 'before window or future confirmation');
assert.equal(
    P.grantsFrom([{ ...row, chatConfirmedAt: { peer: now - 1 } }], now).length,
    0,
    'old seat lookup must be refreshed'
);
assert.equal(P.grantsFrom([{ ...row, seats: { peer: 'Unavailable' } }], now).length, 0);
assert.equal(
    P.grantsFrom([{ ...row, devTest: true }], now).length,
    0,
    'dummy cards grant no network access'
);
const policy = { active: true, general: false, grants };
const hello = {
    protocol: 'pingoose-chat-2',
    type: 'hello',
    scope: '42',
    login: 'peer',
    general: false,
};
assert(P.accepts(policy, 'c2r3s4', hello, now));
assert(!P.accepts(policy, 'c2r3s4', hello, now - 1), 'clock moved before allowed window');
assert(!P.accepts(policy, 'c2r3s5', hello, now));
assert(!P.accepts(policy, 'c2r3s4', { ...hello, login: 'stranger' }, now));
assert(!P.accepts(policy, 'c2r3s4', { ...hello, scope: '43' }, now));
assert(!P.accepts(policy, 'c2r3s4', hello, now + 899000), 'closed exactly at start');
assert(!P.accepts(policy, 'c2r3s4', { ...hello, scope: 'general', general: true }, now));
assert(
    !P.accepts(
        { ...policy, general: true },
        'c2r3s4',
        { ...hello, scope: 'general', general: false },
        now
    )
);
assert(
    P.accepts(
        { ...policy, general: true },
        'c2r3s4',
        { ...hello, scope: 'general', general: true },
        now
    )
);
assert(!P.accepts({ ...policy, active: false, general: true }, 'c2r3s4', hello, now));
assert(!P.accepts(policy, 'c2r3s4', 'legacy plaintext', now));
console.log(
    'PASS: 15m window, fresh confirmation, seat/login/evaluation matching, expiry, mutual general opt-in and legacy rejection'
);
const selfRow = { ...row, devTest: true, devSelf: true };
assert.equal(P.grantsFrom([selfRow], now, 'someone-else').length, 0);
assert.equal(P.grantsFrom([selfRow], now, 'peer')[0].testSelf, true);
assert.equal(P.grantsFrom([selfRow], now + 899000, 'peer').length, 0);
assert.equal(
    P.grantsFrom([row], now + 20001).length,
    1,
    'pending refresh preserves confirmed seat'
);
assert.equal(
    P.grantsFrom([row], now + 898000).length,
    1,
    'confirmation survives delays until evaluation starts'
);
assert.equal(
    P.grantsFrom([{ ...row, seats: { peer: 'Unavailable' }, chatConfirmedAt: {} }], now).length,
    0,
    'logout revokes chat'
);

assert.equal(
    P.grantsFrom([{ ...row, missing: true }], now).length,
    0,
    'missing evaluation disables chat'
);
