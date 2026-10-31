const assert = require('node:assert/strict');
const { controller, Actor } = require('./helpers.cjs');
const sent = [],
    opened = [],
    shown = [],
    closed = [],
    selected = [];
let allowed = true,
    blocked = false,
    instant = false,
    timestamp = 1,
    idle = 0;
const chat = {
    isBlocked: () => blocked,
    open(...args) {
        opened.push(args);
        return args[0];
    },
    isConnected: () => instant,
    showConnected: (key) => shown.push(key),
    peer: () => ({ background: true }),
    close: (key) => closed.push(key),
};
const Me = {
    imports: {
        services: { chat: { SEAT: /^c\d+r\d+s\d+$/ } },
        ui: {
            reveal: { Reveal: require('./helpers.cjs').Reveal },
            spinner: { create: () => new Actor() },
        },
    },
};
const Connection = controller('ui/chatConnection.js', {
    global: { stage: { set_key_focus() {} } },
    imports: {
        gi: {
            Clutter: { ActorAlign: { CENTER: 0 }, RequestMode: {} },
            GLib: { get_monotonic_time: () => timestamp++ },
            Pango: { WrapMode: {}, EllipsizeMode: {} },
            St: { BoxLayout: Actor, Entry: Actor, Button: Actor, Label: Actor },
        },
        misc: { extensionUtils: { getCurrentExtension: () => Me } },
    },
});
const add = new Actor();
const input = new Connection({
    addButton: add,
    allowed: () => allowed,
    getChat: () => chat,
    isBlockedLogin: () => false,
    send: (command) => sent.push(JSON.parse(command.slice('chat:lookup:'.length))),
    select: (key) => selected.push(key),
    onIdle: () => idle++,
});
add.emit('clicked');
input.ui.connect.emit('clicked');
assert.match(input.feedback.text, /Enter a valid/);
assert.equal(input.feedback.visible, true);
add.emit('clicked');
assert.equal(input.feedback.visible, false);
assert(!input.ui.peerEntry.style_class.includes('error'));
add.emit('clicked');
input.ui.peerEntry.text = '@Peer';
input.ui.connect.emit('clicked');
assert.equal(sent[0].login, 'peer');
assert.equal(input.busy, true);
assert.equal(input.ui.connectSpinner.visible, true);
input.completeLookup({ ...sent[0], request: 'stale', seat: 'c1r1s1' });
assert.equal(opened.length, 0);
input.completeLookup({ ...sent[0], seat: 'c1r1s1' });
assert.equal(opened[0][2], true, 'connection remains hidden until handshake succeeds');
assert.equal(opened[0][3], 'peer');
assert.equal(input.busy, true);
input.ready('c1r1s2');
assert.equal(input.busy, true);
input.ready('c1r1s1');
assert.equal(input.busy, false);
assert.equal(input.ui.connectSpinner.visible, false);
assert.equal(input.row.visible, false);
assert.equal(input.ui.peerEntry.text, '');
assert.deepEqual(shown, ['c1r1s1']);
assert.deepEqual(selected, ['c1r1s1']);

input.lookupLogin('peer');
input.completeLookup({ ...sent.at(-1), seat: 'c1r1s1' });
input.failed('c1r1s1', 'Connection rejected or timed out.');
assert.deepEqual(closed, ['c1r1s1']);
assert.equal(input.busy, false);
assert.equal(input.ui.peerEntry.text, 'peer');
assert.equal(input.feedback.visible, true);
input.resetInput();
assert.equal(input.feedback.visible, false);
blocked = true;
input.ui.peerEntry.text = 'c1r1s1';
input.ui.connect.emit('clicked');
assert.match(input.feedback.text, /blacklist/);
blocked = false;
input.lookupLogin('peer');
const late = sent.at(-1),
    before = opened.length;
input.reset();
input.completeLookup({ ...late, seat: 'c1r1s1' });
assert.equal(opened.length, before, 'reset invalidates pending profile lookups');
allowed = false;
assert.equal(input.lookupLogin('peer'), false);
add.emit('clicked');
assert.equal(input.row.visible, false);
input.destroy();
assert.equal(add.signals.size, 0);
assert(input.row.destroyed && input.feedback.destroyed);
assert(idle > 0);
console.log(
    'PASS: connection spinner, hidden tentative peers, stale responses, errors/reset, policy gating and signal cleanup'
);
