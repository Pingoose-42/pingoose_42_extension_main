const assert = require('assert/strict');
let general = true;
const CountLabel = {
    update(label, title, count) {
        label.label = title + (count ? ' · ' + count : '');
    },
};
const context = {
    CountLabel,
    Flags: { enabled: () => general },
    GLib: { get_user_name: () => 'fixture' },
    Policy: require('../models/chatPolicy.js'),
};
context.Chat = {
    ChatService: class {
        connect() {}
    },
};
const { moduleExport } = require('./helpers.cjs');
const Me = {
    imports: {
        ui: { countLabel: CountLabel },
        models: { featureFlags: context.Flags, chatPolicy: context.Policy },
        services: { chat: context.Chat },
    },
};
const Panel = moduleExport('ui/chatPanel.js', 'ChatPanel', {
    imports: {
        gi: { GLib: context.GLib },
        misc: { extensionUtils: { getCurrentExtension: () => Me } },
    },
});
const probe = () => Object.create(Panel.prototype);
const p = probe();
p._settings = { set_boolean() {}, get_boolean: () => true, get_strv: () => [] };
p._blocked = [];
p._indicator = { loginOnly: false, menu: { isOpen: true } };
p.connection = { reset() {} };
p._chatUi = {
    item: {},
    root: {},
    toggle: {
        get_child() {
            return this;
        },
    },
    add: {},
    peerRow: { hide() {} },
    entry: {},
};
p._chat = { unread: 7, state: 'listening', markRead() {}, configure() {}, peer: () => ({}) };
p._expanded = true;
p.sync();
assert.equal(p._chatUi.root.visible, true);
p._indicator.menu.isOpen = false;
p.sync();
assert.equal(p._expanded, true);
p._indicator.menu.isOpen = true;
p.sync();
assert.equal(p._chatUi.root.visible, true);
p._expanded = false;
p.sync();
assert.equal(p._chatUi.root.visible, false);
p._indicator.menu.isOpen = false;
p.sync();
p._indicator.menu.isOpen = true;
p.sync();
assert.equal(p._chatUi.root.visible, false);
p._expanded = true;
p._indicator.loginOnly = true;
p.sync();
assert.equal(p._chatUi.root.visible, false);
assert.equal(p._chatUi.item.visible, false);
p._updatePanelLabel();
assert.equal(p._chatUi.toggle.label, 'Cluster Chat · 5+');
general = false;
p._indicator.loginOnly = false;
p._chatActive = 'c2r3s4';
p.sync();
assert.equal(p._chatUi.item.visible, false);
assert.equal(p._chatUi.add.visible, false);
assert.equal(p._chatUi.root.visible, true);
console.log(
    'PASS: retained panel state across menu close/open; explicit close remains closed; login visibility; unread badge'
);
let destroyed = false;
const r = probe();
let inputResets = 0;
r.connection = {
    reset() {
        inputResets++;
    },
};
r._chat = {
    destroy() {
        destroyed = true;
    },
};
r._chatUi = {
    entry: { text: 'draft' },
    peerEntry: { text: 'c2r3s4', remove_style_class_name() {} },
    peerRow: {
        visible: true,
        hide() {
            this.visible = false;
        },
    },
};
r._bindChatSignals = () => {};
r._renderChatStatus = r._renderChat = r._updatePanelLabel = r.sync = () => {};
r.reset();
assert.equal(destroyed, true);
assert.equal(r._chatUi.entry.text, '');
assert.equal(inputResets, 1);
assert.equal(r._chatActive, null);
assert.equal(r._expanded, false);
console.log('PASS: logout destroys chat service and clears drafts, selected peer and panel state');
const OverflowPanel = moduleExport('ui/chatPanel.js', 'ChatPanel', {
    imports: {
        gi: { St: { PolicyType: { ALWAYS: 1, NEVER: 0 } } },
        misc: { extensionUtils: { getCurrentExtension: () => Me } },
    },
});
const o = Object.create(OverflowPanel.prototype);
let widths = [110, 110],
    policy = 0;
o._chatUi = {
    chipOverflow: false,
    chips: {
        get_children: () => widths.map((w) => ({ get_preferred_width: () => [w, w] })),
        get_theme_node: () => ({ get_length: () => 6 }),
    },
    chipScroll: {
        width: 326,
        get_allocation_box() {
            return {};
        },
        get_theme_node: () => ({ get_content_box: () => ({ get_width: () => 326 }) }),
        set_policy(value) {
            policy = value;
        },
    },
};
o._syncChipOverflow();
assert.equal(policy, 0);
widths = [110, 110, 110];
o._syncChipOverflow();
assert.equal(policy, 1);
widths = [110];
o._syncChipOverflow();
assert.equal(policy, 0);
console.log(
    'PASS: horizontal scrollbar only appears when chip widths exceed viewport and disappears after removal'
);
const evaluationPanel = probe();
const evaluationGrant = { seat: 'c1r1s3', id: 'evaluation' };
let evaluationOpen;
evaluationPanel.canEvaluation = () => evaluationGrant;
evaluationPanel._indicator = { loginOnly: false, bringPanelNearMain() {} };
evaluationPanel._chat = {
    open(...args) {
        evaluationOpen = args;
        return args[0];
    },
};
evaluationPanel._chatUi = { peerEntry: {}, root: {} };
evaluationPanel._selectChat = evaluationPanel.sync = () => {};
evaluationPanel.openEvaluation({}, 'peer');
assert.deepEqual(evaluationOpen, ['c1r1s3', 'evaluation', false, 'peer']);
console.log('PASS: evaluation card passes counterpart login for nickname (seat) display');
