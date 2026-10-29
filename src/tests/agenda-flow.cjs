const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const Model = require('../models/evaluations.js');
const Agenda = require('../models/agenda.js');
const source = fs.readFileSync('src/worker/agenda.js', 'utf8');
const messages = [];
let callbacks = [];
let saved = null;
let clock = 100;
const context = {
    Model,
    now: () => clock,
    stopped: false,
    emit: (m) => messages.push(m),
    Soup: {
        MessageFlags: { NO_REDIRECT: 1 },
        Message: { new: () => ({ set_flags() {}, request_headers: { append() {} } }) },
    },
};
context.imports = { gi: { Soup: context.Soup }, models: { evaluations: Model, agenda: Agenda } };
vm.createContext(context);
vm.runInContext(source, context);
const p = {
    refreshPart() {},
    auth: { subject: 'fixture', header: 'fixture' },
    notBefore: 0,
    session: { queue_message: (m, cb) => callbacks.push(cb) },
};
const client = new context.AgendaClient(p, {
    emit: context.emit,
    now: context.now,
    isStopped: () => false,
});
p.readState = () => saved;
p.writeState = (s) => {
    saved = Model.storedState(JSON.stringify(s));
};
const event = {
    id: 1,
    name: 'Fixture event',
    begin_at: '2026-10-18T12:00:00Z',
    end_at: '2026-10-18T13:00:00Z',
    location: 'Auditorium',
};
function run(rows, feedback = [], fail = false) {
    clock += 61;
    callbacks = [];
    client.poll();
    assert.equal(callbacks.length, 2);
    callbacks.forEach((cb, index) =>
        cb(null, {
            status_code: fail && index === 1 ? 500 : 200,
            response_body: { length: 100, data: JSON.stringify(index ? feedback : rows) },
        })
    );
}
run([event]);
assert.equal(messages.filter((m) => m.type === 'notification').length, 1);
run([event]);
assert.equal(messages.filter((m) => m.type === 'notification').length, 1);
run([], [event]);
assert.equal(messages.at(-1).rows[0].feedback, true);
assert.equal(messages.filter((m) => m.type === 'notification').length, 1);
const count = messages.length;
run([], [], true);
assert.equal(messages.length, count);
run([]);
assert.equal(messages.at(-1).rows.length, 0);
run([event]);
assert.equal(messages.filter((m) => m.type === 'notification').length, 1);
assert.equal(Model.advanceSeen(saved, 'fixture', []).state.agendaIds[0], '1');
assert.throws(() => Agenda.parseAgenda([{ ...event, end_at: 'bad' }]));
console.log(
    'PASS: agenda creation notified once; feedback merge; disappearance; failed snapshots preserved; persisted dedup survives evaluation polling'
);
