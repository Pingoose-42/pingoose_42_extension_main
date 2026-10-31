const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
let enabled = true,
    writes = 0,
    deletes = 0,
    sent = [],
    saved = '';
const gi = {
    Clutter: {},
    St: {},
    Meta: {},
    Gio: {
        File: {
            new_for_path: () => ({
                replace_contents() {
                    writes++;
                },
                query_exists: () => true,
                delete() {
                    deletes++;
                },
            }),
        },
        FileCreateFlags: {},
    },
    GLib: {
        source_remove() {},
        get_monotonic_time: () => 123,
        get_user_state_dir: () => '/state',
        build_filenamev: (a) => a.join('/'),
        mkdir_with_parents() {},
        base64_decode: () => [],
        timeout_add_seconds: () => 1,
    },
};
const extension = {
    imports: {
        services: { favoriteCache: { write() {}, read: () => [] } },
        models: { featureFlags: { enabled: () => enabled } },
    },
};
const context = {
    global: { stage: { get_key_focus: () => null } },
    imports: { gi, misc: { extensionUtils: { getCurrentExtension: () => extension } } },
};
const Panel = vm.runInNewContext(
    fs.readFileSync('src/ui/favorites.js', 'utf8') + '\nPanel',
    context
);
const panel = Object.create(Panel.prototype);
Object.assign(panel, {
    settings: { set_string: (_key, value) => (saved = value) },
    chat: {
        _indicator: { loginOnly: false },
        connectUser(login) {
            this.connecting = true;
            this.requestedLogin = login;
            sent.push('chat:lookup:' + login);
            return true;
        },
        _send: (command) => sent.push(command),
    },
    rows: [],
    seats: new Map(),
    removed: new Set(),
    queue: [],
    addButton: {},
    addLabel: {},
    addSpinner: {},
    entry: {},
    entryRow: { hide() {} },
    entryReveal: { setExpanded() {} },
    addToggle: {},
    feedback: {},
    render() {},
    next() {},
});
panel.pending = { request: '1', login: 'friend', add: true };
panel.complete({
    request: '1',
    login: 'friend',
    profile: { name: 'Friend Name' },
    seat: 'c1r2s3',
    avatar: 'photo',
});
assert.equal(panel.rows[0].name, 'Friend Name');
assert.equal(writes, 1);
assert.equal(JSON.parse(saved)[0].login, 'friend');
panel.pending = { request: '2', login: 'friend' };
panel.remove('friend');
assert.equal(deletes, 1);
assert.equal(JSON.parse(saved).length, 0);
assert.equal(panel.seats.has('friend'), false);
panel.complete({
    request: '2',
    login: 'friend',
    profile: { name: 'Friend Name' },
    avatar: 'photo',
});
assert.equal(writes, 1);
assert.equal(panel.rows.length, 0);
panel.pending = { request: '3', login: 'other', add: true };
enabled = false;
panel.complete({ request: '3', login: 'other', profile: { name: 'Other' } });
assert.equal(panel.rows.length, 0);
panel.connect({ login: 'friend' });
assert.equal(sent.length, 0);
enabled = true;
panel.pending = { request: '4' };
panel.connect({ login: 'friend' });
assert.equal(sent.length, 0);
assert.equal(panel.connectAfter.login, 'friend');
panel.pending = null;
panel.connect({ login: 'friend' });
assert.match(sent[0], /chat:lookup:/);
assert.equal(panel.chat.requestedLogin, 'friend');
console.log(
    'PASS: favorite persistence, image caching, late removed responses, general-chat gating and fresh seat connection'
);

const Profile = require('../models/favoriteProfile.js');
assert.deepEqual(
    Profile.fromResponse(
        { data: { login: 'offline', usual_full_name: 'Offline User', location: null } },
        'offline'
    ),
    { name: 'Offline User' }
);
assert.equal(
    Profile.fromResponse({ login: 'other', display_name: 'Wrong Person' }, 'offline'),
    null
);
assert.deepEqual(
    Profile.fromResponse(
        { users: [{ login: 'offline', first_name: 'First', last_name: 'Last' }] },
        'offline'
    ),
    { name: 'First Last' }
);
panel.chat.connecting = false;
panel.pending = { request: '5', login: 'offline', add: true };
panel.complete({ request: '5', login: 'offline', profile: { name: 'Offline User' }, seat: null });
assert.equal(panel.rows.find((row) => row.login === 'offline').name, 'Offline User');
assert.equal(panel.seats.get('offline').seat, null);
console.log(
    'PASS: offline Intra profiles are saved without a seat or photo; unrelated users are rejected'
);

