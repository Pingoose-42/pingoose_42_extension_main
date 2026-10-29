const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
class Actor {
    constructor(props = {}) {
        Object.assign(this, props);
        this.children = [];
    }
    pack_start(child) {
        this.children.push(child);
    }
    connect(signal, handler) {
        this[signal] = handler;
    }
    set_image(image) {
        this.image = image;
    }
    get_accessible() {
        return { set_name: (name) => (this.accessibleName = name) };
    }
    get_visible() {
        return this.visible !== false;
    }
    set_propagation_phase() {}
    show_all() {}
}
const context = {
    imports: {
        gi: {
            Gtk: {
                Box: Actor,
                Button: Actor,
                Image: { new_from_icon_name: (name) => ({ name }) },
                IconSize: { BUTTON: 1 },
                EventControllerKey: { new: () => new Actor() },
                PropagationPhase: { CAPTURE: 1 },
                accelerator_get_default_mod_mask: () => 7,
            },
            Gdk: { KEY_F5: 65474 },
        },
    },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('src/worker/navigation.js', 'utf8'), context);
let changed,
    back = false,
    forward = false;
const calls = [];
const view = {
    can_go_back: () => back,
    can_go_forward: () => forward,
    go_back: () => calls.push('back'),
    go_forward: () => calls.push('forward'),
    reload: () => calls.push('reload'),
    load_uri: (uri) => calls.push(uri),
    get_back_forward_list: () => ({ connect: (_signal, handler) => (changed = handler) }),
};
const bar = context.create(view);
assert.deepEqual(
    bar.children.map((child) => child.label || child.accessibleName),
    ['Back', 'Forward', 'Refresh']
);
assert.deepEqual(
    bar.children.map((child) => child.image.name),
    ['go-previous-symbolic', 'go-next-symbolic', 'view-refresh-symbolic']
);
bar.children[0].clicked();
assert.equal(calls.length, 0);
back = forward = true;
changed();
assert(bar.children[0].sensitive && bar.children[1].sensitive);
bar.children[0].clicked();
bar.children[1].clicked();
bar.children[2].clicked();
assert.deepEqual(calls, ['back', 'forward', 'reload']);
assert.equal(context.create(view).children.length, 3);
const source = fs.readFileSync('src/worker/webview.js', 'utf8');
assert.match(source, /this.loginWindow = true;\s*this.navigation.hide\(\)/);
console.log(
    'PASS: Back / Forward / Refresh order, history state, reload action; login navigation hidden'
);

const key = bar._refreshKeys['key-pressed'];
const before = calls.length;
assert.equal(key(null, 65474, 0, 0), true);
assert.equal(calls.length, before + 1);
assert.equal(key(null, 65474, 0, 1), false);
assert.equal(key(null, 65, 0, 0), false);
bar.visible = false;
assert.equal(key(null, 65474, 0, 0), false);
assert.equal(calls.length, before + 1);
console.log('PASS: F5 reloads once; other keys, modified keys and login view are ignored');
