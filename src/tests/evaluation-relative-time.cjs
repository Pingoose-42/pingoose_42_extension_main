const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
const source = fs.readFileSync('src/ui/evaluations.js', 'utf8');
const context = {};
vm.createContext(context);
vm.runInContext(
    'class Probe {' +
        source.slice(
            source.indexOf('    _evaluationRelativeTime('),
            source.indexOf('    _renderEvaluations(')
        ) +
        '}; globalThis.Probe=Probe;',
    context
);
const p = new context.Probe(),
    now = Date.parse('2026-10-18T00:00:00Z');
const format = (minutes) =>
    p._evaluationRelativeTime(new Date(now + minutes * 60000).toISOString(), now);
assert.equal(format(1505), '(1 d 1 h 5 m remain)');
assert.equal(format(60), '(1 h remain)');
assert.equal(format(5), '(5 m remain)');
assert.equal(format(0.5), '(1 m remain)');
assert.equal(format(0), '(0 m ago)');
assert.equal(format(-0.5), '(0 m ago)');
assert.equal(format(-1505), '(1 d 1 h 5 m ago)');
assert.equal(format(-5), '(5 m ago)');
assert.equal(p._evaluationRelativeTime('invalid', now), '');
console.log('PASS: future/past, day-hour-minute omission, start boundary and invalid dates');