panel.setAddBusy(true);
assert.equal(panel.addSpinner.visible, true);
assert.equal(panel.addLabel.visible, false);
assert.equal(panel.addButton.reactive, false);
panel.setAddBusy(false);
assert.equal(panel.addSpinner.visible, false);
assert.equal(panel.addLabel.visible, true);
assert.equal(panel.addButton.reactive, true);
const domContext = {
    document: {
        querySelectorAll: () => [
            {
                textContent: 'Donggyeong Yi',
                parentElement: {
                    querySelector: () => ({ textContent: 'doyi' }),
                    parentElement: {
                        querySelectorAll: () => [
                            {
                                tagName: 'DIV',
                                style: {
                                    backgroundImage:
                                        'url("https://cdn.intra.42.fr/users/hash/doyi.jpg")',
                                },
                            },
                        ],
                    },
                },
            },
        ],
    },
};
const readDOM = vm.runInNewContext('(' + Profile.readDOM.toString() + ')', domContext);
assert.equal(readDOM('doyi').name, 'Donggyeong Yi');
assert.equal(readDOM('doyi').avatar, 'https://cdn.intra.42.fr/users/hash/doyi.jpg');
assert.equal(readDOM('seunkang'), null);
console.log(
    'PASS: v3 profile identity uses adjacent login and CSS portrait, independently of navbar avatar and seat'
);
panel.queue = [];
panel.pending = { request: '6', login: 'offline' };
panel.complete({ request: '6', login: 'offline', profile: { name: 'Offline User' }, seat: null });
assert.equal(panel.queue[0].photoAttempt, 1);
panel.queue = [];
panel.pending = { request: '7', login: 'offline', photoAttempt: 1 };
panel.complete({ request: '7', login: 'offline', error: 'Temporary failure' });
assert.equal(panel.queue[0].photoAttempt, 2);
assert.ok(panel.rows.some((row) => row.login === 'offline'));
panel.queue = [];
panel.pending = { request: '8', login: 'offline', photoAttempt: 2 };
panel.complete({ request: '8', login: 'offline', error: 'Temporary failure' });
assert.equal(panel.queue.length, 0);
assert.match(panel.feedback.text, /photo/);
panel.pending = { request: '9', login: 'offline', photoAttempt: 1 };
panel.complete({
    request: '9',
    login: 'offline',
    profile: { name: 'Offline User' },
    avatar: 'photo',
});
assert.equal(panel.queue.length, 0);
console.log(
    'PASS: missing photos retry twice, retain friend data, stop after success and bound repeated failures'
);

domContext.document.querySelectorAll = () => [
    {
        textContent: 'Jungbin Lee',
        parentElement: {
            querySelector: () => ({ textContent: '📟코딩선생 jungblee' }),
            parentElement: { querySelectorAll: () => [] },
        },
    },
];
assert.equal(readDOM('jungblee').name, 'Jungbin Lee');
assert.equal(readDOM('lee'), null);
assert.equal(readDOM('seunkang'), null);
console.log('PASS: titled Intra logins resolve exactly without matching partial IDs');
let restore;
Object.assign(gi.Meta, {
    LaterType: { BEFORE_REDRAW: 0 },
    later_remove() {},
    later_add(_type, callback) {
        restore = callback;
        return 1;
    },
});
gi.St.Label = class {
    constructor(props) {
        Object.assign(this, props);
    }
};
const adjustment = { value: 180, lower: 0, upper: 600, page_size: 200 };
const scrollPanel = Object.create(Panel.prototype);
Object.assign(scrollPanel, {
    rows: [],
    scroll: { get_vscroll_bar: () => ({ get_adjustment: () => adjustment }) },
    list: {
        destroy_all_children() {
            adjustment.value = 0;
        },
        add_child() {},
    },
});
scrollPanel.render();
scrollPanel.render();
restore();
restore();
assert.equal(adjustment.value, 180);
adjustment.upper = 300;
scrollPanel.render();
restore();
restore();
assert.equal(adjustment.value, 100);
panel.connectingLogin = 'friend';
panel.finishConnect();
assert.equal(panel.connectingLogin, null);
console.log(
    'PASS: repeated card rebuilds preserve scroll, deletion clamps to remaining range, connection completion clears spinner state'
);

panel.refreshButton = {};
panel.refreshIcon = {};
panel.refreshSpinner = {};
panel.pending = { request: 'busy' };
panel.queue = [];
panel.syncRefresh();
assert.equal(panel.refreshSpinner.visible, true);
assert.equal(panel.refreshButton.reactive, false);
panel.pending = null;
panel.queue = [{ login: 'retry' }];
panel.syncRefresh();
assert.equal(panel.refreshSpinner.visible, true);
panel.queue = [];
panel.syncRefresh();
assert.equal(panel.refreshSpinner.visible, false);
assert.equal(panel.refreshIcon.visible, true);
assert.equal(panel.refreshButton.reactive, true);
console.log(
    'PASS: refresh spinner covers in-flight requests and retry queue, then restores icon and input'
);

