const vm = require('node:vm'),
    fs = require('node:fs'),
    assert = require('node:assert/strict');
let time = 1000,
    timer;
class Actor {
    constructor() {
        this.visible = true;
        this.signals = new Map();
    }
    connect(n, fn) {
        this.signals.set(n, fn);
        return n;
    }
    disconnect(id) {
        this.signals.delete(id);
    }
    hide() {
        this.visible = false;
    }
    show() {
        this.visible = true;
    }
    add_child() {}
    set_child() {}
    remove_all_children() {}
    add_style_class_name() {}
    destroy() {}
    get_children() {
        return this.children || [];
    }
}
class Label extends Actor {
    constructor() {
        super();
        this.clutter_text = {};
    }
}
const profile = new Actor(),
    button = new Actor(),
    side = new Actor(),
    box = new Actor();
box.children = [profile, button];
const indicator = {
    profileItem: profile,
    profileReady: true,
    lastProfile: { login: 'fixture', name: 'Fixture' },
    updateProfile() {},
    sideColumns: { get_children: () => [box, side] },
    menu: { box, addMenuItem: (i) => box.children.push(i) },
};
const model = require('../models/maintenance.js');
let restored = 0;
const ctx = {
    Date: { now: () => time },
    imports: {
        gi: {
            Gio: {
                File: {
                    new_for_path: () => ({
                        load_contents() {
                            throw Error();
                        },
                    }),
                },
            },
            GLib: {
                build_filenamev: (a) => a.join('/'),
                get_user_cache_dir: () => '/tmp',
                get_user_name: () => 'fixture',
                timeout_add_seconds: (_p, _s, fn) => {
                    timer = fn;
                    return 1;
                },
                source_remove() {},
            },
            Clutter: { ActorAlign: { CENTER: 0 } },
            St: { Label, BoxLayout: Actor, Button: Actor, Icon: Actor, Bin: Actor, Widget: Actor },
        },
        ui: { popupMenu: { PopupBaseMenuItem: Actor } },
        misc: {
            extensionUtils: {
                getCurrentExtension: () => ({
                    imports: {
                        ui: { spinner: { create: () => new Actor() } },
                        models: { maintenance: { ...model, active: (s) => model.active(s, time) } },
                    },
                }),
            },
        },
    },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('src/ui/maintenance.js', 'utf8'), ctx);
const control = new ctx.Controller(indicator, () => restored++);
control.test();
assert(control.active);
assert(profile.visible);
assert(!button.visible);
assert(!side.visible);
time += 59999;
timer();
assert(control.active);
time++;
timer();
assert(!control.active);
assert(button.visible);
assert(side.visible);
assert.equal(restored, 1);
assert.equal(control.schedule, undefined, 'test must not replace actual schedule');
control.test();
control.refresh = () => {};
control.check();
assert(control.busy);
control.result('failed');
assert(control.active);
assert(control.failure.visible);
assert(!control.busy);
control.check();
control.result('complete');
assert(!control.active);
assert(button.visible);
control.sync();
assert(!control.active, 'successful check bypasses the same window');
control.destroy();
console.log('PASS: test maintenance hides controls, keeps profile and restores at 60 seconds');
