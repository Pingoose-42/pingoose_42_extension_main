const assert = require('node:assert/strict');
const { controller, Actor, Reveal } = require('./helpers.cjs');
class Item extends Actor {
    remove_all_children() {
        this.children = [];
    }
}
let rebuilds = 0;
const sent = [];
const section = {
    items: [],
    removeAll() {
        rebuilds++;
        this.items = [];
    },
    addMenuItem(item) {
        this.items.push(item);
    },
};
const Slots = controller('ui/slots.js', {
    imports: {
        gi: {
            Clutter: { ActorAlign: {}, RequestMode: {}, BinLayout: class {} },
            GLib: {},
            Pango: { WrapMode: {}, EllipsizeMode: {} },
            St: { BoxLayout: Actor, Label: Actor, Button: Actor, Widget: Actor },
        },
        ui: { popupMenu: { PopupBaseMenuItem: Item } },
        misc: {
            extensionUtils: {
                getCurrentExtension: () => ({
                    imports: {
                        ui: {
                            countLabel: { update() {} },
                            reveal: { Reveal },
                            spinner: { create: () => new Actor() },
                        },
                        models: {
                            slotSchedule: require('../models/slotSchedule.js'),
                            featureFlags: { enabled: () => true },
                        },
                    },
                }),
            },
        },
    },
});
const button = new Actor();
button.set_child(new Actor());
button.get_child = () => button.children[0];
const p = new Slots(
    { visitIntra: button, slotItems: section },
    { send: (x) => sent.push(x), on: () => () => {} },
    { get_boolean: () => false, set_boolean() {} }
);
p._requestSlots('slots:list');
assert.equal(section.items.length, 1, 'first request shows initial spinner');
p.onSlotsMessage({ rows: [] });
const first = section.items[0];
const count = rebuilds;
p._requestSlots('slots:list');
assert.equal(rebuilds, count, 'empty but initialized snapshot also stays visible');
p.onSlotsMessage({ rows: [] });
assert.equal(section.items[0], first);
button.emit('clicked');
button.emit('clicked');
assert.equal(sent.length, 2, 'toggle does not request slots');
assert.equal(rebuilds, count, 'toggle does not rebuild cards');
const row = { id: 1, start: '2026-10-31T09:00:00Z', end: '2026-10-31T10:00:00Z' };
p.onSlotsMessage({ rows: [row] });
assert.equal(rebuilds, count + 1, 'changed snapshot refreshes cards');
const populated = section.items[0];
p._requestSlots('slots:list');
p.onSlotsMessage({ rows: [{ ...row, ignoredServerField: 123 }] });
assert.equal(section.items[0], populated, 'unchanged display data retains actor and focus');
p._setCreatorExpanded(true);
assert.equal(p._creatorReveal.expanded, true);
p._setCreatorExpanded(false);
assert.equal(section.items[0], populated, 'creator toggle retains slot cards');
p.onSlotsMessage({ rows: [], error: 'Temporary network failure' });
assert.equal(p.slots.length, 1, 'failed refresh retains cached rows');
p.onSlotsMessage({ rows: [] });
assert.equal(p.slots.length, 0, 'successful empty response clears removed slots');
console.log(
    'PASS: slot snapshot retention, quiet background refresh, unchanged actors, tab/creator toggles and recovery'
);

for (const action of ['refresh', 'auto', 'create']) {
    const tracked = p._actionButtons.find((item) => item.action === action);
    const command =
        action === 'refresh'
            ? 'slots:list'
            : action === 'auto'
              ? 'slots:open-auto'
              : 'slots:create:{}';
    p._requestSlots(command, action);
    assert.equal(tracked.spinner.visible, true);
    assert.equal(tracked.label.opacity, 0);
    assert.equal(tracked.button.reactive, false);
    const requests = sent.length;
    p._requestSlots(command, action);
    assert.equal(sent.length, requests, 'pending request prevents duplicate submission');
    p.onSlotsMessage({
        rows: [],
        error: action === 'create' ? 'Could not create slot:\nOverlaps existing slot.' : null,
    });
    assert.equal(tracked.spinner.visible, false);
    assert.equal(tracked.label.opacity, 255);
    assert.equal(tracked.button.reactive, true);
}
assert.equal(p._slotsError, null, 'creation errors stay out of the general slot list');
assert.match(p._createErrorLabel.text, /Overlaps/);
assert.equal(p._createErrorLabel.visible, true);
const card = p._createErrorLabel.parent;
assert.equal(
    card.children[1],
    p._createErrorLabel,
    'error sits after time range and before Create actions'
);
p._requestSlots('slots:create:{}', 'create');
assert.equal(p._createErrorLabel.visible, false, 'retry clears old error');
p.onSlotsMessage({ rows: [], created: 1 });
assert.equal(p._slotCreateExpanded, false, 'successful create closes editor');
console.log('PASS: per-action spinner lifecycle, duplicate guards and inline creation errors');