panel.seats.set('offline', { seat: 'c1r2s3', at: 1 });
panel.pending = { request: '10', login: 'offline', avatarCached: true };
panel.queue = [];
panel.complete({ request: '10', login: 'offline', error: 'Temporary server error' });
assert.equal(panel.seats.get('offline').seat, 'c1r2s3');
assert.equal(panel.queue.length, 0);
panel.pending = { request: '11', login: 'offline', avatarCached: true };
panel.complete({ request: '11', login: 'offline', profile: { name: 'Offline User' }, seat: null });
assert.equal(panel.seats.get('offline').seat, null);
assert.equal(panel.queue.length, 0);
console.log(
    'PASS: failed refresh preserves known availability; confirmed offline replaces it; cached photos skip retries'
);
const oldName = panel.rows.find((row) => row.login === 'offline').name;
panel.pending = { request: '12', login: 'offline', avatarCached: true, stateOnly: true };
panel.complete({ request: '12', login: 'offline', seatKnown: true, seat: 'c2r3s4' });
assert.equal(panel.rows.find((row) => row.login === 'offline').name, oldName);
assert.equal(panel.seats.get('offline').seat, 'c2r3s4');
assert.equal(panel.queue.length, 0);
console.log('PASS: availability-only refresh preserves saved identity and skips photo work');

// Refresh uses one snapshot regardless of friend count, preserving stale data on errors.
panel.rows = [
    { login: 'friend', name: 'Friend' },
    { login: 'offline', name: 'Offline' },
];
panel.seats = new Map([['friend', { seat: 'c1r1s1', at: 1 }]]);
panel.clusterRequest = null;
panel.clusterUpdatedAt = 0;
panel.feedback = { text: '' };
panel.render = () => {};
sent = [];
panel.refresh(true);
assert.equal(sent.length, 1);
assert.ok(sent[0].startsWith('favorites:clusters:'));
panel.refresh(true);
assert.equal(sent.length, 1);
panel.completeClusters({ request: 'wrong', seats: {} });
assert.ok(panel.clusterRequest);
panel.completeClusters({ request: panel.clusterRequest, error: 'Network failure' });
assert.equal(panel.seats.get('friend').seat, 'c1r1s1');
panel.refresh(true);
panel.completeClusters({ request: panel.clusterRequest, campus: '1', seats: { friend: 'c2r2s2' } });
assert.equal(panel.seats.get('friend').seat, 'c2r2s2');
assert.equal(panel.seats.get('offline').seat, null);
const requests = sent.length;
panel.refresh();
assert.equal(sent.length, requests);
console.log(
    'PASS: bulk refresh deduplicates, caches, handles offline and preserves seats on failure'
);

let campusName = 'Paris';
domContext.document.querySelectorAll = () => [
    {
        textContent: 'Friend',
        closest: () => ({
            querySelectorAll: () => [{ textContent: campusName, querySelector: () => ({}) }],
        }),
        parentElement: {
            querySelector: () => ({ textContent: 'friend' }),
            parentElement: { querySelectorAll: () => [] },
        },
    },
];
assert.equal(readDOM('friend').campus, 'paris');
campusName = 'Gyeongsan';
assert.equal(readDOM('friend').campus, 'gyeongsan');
assert.equal(readDOM('someoneelse'), null);
console.log('PASS: campus comes from the requested profile, without a fixed campus name');

// Own profile replaces the login paragraph with a title selector.
domContext.location = { pathname: '/' };
domContext.document.querySelectorAll = (selector) =>
    selector === 'button'
        ? [{ textContent: 'friend' }]
        : [
              {
                  textContent: 'Friend',
                  closest: () => ({
                      querySelectorAll: () => [{ textContent: 'Paris', querySelector: () => ({}) }],
                  }),
                  parentElement: {
                      querySelector: () => ({ textContent: 'Summer Reporter📝' }),
                      parentElement: { querySelectorAll: () => [] },
                  },
              },
          ];
assert.equal(readDOM('friend'), null);
assert.equal(readDOM('friend', true).campus, 'paris');
domContext.location.pathname = '/users/someoneelse';
assert.equal(readDOM('friend', true), null);
console.log(
    'PASS: authenticated home title selector supports campus lookup without accepting other user pages'
);

// Title-only profiles must identify by the exact user route and profile header.
for (const login of ['jaehylee', 'seunkang']) {
    domContext.location.pathname = '/users/' + login;
    assert.equal(readDOM(login).profileLogin, login);
    assert.equal(readDOM('unrelated'), null);
}
domContext.location.pathname = '/users/seunkang/';
assert.equal(readDOM('seunkang').campus, 'paris');
console.log('PASS: title-only profile routes resolve without depending on online or frozen state');
