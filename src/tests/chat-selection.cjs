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
    connect(name, fn) {
        this[name] = fn;
    }
    emit(name) {
        this[name]?.(this);
    }
    peek_theme_node() {
        return this.themeNode || null;
    }
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

const message = panel._chatUi.log.children.at(-1).children[0];
const selection = message.clutter_text;
assert.equal(selection.selectionColor.green, 214);
assert.equal(selection.selectedColor.red, 16);

const themeNode = (colors) => ({
    lookup_color(property, inherit) {
        assert.equal(inherit, true, 'selection colors can inherit from the panel theme');
        assert.ok(['selection-background-color', 'selected-color'].includes(property));
        // An output color can still be present when lookup reports not found.
        return [Object.hasOwn(colors, property), colors[property] || { red: 255 }];
    },
});
const background = new context.Clutter.Color({ red: 158, green: 49, blue: 95, alpha: 255 });
const foreground = new context.Clutter.Color({ red: 255, green: 255, blue: 255, alpha: 255 });
message.themeNode = themeNode({
    'selection-background-color': background,
    'selected-color': foreground,
});
message.emit('style-changed');
assert.equal(selection.selectionColor, background, 'existing messages update to the current theme');
assert.equal(selection.selectedColor, foreground);

// Each absent property falls back independently instead of retaining stale colors.
message.themeNode = themeNode({ 'selected-color': foreground });
message.emit('style-changed');
assert.equal(selection.selectionColor.green, 214);
assert.equal(selection.selectedColor, foreground);
message.themeNode = themeNode({ 'selection-background-color': background });
message.emit('style-changed');
assert.equal(selection.selectionColor, background);
assert.equal(selection.selectedColor.red, 16);
message.themeNode = themeNode({});
message.emit('style-changed');
assert.equal(selection.selectionColor.green, 214);
assert.equal(selection.selectedColor.red, 16);

const styled = new Actor({
    themeNode: themeNode({
        'selection-background-color': background,
        'selected-color': foreground,
    }),
});
attach(styled);
assert.equal(
    styled.clutter_text.selectionColor,
    background,
    'already styled labels apply colors immediately'
);
assert.equal(styled.clutter_text.selectedColor, foreground);
assert.equal(message.text, '<b>plain message</b>');
assert.equal(selection.selectable, true);
assert.equal(selection.editable, false);
copied = null;
assert.equal(
    selection['key-press-event'](null, { get_state: () => 4, get_key_symbol: () => 67 }),
    1
);
assert.equal(copied, 'selected text', 'theme changes preserve plain-text Ctrl+C');
assert.equal(
    selection['key-press-event'](null, { get_state: () => 0, get_key_symbol: () => 99 }),
    0
);
console.log(
    'PASS: selection colors follow live theme changes with safe pre-stage and missing-color fallbacks'
);
