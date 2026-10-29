const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
const source = fs.readFileSync('src/ui/chatPanel.js', 'utf8');
let copied;
class Actor {
    constructor(props = {}) {
        Object.assign(this, props);
        this.children = [];
        this.clutter_text = {
            set_selectable(v) {
                this.selectable = v;
            },
            set_editable(v) {
                this.editable = v;
            },
            set_selection_color(v) {
                this.selectionColor = v;
            },
            set_selected_text_color(v) {
                this.selectedColor = v;
            },
            connect(name, fn) {
                this[name] = fn;
            },
            get_selection: () => 'selected text',
        };
    }
    connect() {}
    add_child(child) {
        this.children.push(child);
    }
    get_children() {
        return this.children;
    }
}
const context = {
    wrapLabel: (x) => x,
    Clutter: {
        Color: class {
            constructor(props) {
                Object.assign(this, props);
            }
        },
        ActorAlign: { CENTER: 0, END: 1, START: 2 },
        ModifierType: { CONTROL_MASK: 4 },
        KEY_c: 99,
        KEY_C: 67,
        EVENT_STOP: 1,
        EVENT_PROPAGATE: 0,
    },
    St: {
        Label: Actor,
        BoxLayout: Actor,
        ClipboardType: { CLIPBOARD: 1 },
        Clipboard: { get_default: () => ({ set_text: (_type, text) => (copied = text) }) },
    },
};
const attach = vm.runInNewContext(
    fs.readFileSync('src/ui/selectableText.js', 'utf8') + '\nattach',
    { imports: { gi: { Clutter: context.Clutter, St: context.St } } }
);
context.Me = { imports: { ui: { selectableText: { attach } } } };
const Probe = vm.runInNewContext(
    '(class {' +
        source.slice(
            source.indexOf('    _appendChatEntry('),
            source.indexOf('    _isViewingChat(')
        ) +
        '})',
    context
);
const panel = new Probe();
panel._chatUi = { log: new Actor() };
for (const dir of ['in', 'out']) {
    panel._appendChatEntry({ dir, text: '<b>plain message</b>', time: '12:00' });
    const label = panel._chatUi.log.children.at(-1).children[0],
        text = label.clutter_text;
    assert.equal(label.text, '<b>plain message</b>');
    assert.equal(text.selectable, true);
    assert.equal(text.editable, false);
    assert.equal(text.reactive, true);
    assert.equal(
        text['key-press-event'](null, { get_state: () => 4, get_key_symbol: () => 99 }),
        1
    );
    assert.equal(copied, 'selected text');
}
console.log(
    'PASS: incoming/outgoing message bodies selectable, read-only and copied as plain text'
);

const selection = panel._chatUi.log.children.at(-1).children[0].clutter_text;
assert.equal(selection.selectionColor.green, 214);
assert.equal(selection.selectedColor.red, 16);
