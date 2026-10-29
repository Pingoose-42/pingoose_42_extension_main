const assert = require('node:assert/strict');
const { moduleExport, Signals } = require('./helpers.cjs');
const dialogs = [],
    changes = [];
let enabled = false,
    binding;
class Toggle extends Signals {
    set_active(value) {
        this.active = value;
        const handled = this.emit('state-set', value);
        if (!handled) this.state = value;
    }
}
class Dialog extends Signals {
    constructor(props) {
        super();
        Object.assign(this, props);
        this.buttons = [];
        dialogs.push(this);
    }
    add_button(label, response) {
        this.buttons.push([label, response]);
    }
    set_default_response(value) {
        this.default = value;
    }
    destroy() {
        this.destroyed = true;
    }
    present() {}
}
const settings = {
    bind(_key, toggle, _property, flags) {
        assert.equal(flags, 'read-only', 'confirmation must precede any settings write');
        binding = toggle;
        toggle.set_active(enabled);
    },
    get_boolean: () => enabled,
    set_boolean(_key, value) {
        enabled = value;
        changes.push(value);
        binding.set_active(value);
    },
};
const parent = new Signals();
parent.get_root = () => ({});
const append = moduleExport('preferences/calendarRetention.js', 'append', {
    imports: {
        gi: {
            Gtk: {
                Switch: Toggle,
                MessageDialog: Dialog,
                Align: {},
                MessageType: {},
                ButtonsType: {},
                ResponseType: { NO: 0, YES: 1 },
            },
            Gio: { SettingsBindFlags: { GET: 'read-only' } },
        },
        misc: {
            extensionUtils: {
                getCurrentExtension: () => ({ imports: { preferences: { common: { row() {} } } } }),
            },
        },
    },
});
const toggle = append(parent, settings);
toggle.set_active(true);
assert.equal(enabled, false);
assert.equal(toggle.active, false);
assert.equal(changes.length, 0);
assert.deepEqual(dialogs[0].buttons, [
    ['No', 0],
    ['Yes', 1],
]);
assert.equal(dialogs[0].default, 0);
assert.match(dialogs[0].secondary_text, /All past calendar events synced by Pingoose/);
toggle.set_active(true);
assert.equal(dialogs.length, 1, 'only one confirmation at a time');
dialogs[0].emit('response', 0);
assert.equal(enabled, false);
toggle.set_active(true);
dialogs[1].emit('response', -4); // Window close.
assert.equal(enabled, false);
toggle.set_active(true);
dialogs[2].emit('response', 1);
assert.equal(enabled, true);
assert.equal(toggle.active, true);
assert.deepEqual(changes, [true]);
toggle.set_active(false);
assert.equal(enabled, false);
assert.equal(dialogs.length, 3, 'disabling requires no confirmation');
toggle.set_active(true);
parent.emit('unmap');
assert(dialogs[3].destroyed);
dialogs[3].emit('response', 1);
assert.equal(enabled, false, 'closing settings cannot accept a stale dialog');
console.log(
    'PASS: English Yes/No confirmation, no early write, No/close cancellation and stale-dialog cleanup'
);
