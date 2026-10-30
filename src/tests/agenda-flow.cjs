const assert = require('node:assert/strict');
const { moduleExport } = require('./helpers.cjs');
const Model = require('../models/evaluations.js');
const Agenda = require('../models/agenda.js');
const messages = [];
let callbacks = [];
let saved = null;
let clock = 100;
const Client = moduleExport('worker/agenda.js', 'AgendaClient', {
    imports: {
        gi: {
            Soup: {
                MessageFlags: { NO_REDIRECT: 1 },
                Message: { new: () => ({ set_flags() {}, request_headers: { append() {} } }) },
            },
        },
        models: { evaluations: Model, agenda: Agenda },
    },
});
const worker = {
    refreshPart() {},
    auth: { subject: 'fixture', header: 'fixture' },
    notBefore: 0,
    evaluationState: Model.advanceSeen(null, 'fixture', []).state,
    session: { queue_message: (message, callback) => callbacks.push(callback) },
    readState: () => saved,
    writeState: (state) => {
        saved = Model.storedState(JSON.stringify(state));
    },
};
const createClient = () =>
    new Client(worker, {
        emit: (message) => messages.push(message),
        now: () => clock,
        isStopped: () => false,
    });
let client = createClient();
const event = {
    id: 1,
    name: 'Fixture event',
    kind: 'event',
    begin_at: '2026-10-18T12:00:00Z',
    end_at: '2026-10-18T13:00:00Z',
    location: 'Auditorium',
};
function startPoll() {
    clock += 61;
    callbacks = [];
    client.poll();
    assert.equal(callbacks.length, 2);
}
function respond(index, rows, status = 200) {
    callbacks[index](null, {
        status_code: status,
        response_body: { length: 100, data: JSON.stringify(rows) },
    });
}
function run(rows, feedback = [], statuses = [200, 200]) {
    startPoll();
    respond(0, rows, statuses[0]);
    respond(1, feedback, statuses[1]);
}
const notices = () => messages.filter((message) => message.type === 'notification');
const snapshot = () => messages.filter((message) => message.type === 'agenda').at(-1);

run([event]);
assert.equal(notices().length, 1);
assert.equal(notices()[0].id, 'agenda:1');
run([event]);
assert.equal(notices().length, 1);
run([event], [event]);
assert.equal(snapshot().rows.length, 1);
assert.equal(snapshot().rows[0].feedback, true);
assert.equal(
    notices().length,
    2,
    'a known agenda becoming unfeedbacked needs its own notification'
);
assert.equal(notices().at(-1).id, 'agenda-feedback:1');
assert.equal(notices().at(-1).category, 'agenda');
assert.equal(notices().at(-1).title, 'Agenda feedback required');
assert.match(notices().at(-1).body, /Fixture event/);
assert.deepEqual(saved.agendaFeedbackIds, ['1']);

// Evaluation writes and a worker restart must preserve both notification histories.
assert.deepEqual([...worker.evaluationState.agendaFeedbackIds], ['1']);
worker.writeState(worker.evaluationState);
worker.writeState(Model.advanceSeen(saved, 'fixture', []).state);
client = createClient();
run([], [event]);
assert.equal(notices().length, 2);
run([]);
assert.equal(snapshot().rows.length, 0);
run([], [event]);
run([event]);
assert.equal(notices().length, 2, 'a disappearing/reappearing event must not notify again');

const count = messages.length;
const beforeFailure = JSON.stringify(saved);
const second = { ...event, id: 2, kind: 'exam' };
run([], [second], [500, 200]);
run([second], [], [200, 500]);
run([], [{ ...second, end_at: 'bad' }]);
assert.equal(messages.length, count, 'failed snapshots must not clear the list or notify');
assert.equal(JSON.stringify(saved), beforeFailure, 'failed snapshots must not mark feedback seen');
run([], [second]);
assert.equal(notices().length, 3);
assert.equal(notices().at(-1).id, 'agenda-feedback:2');
assert(!notices().some((message) => message.id === 'agenda:2'), 'past feedback is not a new event');
run([second]);
assert.equal(notices().length, 3);

// Existing installations know the event ID but have no feedback notification history.
const legacy = { ...saved };
delete legacy.agendaFeedbackIds;
saved = Model.storedState(JSON.stringify(legacy));
assert.deepEqual(saved.agendaFeedbackIds, []);
client = createClient();
run([], [event]);
assert.equal(notices().at(-1).id, 'agenda-feedback:1');
assert.equal(notices().length, 4);
run([], [event]);
assert.equal(notices().length, 4);
assert.throws(() => Model.storedState(JSON.stringify({ ...saved, agendaFeedbackIds: 'bad' })));
assert.throws(() => Model.storedState(JSON.stringify({ ...saved, agendaFeedbackIds: [1] })));
assert.throws(() =>
    Model.storedState(JSON.stringify({ ...saved, agendaFeedbackIds: Array(2001).fill('1') }))
);

// Upcoming events must not crowd feedback out of the bounded UI snapshot.
const upcoming = Array.from({ length: 100 }, (_, index) => ({ ...event, id: index + 100 }));
run(upcoming, [{ ...event, id: 999 }]);
assert.equal(snapshot().rows.length, 100);
assert.equal(snapshot().rows[0].id, '999');
assert.equal(snapshot().rows[0].feedback, true);
assert(notices().some((message) => message.id === 'agenda-feedback:999'));

const beforeSwitch = messages.length;
const previousState = JSON.stringify(saved);
startPoll();
worker.auth = { subject: 'other', header: 'other' };
respond(0, []);
respond(1, [event]);
assert.equal(messages.length, beforeSwitch, 'late responses from the old account are ignored');
assert.equal(JSON.stringify(saved), previousState);
assert.deepEqual(Model.advanceSeen(saved, 'other', []).state.agendaFeedbackIds, []);
run([], [event]);
assert.equal(notices().at(-1).id, 'agenda-feedback:1');
assert.equal(saved.subject, 'other');
assert.deepEqual(saved.agendaFeedbackIds, ['1']);
assert.throws(() => Agenda.parseAgenda([{ ...event, end_at: 'bad' }]));
console.log(
    'PASS: agenda creation and feedback notify separately once; legacy/restart/evaluation persistence; failed and stale snapshots; feedback priority'
);
