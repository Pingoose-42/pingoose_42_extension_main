const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
const Model = require('../models/evaluations.js');
const source = fs.readFileSync('src/worker/webview.js', 'utf8');
const method = source.slice(
    source.indexOf('    receive(text, identity) {'),
    source.indexOf('    publishEvaluations() {')
);
const notices = [],
    ctx = {
        imports: {
            models: {
                evaluationFeedback: require('../models/evaluationFeedback.js'),
                evaluationState: require('../models/evaluationState.js'),
            },
        },
        GLib: { timeout_add: () => 1, source_remove: () => {} },
        Model,
        Date,
        now: () => 100,
        status: () => {},
        emit: (event) => notices.push(event),
    };
vm.createContext(ctx);
const Probe = vm.runInContext('(class {' + method + '})', ctx);
let saved = Model.advanceSeen(null, 'me', []).state;
const p = new Probe();
Object.assign(p, {
    readState: () => JSON.parse(JSON.stringify(saved)),
    writeState: (state) => {
        saved = JSON.parse(JSON.stringify(state));
    },
    publishEvaluations: () => {},
    counterpartLookup: { lookup() {} },
    fail: () => {},
    notBefore: 0,
});
const identity = { subject: 'me', login: 'me' };
const row = {
    id: 1,
    kind: 'evaluator',
    project_name: 'Test',
    begin_at: new Date(Date.now() + 3600000).toISOString(),
    user: 'peer',
};
const receive = (rows) => p.receive(JSON.stringify(rows), identity);
receive([row]);
assert.equal(notices.length, 1);
receive([row]);
assert.equal(notices.length, 1, 'unchanged refresh creates no notification');
receive([]);
assert.equal(saved.evaluations.length, 1, 'absent evaluation remains until user dismisses');
assert.equal(
    saved.evaluations[0].missing,
    true,
    'missing detection starts immediately, even an hour before evaluation'
);
assert.equal(notices.filter((n) => n.id.startsWith('missing:')).length, 1);
receive([]);
assert.equal(
    notices.filter((n) => n.id.startsWith('missing:')).length,
    1,
    'missing alert is not repeated'
);
receive([row, { ...row, id: 2 }]);
assert.equal(
    saved.evaluations.find((r) => r.id === '1').missing,
    false,
    'reappearing match clears missing'
);
assert.equal(
    notices.filter((n) => n.id.startsWith('intrapy:')).length,
    2,
    'only new evaluation announces'
);
saved.dismissed.push('1');
saved.evaluations = saved.evaluations.filter((r) => r.id !== '1');
receive([row, { ...row, id: 2 }]);
assert.equal(notices.filter((n) => n.id.startsWith('intrapy:')).length, 2);
assert(!saved.evaluations.some((r) => r.id === '1'));
receive([{ ...row, id: 2, begin_at: new Date(Date.now() + 7200000).toISOString() }]);
assert.equal(notices.filter((n) => n.id.startsWith('rescheduled:')).length, 1);
const old = JSON.stringify(saved);
p.receive('invalid', identity);
assert.equal(JSON.stringify(saved), old);
console.log(
    'PASS: repeated refresh, retained evaluations, only new notices, dismissed evaluations, rescheduling and malformed response preservation'
);

// Verify persisted counterpart updates independently of WebKit callbacks.
const Counterpart = require('../models/counterpart.js');
const seatRow = { id: '2', begin: row.begin_at, project: 'Test', users: ['peer'] };
const seatContext = { confirmedUnavailable: false };
const holder = { evaluationState: { evaluations: [{ ...seatRow }], reminders: [] } };
function seatLookup(seat) {
    const result = Counterpart.apply(holder.evaluationState, seatRow, 'peer', {
        seat,
        name: 'Peer Name',
        confirmedUnavailable: seatContext.confirmedUnavailable,
    });
    if (result.notification) notices.push(result.notification);
}
seatLookup('c1r1s1');
const afterFirst = notices.length;
seatLookup('c1r1s1');
assert.equal(notices.length, afterFirst, 'same seat must not announce again');
seatLookup('c1r1s2');
assert.equal(notices.length, afterFirst + 1, 'changed seat announces');
seatLookup(null);
assert.equal(
    holder.evaluationState.evaluations[0].seats.peer,
    'c1r1s2',
    'first miss keeps confirmed seat'
);
seatLookup(null);
assert.equal(
    holder.evaluationState.evaluations[0].seats.peer,
    'c1r1s2',
    'repeated unknown responses retain seat'
);
seatContext.confirmedUnavailable = true;
seatLookup(null);
assert.equal(holder.evaluationState.evaluations[0].names.peer, 'Peer Name');
assert.equal(holder.evaluationState.evaluations[0].seats.peer, 'Unavailable');
assert.equal(
    holder.evaluationState.evaluations[0].chatConfirmedAt.peer,
    undefined,
    'failed lookup revokes cached confirmation'
);
holder.evaluationState.evaluations = [];
seatLookup('c1r1s3');
assert.equal(notices.length, afterFirst + 2, 'dismissed evaluation ignores delayed seat result');
console.log('PASS: persisted seat-notice deduplication, changed seats and stale lookup completion');

const past = { ...row, id: 9, begin_at: new Date(Date.now() - 60000).toISOString() };
receive([past]);
const frozen = JSON.stringify(saved.evaluations.find((r) => r.id === '9'));
receive([{ ...past, user: 'other', project_name: 'Changed' }]);
assert.equal(
    JSON.stringify(saved.evaluations.find((r) => r.id === '9')),
    frozen,
    'past evaluation is frozen'
);
receive([]);
assert.equal(
    saved.evaluations.find((r) => r.id === '9'),
    undefined,
    'completed evaluator disappears after validated refresh'
);
assert(saved.dismissed.includes('9'));
// A restored past card must reconcile on the very first successful login response.
saved.evaluations.push({ ...JSON.parse(frozen), id: '10' });
receive([]);
assert(saved.dismissed.includes('10'));
const evaluatee = { ...JSON.parse(frozen), id: '11', kind: 'evaluated' };
saved.evaluations.push(evaluatee);
receive([]);
assert(saved.evaluations.some((r) => r.id === '11'));
console.log(
    'PASS: post-start snapshot freezes and normal disappearance does not create a missing flag'
);
