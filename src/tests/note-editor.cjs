const assert = require('node:assert/strict');
const { moduleExport, Actor } = require('./helpers.cjs');
let next = 1,
    caret = { y: 500, height: 20 },
    measured = 560;
const laters = new Map();
const layout = {
    measure: () => measured,
    logicalLinePositions: () => [{ y: 0 }, { y: 24 }],
    cursorBounds: () => caret,
};
const Me = { imports: { ui: { noteTextLayout: layout } } };
const Clutter = {
    ActorAlign: {},
    KEY_Return: 13,
    KEY_KP_Enter: 14,
    ModifierType: { CONTROL_MASK: 1, SUPER_MASK: 2 },
    EVENT_PROPAGATE: 0,
    EVENT_STOP: 1,
    ActorBox: class {
        constructor(props) {
            Object.assign(this, props);
        }
    },
};
let focus;
const Editor = moduleExport('ui/noteEditor.js', 'Editor', {
    global: { stage: { get_key_focus: () => focus, set_key_focus: (value) => (focus = value) } },
    imports: {
        gi: {
            Clutter,
            GLib: { SOURCE_REMOVE: false },
            Meta: {
                LaterType: {},
                later_add(_type, cb) {
                    const id = next++;
                    laters.set(id, cb);
                    return id;
                },
                later_remove: (id) => laters.delete(id),
            },
            Pango: { WrapMode: {} },
            St: {
                BoxLayout: Actor,
                Entry: Actor,
                Label: Actor,
                Widget: Actor,
                ScrollView: Actor,
                Button: Actor,
                PolicyType: {},
            },
        },
        misc: { extensionUtils: { getCurrentExtension: () => Me } },
    },
});
const editor = new Editor({ onSave() {}, onCancel() {} });
const frame = () => {
    for (const [id, cb] of [...laters]) {
        laters.delete(id);
        cb();
    }
};
editor.update('todo', { body: 'first\nsecond' });
editor.revealCursor();
assert.equal(laters.size, 1, 'coalesce text and layout events into one measurement');
frame();
frame();
assert.equal(editor.lineNumbers.children.length, 2);
assert.equal(editor.body.height, measured + 20);
const adjustment = editor.bodyScroll.adjustment;
assert.equal(adjustment.value, 390, 'reveal bottom caret after height allocation');
caret = { y: 420, height: 20 };
editor.revealCursor();
frame();
frame();
assert.equal(adjustment.value, 390, 'editing inside viewport preserves scroll');
caret = { y: 100, height: 20 };
editor.revealCursor();
frame();
frame();
assert.equal(
    adjustment.value,
    110,
    'moving above viewport reveals caret without jumping to bottom'
);
const text = editor.body.clutter_text;
const event = (state) => ({ get_key_symbol: () => 13, get_state: () => state });
assert.equal(text.emit('key-press-event', event(0)), 1);
assert(text.deleted);
assert.equal(text.inserted, 10, 'use native Unicode insertion at current cursor');
assert.equal(text.emit('key-press-event', event(1)), 0);
editor.update('note', { title: 'Title', body: 'One long line' });
assert.equal(editor.name.visible, true);
assert.equal(editor.lineNumbers.visible, false);
assert.deepEqual(JSON.parse(JSON.stringify(editor.value)), {
    title: 'Title',
    body: 'One long line',
});
editor.destroy();
assert.equal(laters.size, 0);
assert.equal(adjustment.signals.size, 0);
assert(editor.root.destroyed);
console.log(
    'PASS: multiline editor caret scroll, stable middle edits, native newline insertion and cleanup'
);
