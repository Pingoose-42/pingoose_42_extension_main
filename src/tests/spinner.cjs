const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
class Signals {
    constructor(p = {}) {
        Object.assign(this, p);
        this.handlers = new Map();
    }
    connect(name, cb) {
        this.handlers.set(name, cb);
        return name;
    }
    disconnect(name) {
        this.handlers.delete(name);
    }
    emit(name) {
        this.handlers.get(name)?.();
    }
}
const timers = new Map(),
    settings = new Signals({ enable_animations: true });
let id = 0,
    time = 0;
const ctx = {
    imports: {
        misc: { extensionUtils: { getCurrentExtension: () => ({ path: 'src' }) } },
        gi: {
            Gio: {
                File: { new_for_path: (p) => p },
                FileIcon: class {
                    constructor(p) {
                        Object.assign(this, p);
                    }
                },
            },
            St: { Icon: Signals, Settings: { get: () => settings } },
            GLib: {
                get_monotonic_time: () => time,
                timeout_add: (_p, _ms, cb) => {
                    timers.set(++id, cb);
                    return id;
                },
                source_remove: (key) => timers.delete(key),
                SOURCE_CONTINUE: true,
            },
        },
    },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('src/ui/spinner.js', 'utf8'), ctx);
const icon = ctx.create(20);
assert.equal(timers.size, 0);
icon.mapped = true;
icon.emit('notify::mapped');
assert.equal(timers.size, 1);
time = 400000;
[...timers.values()][0]();
assert.match(icon.gicon.file, /spinner-12/);
for (let i = 0; i < 24; i++)
    assert(
        fs
            .readFileSync(
                'src/assets/spinner/spinner-' + String(i).padStart(2, '0') + '-symbolic.svg',
                'utf8'
            )
            .includes('<svg')
    );
icon.mapped = false;
icon.emit('notify::mapped');
assert.equal(timers.size, 0);
icon.mapped = true;
settings.enable_animations = false;
settings.emit('notify::enable-animations');
assert.equal(timers.size, 0);
icon.emit('destroy');
assert.equal(settings.handlers.size, 0);
console.log(
    'PASS: SVG frame assets, elapsed-time animation, unmapped pause, reduced motion and cleanup'
);
