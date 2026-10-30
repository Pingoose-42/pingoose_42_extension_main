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
    assert.equal(
        context.agendaFeedbackUrl(rows[0].id),
        'https://projects.intra.42.fr/events/1/feedbacks/new'
    );
    assert.throws(() => context.parseAgenda([{ id: null }]), /response-error/);
}
assert.equal(shellImports, 1);
const Agenda = require('../models/agenda.js');
assert.equal(Agenda.parseAgenda([]).length, 0);
assert.equal(
    Agenda.agendaFeedbackUrl('32187'),
    'https://projects.intra.42.fr/events/32187/feedbacks/new'
);
for (const id of [
    undefined,
    null,
    {},
    [],
    1,
    '',
    '0',
    '-1',
    '1/../../other',
    '1?x=y',
    '1'.repeat(129),
])
    assert.equal(Agenda.agendaFeedbackUrl(id), null);
console.log('PASS: agenda imports and validated direct feedback links in Shell, worker and Node');
