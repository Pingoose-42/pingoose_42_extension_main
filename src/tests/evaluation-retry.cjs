const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
const source = fs.readFileSync('src/worker/webview.js', 'utf8');
let time = 10000000,
    delay;
const ctx = {
    Date: { now: () => time, parse: Date.parse },
    now: () => time / 1000,
    GLib: {
        source_remove() {},
        timeout_add: (_p, ms) => {
            delay = ms;
            return 1;
        },
    },
};
vm.createContext(ctx);
const Probe = vm.runInContext(
    '(class {' +
        source.slice(
            source.indexOf('    scheduleEvaluationPoll('),
            source.indexOf('    publishEvaluations()')
        ) +
        '})',
    ctx
);
const p = new Probe();
p.notBefore = 0;
const row = { id: '1', begin: new Date(time + 899250).toISOString(), users: [] };
p.evaluationState = { evaluations: [row] };
p.scheduleEvaluationPoll();
assert.equal(
    delay,
    250,
    'request one second after the 15 minute boundary, not next 10 second poll'
);
time += 250;
p.scheduleEvaluationPoll();
assert.equal(delay, 5000, 'unknown counterpart retries every 5 seconds');
row.users = ['peer'];
p.scheduleEvaluationPoll();
assert.equal(delay, 5000, 'missing seat retries');
row.seats = { peer: 'c1r1s1' };
row.chatConfirmedAt = { peer: time };
p.scheduleEvaluationPoll();
assert.equal(delay, 5000, 'confirmed counterpart is still checked until start');
row.seats = {};
time = Date.parse(row.begin);
p.scheduleEvaluationPoll();
assert.equal(delay, 10000, 'no targeted retry after start');
p.notBefore = time / 1000 + 60;
p.scheduleEvaluationPoll();
assert.equal(delay, 60000, 'server cooldown wins');
console.log(
    'PASS: 15 minute deadline plus one second delay, 5 second retries, continuous updates/start termination and server cooldown'
);
