const assert = require('node:assert/strict'),
    fs = require('node:fs'),
    vm = require('node:vm');
const Model = require('../models/agenda.js');
const begin = Date.now() + 86400000;
const event = {
    id: 32187,
    name: 'Exam',
    kind: 'exam',
    begin_at: new Date(begin).toISOString(),
    end_at: new Date(begin + 10800000).toISOString(),
    description: 'Exam details',
    nbr_subscribers: 5,
    max_subscribers: 100,
    is_subscribed: false,
    events_user_id: null,
    unsubscription_delay: 2,
};
const row = Model.parseAgenda([event])[0];
assert.equal(row.description, 'Exam details');
assert.equal(row.subscribers, 5);
assert.equal(
    Model.agendaAction(row, 'subscribe').url,
    'https://profile.intra.42.fr/exams/32187/exams_users.json'
);
assert.equal(
    Model.agendaAction({ ...row, subscribed: true, subscriptionId: '42' }, 'unsubscribe').url,
    'https://profile.intra.42.fr/exams/32187/exams_users/42.json'
);
assert.equal(Model.agendaAction({ ...row, capacity: 5 }, 'subscribe'), null);
assert.equal(
    Model.agendaAction(
        { ...row, subscribed: true, subscriptionId: '42' },
        'unsubscribe',
        begin - 3600000
    ),
    null
);
assert.equal(Model.agendaAction({ ...row, subscribed: null }, 'subscribe'), null);
assert.equal(Model.agendaAction({ ...row, devTest: true }, 'subscribe'), null);
assert.match(Model.agendaSummary(row, begin - 90060000), /1 d 1 h 1 m remain/);
assert.match(Model.agendaSummary(row, begin), /In progress/);
assert.match(Model.agendaSummary(row, begin + 10800000), /Ended/);
const camel = Model.parseAgenda([
    {
        id: 4,
        name: 'Event',
        kind: 'event',
        beginAt: event.begin_at,
        endAt: event.end_at,
        nbrSubscribers: 7,
        maxSubscribers: 50,
        isSubscribed: true,
        eventsUserId: 8,
    },
])[0];
assert.equal(camel.subscriptionId, '8');
assert.equal(Model.agendaAction(camel, 'unsubscribe').method, 'DELETE');
const source = fs.readFileSync('src/worker/agenda.js', 'utf8');
let requests = [],
    emitted = [],
    refreshes = 0;
const context = {
    Model,
    now: () => 100,
    stopped: false,
    emit: (m) => emitted.push(m),
    Soup: {
        MessageFlags: { NO_REDIRECT: 1 },
        Message: {
            new: (method, url) => ({
                method,
                url,
                set_flags() {},
                request_headers: { append() {} },
            }),
        },
    },
};
context.imports = {
    gi: { Soup: context.Soup },
    models: { evaluations: require('../models/evaluations.js'), agenda: Model },
};
vm.createContext(context);
vm.runInContext(source, context);
function fixture() {
    requests = [];
    emitted = [];
    const worker = {
        auth: { header: 'test' },
        notBefore: 0,
        session: { queue_message: (message, callback) => requests.push({ message, callback }) },
    };
    const client = new context.AgendaClient(worker, {
        emit: context.emit,
        now: context.now,
        isStopped: () => false,
    });
    client.poll = () => refreshes++;
    return client;
}
function respond(index, status, data) {
    requests[index].callback(null, {
        status_code: status,
        response_body: { length: 100, data: JSON.stringify(data) },
        response_headers: { get_one: () => null },
    });
}
let worker = fixture();
worker.changeSubscription('32187', 'subscribe');
assert.equal(requests[0].message.method, 'GET');
worker.changeSubscription('32187', 'subscribe');
assert.equal(requests.length, 1);
respond(0, 200, [event]);
assert.equal(requests[1].message.method, 'POST');
respond(1, 201, { id: 42 });
assert.equal(worker.mutating, false);
assert.equal(emitted.at(-1).error, null);
assert.equal(refreshes, 1);
worker = fixture();
worker.changeSubscription('32187', 'subscribe');
respond(0, 200, [{ ...event, nbr_subscribers: 100 }]);
assert.equal(requests.length, 1);
assert.ok(emitted.at(-1).error);
worker = fixture();
worker.changeSubscription('32187', 'unsubscribe');
respond(0, 200, [{ ...event, is_subscribed: true, events_user_id: 123 }]);
assert.match(requests[1].message.url, /\/123.json$/);
respond(1, 403, {});
assert.ok(emitted.at(-1).error);
worker = fixture();
worker.changeSubscription('32187', 'subscribe');
worker.worker.auth = { header: 'another' };
respond(0, 200, [event]);
assert.equal(requests.length, 1);
assert.equal(emitted.length, 0);
console.log(
    'PASS: agenda details, remaining time, capacity/deadline rules, fresh membership IDs, no duplicate mutation, server failure and identity change'
);

assert.match(Model.agendaSummary(row, begin - 86400000), /\(1 d remain\)/);
assert.match(Model.agendaSummary(row, begin - 3600000), /\(1 h remain\)/);
assert.match(Model.agendaSummary(row, begin - 60000), /\(1 m remain\)/);
assert.equal(Model.parseAgenda([event], true)[0].feedback, true);
assert.equal(Model.parseAgenda([event])[0].feedback, false);
