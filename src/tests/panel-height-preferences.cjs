const assert = require('node:assert/strict');
const fs = require('node:fs');
const { moduleExport, Signals } = require('./helpers.cjs');

const heightKeys = [
    'main-panel-height',
    'chat-panel-height',
    'project-panel-height',
    'service-panel-height',
];
const schema = fs.readFileSync(
    'src/schemas/org.gnome.shell.extensions.pingoose.gschema.xml',
    'utf8'
);
const defaults = new Map();
for (const key of heightKeys) {
    const entry = schema.match(new RegExp(`<key name="${key}" type="i">([\\s\\S]*?)</key>`));
    assert.ok(entry, `${key} must be an integer schema key`);
    assert.match(entry[1], /<range min="0" max="4096"\s*\/>/);
    const defaultValue = Number(entry[1].match(/<default>(\d+)<\/default>/)[1]);
    assert.equal(defaultValue, 0, `${key} must preserve automatic sizing on upgrade`);
    defaults.set(key, defaultValue);
}

class Widget extends Signals {
    constructor(props = {}) {
        super();
        this.children = [];
        Object.assign(this, props);
    }
    append(child) {
        this.children.push(child);
    }
}
class Spin extends Widget {
    static new_with_range(min, max, step) {
        return new Spin({ min, max, step });
    }
    get value() {
        return this._value;
    }
    set value(value) {
        if (this._value === value) return;
        this._value = value;
        this.emit('notify::value');
    }
}
const values = new Map([
    ...defaults,
    ['popup-top-margin', 6],
    ['popup-left-margin', 9],
    ['main-panel-gap', 12],
    ['panel-gap', 12],
]);
const bindings = new Map();
const resets = [];
const settings = {
    bind(key, widget, property, flags) {
        assert.equal(property, 'value');
        assert.equal(flags, 'bidirectional');
        assert.ok(values.has(key), `unexpected setting ${key}`);
        bindings.set(key, widget);
        widget[property] = values.get(key);
        widget.connect(`notify::${property}`, () => values.set(key, widget[property]));
    },
    reset(key) {
        resets.push(key);
        this.set_int(key, defaults.get(key));
    },
    set_int(key, value) {
        values.set(key, value);
        bindings.get(key).value = value;
    },
};
const build = moduleExport('preferences/layout.js', 'build', {
    imports: {
        gi: {
            Gtk: {
                Box: Widget,
                Label: Widget,
                Button: Widget,
                SpinButton: Spin,
                Orientation: { VERTICAL: 1 },
            },
            Gio: { SettingsBindFlags: { DEFAULT: 'bidirectional' } },
        },
        misc: {
            extensionUtils: {
                getCurrentExtension: () => ({
                    imports: {
                        preferences: {
                            common: {
                                sectionHeading(parent, label) {
                                    parent.append(new Widget({ label }));
                                },
                                row(parent, label, control) {
                                    parent.append(new Widget({ label, children: [control] }));
                                },
                            },
                        },
                    },
                }),
            },
        },
    },
});
const page = build(settings);
const heightRows = page.children.filter((child) => child.children[0]?.mnemonic_widget);
assert.equal(heightRows.length, heightKeys.length);
for (const [index, key] of heightKeys.entries()) {
    const spin = bindings.get(key);
    assert.equal(spin.value, 0);
    assert.deepEqual([spin.min, spin.max, spin.step], [0, 4096, 1]);
    assert.equal(spin.numeric, true);
    const label = heightRows[index].children[0];
    assert.equal(label.mnemonic_widget, spin, 'each label activates its own spin control');
    assert.equal(label.use_underline, true);
    spin.value = 450 + index * 50;
    assert.equal(values.get(key), 450 + index * 50, 'keyboard edits update their own setting');
}
assert.equal(values.get('main-panel-gap'), 12, 'height controls leave panel spacing intact');

// A height changed by a Shell drag is reflected by the live settings binding.
settings.set_int('chat-panel-height', 615);
assert.equal(values.get('chat-panel-height'), 615);
assert.equal(bindings.get('chat-panel-height').value, 615);
const reset = page.children.find((child) => child.label === 'Reset panel heights');
assert.ok(reset);
reset.emit('clicked');
assert.deepEqual(resets, heightKeys, 'only height preferences are reset');
for (const key of heightKeys) {
    assert.equal(values.get(key), 0);
    assert.equal(bindings.get(key).value, 0, 'reset also refreshes the displayed value');
}
assert.equal(values.get('popup-top-margin'), 6);
assert.equal(values.get('main-panel-gap'), 12);

const restore = moduleExport('models/settingsDefaults.js', 'restore');
const restored = [];
restore({
    settings_schema: { list_keys: () => [...heightKeys, 'reset-request'] },
    reset: (key) => restored.push(key),
});
assert.deepEqual(
    restored,
    heightKeys,
    'full reset includes new heights but preserves control keys'
);
console.log('PASS: automatic height defaults, accessible bindings, independent edits and resets');
