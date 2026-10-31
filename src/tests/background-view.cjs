const assert = require('node:assert/strict');
const { moduleExport, Signals } = require('./helpers.cjs');

const views = [],
    timers = new Map();
let nextTimer = 1;
class View extends Signals {
    constructor({ web_context }) {
        super();
        this.context = web_context;
        this.callbacks = [];
        this.settings = {
            set_enable_write_console_messages_to_stdout: (value) => (this.console = value),
            set_auto_load_images: (value) => (this.images = value),
        };
        views.push(this);
    }
    get_settings() {
        return this.settings;
    }
    load_uri(uri) {
        this.uri = uri;
    }
    load_request(request) {
        this.request = request;
        this.uri = request.uri;
    }
    get_uri() {
        return this.uri;
    }
    get_main_resource() {
        return { get_response: () => ({ get_status_code: () => 200 }) };
    }
    run_javascript_in_world(_script, _world, _cancel, callback) {
        this.callbacks.push(callback);
    }
    respond(value) {
        const callback = this.callbacks.shift();
        assert(callback, 'a WebKit request must be pending');
        callback(
            {
                run_javascript_in_world_finish: () => ({
                    get_js_value: () => ({ to_string: () => JSON.stringify(value) }),
                }),
            },
            {}
        );
    }
    stop_loading() {
        this.stopped = true;
    }
    destroy() {
        this.destroyed = true;
    }
}
const Policy = { NAVIGATION_ACTION: 0, NEW_WINDOW_ACTION: 1, RESPONSE: 2 };
const imports = {
    gi: {
        WebKit2: {
            WebView: View,
            PolicyDecisionType: Policy,
            LoadEvent: { FINISHED: 3 },
            URIRequest: {
                new(uri) {
                    const headers = {};
                    return {
                        uri,
                        headers,
                        get_http_headers: () => ({
                            replace: (name, value) => (headers[name] = value),
                        }),
                    };
                },
            },
        },
        GLib: {
            timeout_add_seconds(_priority, _delay, callback) {
                const id = nextTimer++;
                timers.set(id, callback);
                return id;
            },
            source_remove: (id) => timers.delete(id),
            SOURCE_REMOVE: false,
            SOURCE_CONTINUE: true,
        },
    },
    models: { evaluationFeedback: require('../models/evaluationFeedback.js') },
};
const create = moduleExport('worker/backgroundView.js', 'create', { imports });
imports.worker = { backgroundView: { create } };
const context = {};
let allowedCalls = 0;
const allowedURI = (uri) => {
    allowedCalls++;
    return uri === 'https://profile.intra.42.fr/slots';
};
let view = create(context, allowedURI);
assert.equal(view.context, context, 'reuse the authenticated WebKit context');
assert.equal(view.console, false, 'page logs must not contaminate worker JSON output');
assert.equal(view.images, undefined, 'ordinary requests retain WebKit image defaults');
assert.equal(create(context, allowedURI, { loadImages: false }).images, false);
let denied = 0;
assert.equal(view.emit('permission-request', { deny: () => denied++ }), true);
assert.equal(denied, 1);
const policy = (type, uri) => {
    let ignored = false;
    const handled = view.emit(
        'decide-policy',
        {
            ignore: () => (ignored = true),
            get_navigation_action: () => ({ get_request: () => ({ get_uri: () => uri }) }),
        },
        type
    );
    return { ignored, handled };
};
assert.deepEqual(policy(Policy.NAVIGATION_ACTION, 'https://profile.intra.42.fr/slots'), {
    ignored: false,
    handled: false,
});
assert.deepEqual(policy(Policy.NAVIGATION_ACTION, 'https://unrelated.example/'), {
    ignored: true,
    handled: true,
});
assert.equal(allowedCalls, 2);
assert.deepEqual(policy(Policy.NEW_WINDOW_ACTION, 'https://profile.intra.42.fr/slots'), {
    ignored: true,
    handled: true,
});
assert.deepEqual(policy(Policy.RESPONSE), { ignored: false, handled: false });
assert.equal(allowedCalls, 2, 'only navigation decisions need a URI allow-list check');
assert.equal(view.uri, undefined, 'the caller owns when and what to load');
assert.equal(timers.size, 0, 'the caller owns operation timers');

const tick = () => {
    for (const [id, callback] of [...timers]) if (!callback()) timers.delete(id);
};
const results = [];
const Checker = moduleExport('services/evaluationFeedback.js', 'Checker', { imports });
const checker = new Checker(context, allowedURI);
checker.run('me', 'libft', (result) => results.push(result));
view = views.at(-1);
assert.equal(view.images, false, 'feedback checks still avoid image downloads');
assert.equal(view.request.uri, 'https://projects.intra.42.fr/libft/me');
assert.equal(view.request.headers['Cache-Control'], 'no-cache');
const beforeDuplicate = views.length;
checker.run('me', 'libft', () => assert.fail('duplicate operation must not start'));
assert.equal(views.length, beforeDuplicate);
view.emit('load-changed', imports.gi.WebKit2.LoadEvent.FINISHED);
view.respond({ items: [] });
assert.equal(results.length, 1);
assert.equal(results[0].items.length, 0);
assert.equal(checker.view, null);
assert(view.stopped && view.destroyed);
assert.equal(timers.size, 0);
checker.run('me', 'libft', (result) => results.push(result));
view = views.at(-1);
view.emit('load-changed', imports.gi.WebKit2.LoadEvent.FINISHED);
checker.close();
view.respond({ items: ['late response'] });
assert.equal(results.length, 1, 'cancelled feedback cannot report a stale response');
assert.equal(timers.size, 0);

const SlotsService = moduleExport('services/slotsService.js', 'SlotsService', { imports });
const slots = new SlotsService(context, allowedURI);
slots.run('list', null, (result) => results.push(result));
view = views.at(-1);
assert.equal(view.context, context);
assert.equal(view.console, false);
assert.equal(view.images, undefined, 'slot requests retain image defaults');
assert.equal(view.uri, 'https://profile.intra.42.fr/slots');
view.emit('load-changed', imports.gi.WebKit2.LoadEvent.FINISHED);
view.respond(null);
tick();
view.respond({ rows: [{ id: '1' }] });
assert.equal(results.length, 2);
assert.equal(slots.rows[0].id, '1');
assert.equal(slots.busy, false);
assert(view.stopped && view.destroyed);
assert.equal(timers.size, 0);
slots.run('list', null, (result) => results.push(result));
view = views.at(-1);
view.emit('load-changed', imports.gi.WebKit2.LoadEvent.FINISHED);
view.respond(null);
tick();
slots.close();
view.respond({ rows: [] });
assert.equal(results.length, 2, 'cancelled slot requests cannot replace the last snapshot');
assert.equal(slots.rows[0].id, '1');
assert.equal(timers.size, 0);
console.log(
    'PASS: shared background view policies, authenticated context, image defaults, feedback/slot completion and cancellation'
);
