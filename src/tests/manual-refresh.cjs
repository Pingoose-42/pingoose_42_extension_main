const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
const source = fs.readFileSync('src/worker/webview.js', 'utf8');
const method = source.slice(
    source.indexOf('    refreshData() {'),
    source.indexOf('    dismissEvaluation(id)')
);
const context = { now: () => 100, emit: () => {} };
vm.createContext(context);
const Controller = vm.runInContext('(class {' + method + '})', context);
function fixture() {
    const calls = [];
    const controller = new Controller();
    Object.assign(controller, {
        auth: {},
        agenda: { nextPoll: 0 },
        view: { reload_bypass_cache: () => calls.push('profile') },
        poll: () => calls.push('evaluations'),
        pollAgenda: () => calls.push('agenda'),
        refreshLogtime: () => calls.push('logtime'),
    });
    return { controller, calls };
}
let { controller, calls } = fixture();
controller.refreshData();
assert.deepEqual(calls, ['profile', 'evaluations', 'agenda', 'logtime']);
assert.equal(controller.nextPoll, 100);
({ controller, calls } = fixture());
controller.notBefore = 200;
controller.refreshData();
assert.equal(calls.length, 0);
assert.equal(controller.nextPoll, 200);
({ controller, calls } = fixture());
controller.pending = {};
controller.refreshData();
assert(!calls.includes('evaluations'));
({ controller, calls } = fixture());
controller.signedOut = true;
controller.refreshData();
assert.equal(calls.length, 0);
console.log(
    'PASS: refresh schedules all sources, respects server cooldown and avoids duplicate evaluation fetches'
);
