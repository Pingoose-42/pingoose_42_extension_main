const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('src/ui/indicator.js', 'utf8');
class Signals {
    constructor() {
        this.handlers = new Map();
        this.next = 1;
    }
    connect(name, callback) {
        const id = this.next++;
        this.handlers.set(id, { name, callback });
        return id;
    }
    disconnect(id) {
        assert.ok(this.handlers.delete(id), 'disconnect a live signal');
    }
    emit(name) {
        for (const handler of this.handlers.values()) if (handler.name === name) handler.callback();
    }
}
const settings = Object.assign(new Signals(), { enable_animations: true });
const preferences = Object.assign(new Signals(), {
    active: true,
    get_boolean() {
        return this.active;
    },
});
const timers = new Map();
const icons = [];
let now = 1000000,
    nextTimer = 1;
const context = {
    imports: {
        misc: {
            extensionUtils: {
                getSettings: () => preferences,
                getCurrentExtension: () => ({ path: path.resolve('src') }),
            },
        },
    },
    Gio: {
        File: { new_for_path: (file) => file },
        FileIcon: class {
            constructor({ file }) {
                this.file = file;
                icons.push(this);
            }
        },
    },
    St: {
        Icon: class extends Signals {
            constructor(properties) {
                super();
                Object.assign(this, properties);
                this.mapped = false;
            }
        },
        Settings: { get: () => settings },
    },
    GLib: {
        PRIORITY_DEFAULT: 0,
        SOURCE_CONTINUE: true,
        get_monotonic_time: () => now,
        timeout_add(_priority, interval, callback) {
            assert.equal(interval, 67, 'approximately 15 frames per second');
            const id = nextTimer++;
            timers.set(id, callback);
            return id;
        },
        source_remove(id) {
            assert.ok(timers.delete(id), 'remove an existing timer exactly once');
        },
    },
};
vm.createContext(context);
vm.runInContext(
    'class Probe {' +
        source.slice(
            source.indexOf('    _initFlapIcon()'),
            source.indexOf('    checkProfileReady()')
        ) +
        '}; globalThis.Probe = Probe;',
    context
);
const indicator = new context.Probe();
indicator.count = { text: 'New 2' };
indicator._initFlapIcon();
assert.equal(icons.length, 12);
for (let index = 0; index < 12; index++) {
    assert.ok(icons[index].file.endsWith(`flap-${String(index).padStart(2, '0')}-symbolic.svg`));
    const svg = fs.readFileSync(icons[index].file, 'utf8');
    assert.match(svg, /viewBox="0 0 16 16"/);
}
assert.equal(indicator.icon.gicon, icons[0]);
assert.equal(indicator.icon.style_class, 'system-status-icon');
assert.equal(indicator.icon.icon_size, 24, 'flap icon is larger than the default 16px panel icon');
assert.equal(timers.size, 0, 'unmapped icon does not wake Shell');
indicator.icon.mapped = true;
indicator.icon.emit('notify::mapped');
assert.equal(timers.size, 1);
preferences.active = false;
preferences.emit('changed::topbar-animation');
assert.equal(timers.size, 0);
preferences.active = true;
preferences.emit('changed::topbar-animation');
assert.equal(timers.size, 1);
const started = now;
for (let frame = 1; frame <= 12; frame++) {
    now = started + frame * 67000;
    assert.equal([...timers.values()][0](), true);
    assert.equal(indicator.icon.gicon, icons[frame % 12], 'frames loop in order');
}
now = started + 5123000;
[...timers.values()][0]();
assert.equal(
    indicator.icon.gicon,
    icons[4],
    'wall-clock playback skips stale frames after a stall'
);
assert.equal(icons.length, 12, 'GIcons are reused rather than constructed per tick');
assert.equal(indicator.count.text, 'New 2', 'animation does not change notification counts');

settings.enable_animations = false;
settings.emit('notify::enable-animations');
assert.equal(timers.size, 0);
assert.equal(indicator.icon.gicon, icons[0], 'reduced motion shows a still frame');
settings.enable_animations = true;
settings.emit('notify::enable-animations');
settings.emit('notify::enable-animations');
assert.equal(timers.size, 1, 'repeated notifications do not accumulate timers');
indicator.icon.mapped = false;
indicator.icon.emit('notify::mapped');
assert.equal(timers.size, 0, 'hidden icon stops animating');
indicator.icon.mapped = true;
indicator.icon.emit('notify::mapped');
assert.equal(timers.size, 1, 'visible icon resumes');
indicator.icon.emit('destroy');
assert.equal(timers.size, 0, 'destroy removes the animation timer');
assert.equal(settings.handlers.size, 0, 'destroy disconnects shared settings');

settings.enable_animations = false;
const reduced = new context.Probe();
reduced._initFlapIcon();
reduced.icon.mapped = true;
reduced.icon.emit('notify::mapped');
assert.equal(timers.size, 0, 'initial reduced-motion preference is respected');
reduced.icon.emit('destroy');
assert.equal(settings.handlers.size, 0);
console.log(
    'PASS: bundled flap frames, ordered playback/loop, stall recovery, icon reuse, badge preservation, reduced motion, visibility and cleanup'
);
