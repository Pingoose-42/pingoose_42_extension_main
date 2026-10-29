const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
const Controller = vm.runInNewContext(fs.readFileSync('src/ui/slots.js', 'utf8') + '\nController', {
    imports: {
        gi: { GLib: { timeout_add_seconds: () => 1, source_remove() {} } },
        ui: { popupMenu: {} },
        misc: {
            extensionUtils: {
                getCurrentExtension: () => ({ imports: { ui: { countLabel: {} } } }),
            },
        },
    },
});
const p = Object.create(Controller.prototype),
    requests = [];
Object.assign(p, {
    _indicator: { loginOnly: false },
    _slotPollingReady: true,
    _slotsExpanded: false,
    _requestSlots: (cmd) => requests.push(cmd),
});
p._pollSlotsIfDue(901000);
p._pollSlotsIfDue(902000);
assert.equal(requests.length, 1);
p._pollSlotsIfDue(1800000);
assert.equal(requests.length, 2);
p._slotsBusy = true;
p._pollSlotsIfDue(2700000);
assert.equal(requests.length, 2);
p._slotsBusy = false;
p._pollSlotsIfDue(2701000);
assert.equal(requests.length, 3);
p._indicator.loginOnly = true;
p._pollSlotsIfDue(3600000);
assert.equal(requests.length, 3);
p._indicator.loginOnly = false;
p._slotPollBucket = null;
p._pollSlotsIfDue(2702000);
assert.equal(requests.length, 4);
const sent = [];
let result;
p._bridge = { send: (cmd) => sent.push(cmd) };
p._sessionSlotRequest('slots:list', (value) => (result = value));
assert.equal(sent[0], 'evaluations:check');
p._sessionSlotResult = { rows: [{ id: 'slot' }] };
p._finishSessionCheck();
assert.equal(result, undefined);
p._sessionEvaluationResult = { rows: [{ id: 'evaluation' }] };
p._finishSessionCheck();
assert.equal(result.evaluations[0].id, 'evaluation');
assert.equal(result.rows[0].id, 'slot');
console.log(
    'PASS: collapsed initial/quarter-hour slot polling, busy request deduplication, relogin and fresh logout snapshot barrier'
);
