const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
let value = [],
    changed,
    opened = 0,
    registered = 0,
    removed = 0,
    handler,
    disconnected = false;
const settings = {
    get_strv: () => value,
    connect: (_name, callback) => ((changed = callback), 1),
    disconnect: () => (disconnected = true),
};
const Binding = vm.runInNewContext(
    fs.readFileSync('src/services/panelShortcut.js', 'utf8') + '\nBinding',
    {
        imports: {
            gi: {
                Meta: { KeyBindingFlags: { NONE: 0 } },
                Shell: { ActionMode: { NORMAL: 1, OVERVIEW: 2, POPUP: 4 } },
            },
            ui: {
                main: {
                    wm: {
                        addKeybinding(name, s, flags, modes, callback) {
                            assert.equal(name, 'panel-shortcut');
                            assert.equal(modes, 7);
                            registered++;
                            handler = callback;
                        },
                        removeKeybinding() {
                            removed++;
                        },
                    },
                },
            },
        },
    }
);
const binding = new Binding(settings, () => opened++);
assert.equal(registered, 0);
value = ['<Super>p'];
changed();
handler();
assert.equal(opened, 1);
value = ['<Control><Alt>p'];
changed();
assert.equal(registered, 2);
assert.equal(removed, 1);
value = [];
changed();
assert.equal(removed, 2);
binding.destroy();
assert.equal(disconnected, true);
console.log(
    'PASS: shortcut disabled by default, opens panel, rebinds and resets without stale bindings'
);

const menu = {
    isOpen: false,
    toggle() {
        this.isOpen = !this.isOpen;
    },
};
value = ['<Super>p'];
const toggling = new Binding(settings, () => menu.toggle());
handler();
assert.equal(menu.isOpen, true);
handler();
assert.equal(menu.isOpen, false);
toggling.destroy();
console.log('PASS: repeated shortcut opens and closes the menu, including popup input mode');
