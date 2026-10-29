const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const evaluations = require('../models/evaluations.js');
const source = fs.readFileSync('src/models/agenda.js', 'utf8');
const worker = { models: { evaluations } };
let shellImports = 0;
const shell = {
    get models() {
        throw Error("No JS module 'models' found in search path");
    },
    misc: {
        extensionUtils: {
            getCurrentExtension() {
                shellImports++;
                return { imports: { models: { evaluations } } };
            },
        },
    },
};
for (const imports of [worker, shell]) {
    const context = { imports };
    vm.createContext(context);
    vm.runInContext(source, context);
    const rows = context.parseAgenda([
        { id: 1, name: 'Event', begin_at: '2026-10-22T00:00:00Z', end_at: '2026-10-22T01:00:00Z' },
    ]);
    assert.equal(rows[0].id, '1');
    assert.throws(() => context.parseAgenda([{ id: null }]), /response-error/);
}
assert.equal(shellImports, 1);
assert.equal(require('../models/agenda.js').parseAgenda([]).length, 0);
console.log('PASS: agenda imports in Shell namespace, standalone worker and Node');
