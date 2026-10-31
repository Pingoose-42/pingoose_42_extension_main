const assert = require('node:assert/strict');
const fs = require('node:fs');
const { moduleExport, Signals } = require('./helpers.cjs');

const choices = Array.from(moduleExport('models/themes.js', 'choices'), (choice) =>
    Array.from(choice)
);
assert.deepEqual(choices, [
    ['dark', 'Dark'],
    ['light', 'Light'],
    ['pink', 'Pink'],
    ['halloween', 'Halloween'],
    ['neon', 'Neon'],
]);
const schema = fs.readFileSync(
    'src/schemas/org.gnome.shell.extensions.pingoose.gschema.xml',
    'utf8'
);
const themeSchema = schema.match(/<key name="theme" type="s">([\s\S]*?)<\/key>/)?.[1];
assert.ok(themeSchema);
assert.deepEqual(
    [...themeSchema.matchAll(/<choice value="([^"]+)"\s*\/>/g)].map((match) => match[1]),
    choices.map(([id]) => id),
    'preferences and GSettings accept the same theme IDs'
);
assert.match(themeSchema, /<default>'dark'<\/default>/, 'existing dark default is retained');
const transparencySchema = schema.match(
    /<key name="panel-transparency" type="i">([\s\S]*?)<\/key>/
)?.[1];
assert.ok(transparencySchema, 'transparency is an integer preference');
assert.match(transparencySchema, /<range min="0" max="80"\s*\/>/);
assert.match(transparencySchema, /<default>0<\/default>/, 'existing solid appearance is retained');

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
class Combo extends Widget {
    constructor() {
        super();
        this.choices = [];
    }
    append(id, label) {
        this.choices.push([id, label]);
    }
}
class Spin extends Widget {
    static new_with_range(min, max, step) {
        return new Spin({ min, max, step });
    }
}
const flags = { DEFAULT: 0, GET: 1 };
const values = new Map([
    ['theme', 'dark'],
    ['panel-transparency', 0],
    ['reset-status', ''],
]);
const bindings = new Map();
const settings = {
    get_string: (key) => values.get(key) || '',
    bind(key, widget, property, mode) {
        const bound = bindings.get(key) || [];
        bound.push({ widget, property, mode });
        bindings.set(key, bound);
        let value = values.get(key);
        Object.defineProperty(widget, property, {
            configurable: true,
            get: () => value,
            set(next) {
                if (next === value) return;
                value = next;
                widget.emit(`notify::${property}`);
            },
        });
        if (mode === flags.DEFAULT)
            widget.connect(`notify::${property}`, () => settings.set(key, widget[property]));
    },
    set(key, value) {
        values.set(key, value);
        for (const { widget, property } of bindings.get(key) || []) widget[property] = value;
    },
};
const common = {
    sectionHeading(parent, label) {
        parent.append(new Widget({ label }));
    },
    row(parent, label, control) {
        const row = new Widget({ spacing: 24 });
        row.append(new Widget({ label }));
        row.append(control);
        parent.append(row);
    },
};
const extension = {
    imports: {
        models: { themes: { choices } },
        preferences: {
            common,
            panelShortcut: { append() {} },
            calendarRetention: { append() {} },
        },
    },
};
const build = moduleExport('preferences/general.js', 'build', {
    imports: {
        gi: {
            Gtk: {
                Box: Widget,
                Label: Widget,
                Button: Widget,
                Switch: Widget,
                SpinButton: Spin,
                ComboBoxText: Combo,
                Orientation: { VERTICAL: 1 },
                Align: { CENTER: 1 },
            },
            Gio: { SettingsBindFlags: flags },
            GLib: {},
        },
        misc: { extensionUtils: { getCurrentExtension: () => extension } },
    },
});
const page = build(settings);
const theme = bindings.get('theme')[0];
const transparency = bindings.get('panel-transparency')[0];
assert.deepEqual(theme.widget.choices, choices, 'chooser uses the shared theme model');
assert.equal(theme.property, 'active-id');
assert.equal(theme.mode, flags.DEFAULT);
assert.equal(transparency.property, 'value');
assert.equal(transparency.mode, flags.DEFAULT);
assert.equal(theme.widget['active-id'], 'dark');
assert.equal(transparency.widget.value, 0);
assert.deepEqual(
    [transparency.widget.min, transparency.widget.max, transparency.widget.step],
    [0, 80, 1]
);
assert.equal(transparency.widget.numeric, true);
assert.match(transparency.widget.tooltip_text, /0% = Solid/);
assert.match(transparency.widget.tooltip_text, /80% = Most transparent/);
const colorIndex = page.children.findIndex((row) => row.children[0]?.label === 'Color mode');
const transparencyRow = page.children[colorIndex + 1];
assert.equal(transparencyRow.children[1], transparency.widget, 'transparency follows Color mode');
assert.equal(transparencyRow.spacing, 24, 'new control follows existing row spacing');
const label = transparencyRow.children[0];
assert.equal(label.label.replace('_', ''), 'Panel transparency (0–80%)');
assert.equal(label.use_underline, true);
assert.equal(label.mnemonic_widget, transparency.widget);
assert.match(page.children[colorIndex + 2].label, /backgrounds only/);
assert.match(page.children[colorIndex + 2].label, /Text and input fields stay opaque/);
assert.equal(page.spacing, 18, 'existing General page spacing is unchanged');

for (const [id] of choices) {
    theme.widget['active-id'] = id;
    assert.equal(values.get('theme'), id, 'each theme selection updates the saved setting');
    assert.equal(
        values.get('panel-transparency'),
        0,
        'theme selection does not change transparency'
    );
}
for (const value of [1, 40, 80, 0]) {
    transparency.widget.value = value;
    assert.equal(values.get('panel-transparency'), value, 'spin edits save transparency');
    assert.equal(values.get('theme'), 'neon', 'transparency does not change the selected theme');
}
settings.set('theme', 'light');
settings.set('panel-transparency', 65);
assert.equal(theme.widget['active-id'], 'light', 'external settings updates refresh the chooser');
assert.equal(transparency.widget.value, 65, 'external settings updates refresh the spin control');

// General reset discovers user preferences from the schema, including the new key.
const restore = moduleExport('models/settingsDefaults.js', 'restore');
const restored = [];
restore({
    settings_schema: { list_keys: () => ['theme', 'panel-transparency', 'reset-request'] },
    reset: (key) => restored.push(key),
});
assert.deepEqual(restored, ['theme', 'panel-transparency']);
console.log(
    'PASS: shared theme choices, solid defaults, accessible transparency and independent live bindings'
);
