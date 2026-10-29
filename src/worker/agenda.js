// Agenda requests share Worker's authenticated session, retry deadline and state store.
// This client owns only agenda polling/mutation state; stale-account responses are ignored.
const { Soup } = imports.gi;
const Model = imports.models.evaluations;
const Agenda = imports.models.agenda;

var AgendaClient = class AgendaClient {
    constructor(worker, { emit, now, isStopped }) {
        this.worker = worker;
        this.emit = emit;
        this.now = now;
        this.isStopped = isStopped;
        this.pending = false;
        this.mutating = false;
        this.nextPoll = 0;
    }

    changeSubscription(id, action) {
        const { worker, emit, now, isStopped } = this;
        const identity = worker.auth;
        const reply = (error) => emit({ type: 'agenda-action', id, error });
        if (!identity || worker.signedOut) {
            reply('Log in to manage subscriptions.');
            return;
        }
        if (this.mutating || this.pending || now() < worker.notBefore) {
            reply('Agenda is refreshing. Please try again shortly.');
            return;
        }
        this.mutating = true;
        const finish = (error) => {
            this.mutating = false;
            if (isStopped() || worker.auth !== identity) return;
            reply(error);
            this.nextPoll = 0;
            this.poll();
        };
        const request = (method, url, callback) => {
            const message = Soup.Message.new(method, url);
            message.set_flags(Soup.MessageFlags.NO_REDIRECT);
            message.request_headers.append('Authorization', identity.header);
            message.request_headers.append('Accept', 'application/json');
            message.request_headers.append('Content-Type', 'application/json');
            worker.session.queue_message(message, (_session, response) => {
                if (isStopped() || worker.auth !== identity) {
                    this.mutating = false;
                    return;
                }
                if ([429, 503].includes(response.status_code))
                    worker.notBefore = Math.max(
                        worker.notBefore,
                        now() +
                            Math.max(
                                30,
                                Model.retryAfter(response.response_headers.get_one('Retry-After'))
                            )
                    );
                callback(response);
            });
        };
        // Refresh membership IDs and availability before any mutation; never trust the UI snapshot.
        request('GET', 'https://intrapy.intra.42.fr/api/v1/users/me/events', (response) => {
            let row;
            try {
                if (response.status_code !== 200 || response.response_body.length > 1000000)
                    throw Error();
                row = Agenda.parseAgenda(JSON.parse(response.response_body.data)).find(
                    (item) => item.id === id
                );
            } catch (_) {
                finish('Unable to refresh agenda. No change was sent.');
                return;
            }
            const operation = Agenda.agendaAction(row, action);
            if (!operation) {
                finish('Subscription state or availability changed. Check the refreshed agenda.');
                return;
            }
            request(operation.method, operation.url, (result) => {
                if (result.status_code >= 200 && result.status_code < 300) finish(null);
                else
                    finish(
                        'Subscription could not be confirmed. Check the refreshed agenda or open Intra.'
                    );
            });
        });
    }

    poll() {
        const { worker, emit, now, isStopped } = this;
        if (
            !worker.auth ||
            this.mutating ||
            this.pending ||
            now() < (this.nextPoll || 0) ||
            now() < worker.notBefore
        )
            return;
        const identity = worker.auth;
        this.pending = true;
        this.nextPoll = now() + 30;
        const results = [];
        let completed = 0;
        const finish = (index, rows) => {
            results[index] = rows;
            if (++completed !== 2) return;
            this.pending = false;
            if (isStopped() || worker.auth !== identity) return;
            if (results.some((value) => value === null)) {
                worker.refreshPart('agenda', false);
                return;
            }
            try {
                // Replace only after both snapshots succeed; errors must not erase the list.
                const merged = new Map(results[0].map((row) => [row.id, row]));
                for (const row of results[1]) merged.set(row.id, row);
                const rows = [...merged.values()].slice(0, 100);
                const state = Model.advanceSeen(worker.readState(), identity.subject, []).state;
                const seen = new Set(state.agendaIds);
                state.agendaIds = [
                    ...new Set([...state.agendaIds, ...rows.map((row) => row.id)]),
                ].slice(-2000);
                worker.writeState(state);
                if (worker.evaluationState?.subject === state.subject)
                    worker.evaluationState.agendaIds = state.agendaIds;
                emit({ type: 'agenda', rows, subject: identity.subject });
                worker.refreshPart('agenda');
                for (const row of rows)
                    if (!seen.has(row.id))
                        emit({
                            type: 'notification',
                            id: `agenda:${row.id}`,
                            category: 'agenda',
                            body: `New agenda event · ${row.name}\n${new Date(row.begin).toLocaleString('en-GB')}${row.location ? ` · ${row.location}` : ''}`,
                        });
            } catch (_) {
                this.nextPoll = now() + 60;
            }
        };
        ['', '/unfeedbacked'].forEach((suffix, index) => {
            const message = Soup.Message.new(
                'GET',
                `https://intrapy.intra.42.fr/api/v1/users/me/events${suffix}`
            );
            message.set_flags(Soup.MessageFlags.NO_REDIRECT);
            message.request_headers.append('Authorization', identity.header);
            message.request_headers.append('Accept', 'application/json');
            worker.session.queue_message(message, (_session, response) => {
                let rows = null;
                if (!isStopped() && worker.auth === identity) {
                    if (response.status_code === 429 || response.status_code === 503) {
                        const delay = Math.max(
                            30,
                            Model.retryAfter(response.response_headers.get_one('Retry-After'))
                        );
                        worker.notBefore = Math.max(worker.notBefore, now() + delay);
                        this.nextPoll = Math.max(this.nextPoll, worker.notBefore);
                    }
                    try {
                        if (
                            response.status_code === 200 &&
                            response.response_body.length <= 1000000
                        )
                            rows = Agenda.parseAgenda(
                                JSON.parse(response.response_body.data),
                                index === 1
                            );
                    } catch (_) {
                        this.nextPoll = now() + 60;
                    }
                }
                finish(index, rows);
            });
        });
    }
};
