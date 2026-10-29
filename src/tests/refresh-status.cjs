const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
const source = fs.readFileSync('src/worker/webview.js', 'utf8'),
    events = [];
const ctx = { emit: (event) => events.push(event) };
vm.createContext(ctx);
const Probe = vm.runInContext(
    '(class {' +
        source.slice(source.indexOf('    refreshPart('), source.indexOf('    refreshData()')) +
        '})',
    ctx
);
const p = new Probe();
p.refreshParts = new Set(['profile', 'evaluations', 'agenda', 'logtime']);
for (const key of ['profile', 'profile', 'evaluations', 'agenda']) p.refreshPart(key);
assert.equal(events.length, 0, 'no early completion');
p.refreshPart('logtime');
assert.equal(events[0].state, 'complete');
p.refreshPart('profile');
assert.equal(events.length, 1);
p.refreshParts = new Set(['profile']);
p.refreshPart('profile', false);
assert.equal(events[1].state, 'failed');
p.refreshPart('profile');
assert.equal(events.length, 2);
console.log('PASS: complete only after every source succeeds; failure cannot turn into success');
