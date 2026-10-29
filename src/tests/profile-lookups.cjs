const assert = require('node:assert/strict');
const { controller, Signals } = require('./helpers.cjs');
let timerId = 1,
    identity = {},
    campus = 'gyeongsan',
    cachedPhoto = true,
    writes = 0;
const timers = new Map(),
    views = [],
    output = [];
class View extends Signals {
    constructor() {
        super();
        this.callbacks = [];
        this.scripts = [];
        views.push(this);
    }
    get_settings() {
        return {
            set_auto_load_images: (value) => (this.images = value),
            set_enable_write_console_messages_to_stdout() {},
        };
    }
    load_uri(uri) {
        this.uri = uri;
    }
    stop_loading() {
        this.stopped = true;
    }
    destroy() {
        this.destroyed = true;
    }
    run_javascript_in_world(script, _world, _cancel, callback) {
        this.scripts.push(script);
        this.callbacks.push(callback);
    }
    respond(data) {
        const callback = this.callbacks.shift();
        assert(callback, 'a DOM request must be pending');
        callback(
            {
                run_javascript_in_world_finish: () => ({
                    get_js_value: () => ({ to_string: () => JSON.stringify(data) }),
                }),
            },
            {}
        );
    }
}
const timeout = (_priority, _delay, callback) => {
    const id = timerId++;
    timers.set(id, callback);
    return id;
};
const tick = () => {
    for (const [id, callback] of [...timers]) if (!callback()) timers.delete(id);
};
const imports = {
    gi: {
        GLib: {
            timeout_add: timeout,
            timeout_add_seconds: timeout,
            source_remove: (id) => timers.delete(id),
            SOURCE_CONTINUE: true,
            SOURCE_REMOVE: false,
            base64_encode: (bytes) => Buffer.from(bytes).toString('base64'),
        },
        Gio: {
            File: {
                new_for_path: () => ({
                    query_exists: () => cachedPhoto,
                    replace_contents() {
                        writes++;
                    },
                }),
            },
            FileCreateFlags: {},
        },
        WebKit2: { WebView: View, PolicyDecisionType: {} },
    },
    byteArray: { toString: (bytes) => String(bytes) },
    models: {
        featureFlags: { enabled: () => true },
        favoriteProfile: require('../models/favoriteProfile.js'),
    },
};
const ChatLookup = controller('worker/chatLookup.js', { imports });
const lookup = new ChatLookup({
    current: () => identity,
    getCampus: () => campus,
    emit: (value) => output.push(value),
    allowedURI: () => true,
});
const profile = { profileLogin: 'friend', name: 'Friend Name', campus };
lookup.lookup({ login: 'friend', request: '1', favorite: true, add: true });
let view = views.at(-1);
for (let i = 0; i < 5; i++) {
    tick();
    view.respond({ profile, seat: null, unavailable: true });
}
assert.equal(output.at(-1).profile.name, 'Friend Name');
assert.equal(output.at(-1).seatKnown, true);
assert.equal(output.at(-1).seat, null, 'offline user may still be added to favorites');
assert(view.destroyed && view.stopped);
assert.equal(timers.size, 0);
lookup.lookup({ login: 'friend', request: '2' });
view = views.at(-1);
tick();
view.respond({ profile: { ...profile, campus: 'paris' }, seat: 'c1r1s1' });
assert.match(output.at(-1).error, /Only users from your campus/);
lookup.lookup({ login: 'friend', request: '3' });
view = views.at(-1);
tick();
lookup.lookup({ login: 'other', request: '4' });
lookup.lookup({ login: 'third', request: '5' });
assert.match(output.at(-1).error, /already running/);
view.respond({ profile, seat: 'c1r1s1' });
assert.equal(output.at(-1).request, '3');
assert.match(views.at(-1).uri, /other$/);
const nextView = views.at(-1);
tick();
const before = output.length;
lookup.clear();
nextView.respond({ profile: { ...profile, profileLogin: 'other' }, seat: 'c1r1s1' });
assert.equal(output.length, before);
assert.equal(timers.size, 0);
assert(nextView.destroyed);

const results = [],
    completed = [];
const row = {
    id: '1',
    begin: new Date(Date.now() + 600000).toISOString(),
    users: ['friend'],
    avatars: ['friend'],
    names: { friend: 'Friend Name' },
    chatConfirmedAt: { friend: 1 },
};
let stored = row;
const CounterpartLookup = controller('worker/counterpartLookup.js', { imports });
const peers = new CounterpartLookup({
    current: () => identity,
    stateDirectory: '/state',
    getRow: () => stored,
    allowedURI: () => true,
    onResult: (...args) => results.push(args.at(-1)),
    onComplete: (key) => completed.push(key),
});
peers.lookup(row, 'friend', identity);
view = views.at(-1);
const count = views.length;
peers.lookup(row, 'friend', identity);
assert.equal(views.length, count, 'only one job per evaluation and login');
assert.equal(view.images, false, 'cached portrait avoids image downloads');
assert.equal(
    [...view.signals.values()].filter((signal) => signal.name === 'resource-load-started').length,
    0,
    'cached name avoids profile JSON extraction'
);
tick();
tick();
assert.equal(view.callbacks.length, 1, 'slow WebKit response must not accumulate DOM requests');
assert.match(view.scripts[0], /profile:null/);
view.respond({ valid: true, seat: 'c1r1s2' });
assert.equal(results.at(-1).name, 'Friend Name');
assert.equal(results.at(-1).seat, 'c1r1s2');
assert.equal(peers.jobs.size, 0);
assert.equal(timers.size, 0);
peers.lookup(row, 'friend', identity);
view = views.at(-1);
tick();
peers.clear();
view.respond({ valid: true, unavailable: true });
assert.equal(results.length, 1, 'cancelled DOM results cannot revoke availability');
assert.equal(timers.size, 0);
peers.lookup(row, 'friend', identity);
tick();
identity = {};
tick();
assert.equal(results.length, 1);
assert.equal(completed.length, 1, 'old session cannot affect new session retry state');

// An image response after the evaluation disappears cannot recreate its cache file.
cachedPhoto = false;
peers.lookup({ ...row, avatars: [] }, 'friend', identity);
view = views.at(-1);
let resourceCallback;
const resource = new Signals();
resource.get_response = () => ({ get_status_code: () => 200, get_mime_type: () => 'image/jpeg' });
resource.get_data = (_cancel, callback) => (resourceCallback = callback);
view.emit('resource-load-started', resource, {
    get_uri: () => 'https://cdn.intra.42.fr/users/hash/friend.jpg',
});
resource.emit('finished');
stored = null;
resourceCallback({ get_data_finish: () => new Uint8Array([1]) }, {});
assert.equal(writes, 0);
peers.clear();
assert.equal(timers.size, 0);
console.log(
    'PASS: offline favorites, campus gate, queued/cancelled lookup, cached identity, bounded DOM polling and stale portrait protection'
);
