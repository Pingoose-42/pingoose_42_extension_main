const assert = require('node:assert/strict');
const { controller, Actor, Signals } = require('./helpers.cjs');
const Model = require('../models/maintenance.js');
let time = 1000;
class Item extends Actor {
    constructor(props = {}) {
        super(props);
        this.actor = this;
    }
    remove_all_children() {
        this.children = [];
    }
}
class Menu extends Signals {
    constructor() {
        super();
        this.items = [];
        this.actor = new Actor();
        this.box = new Actor();
    }
    addMenuItem(item, index = this.items.length) {
        this.items.splice(index, 0, item);
        this.box.children.splice(index, 0, item.actor || item);
    }
    _getMenuItems() {
        return [...this.items];
    }
    addAction() {}
    close() {}
    destroy() {}
}
const menu = new Menu();
const profile = new Item(),
    normal = new Item(),
    unrelated = new Item({ visible: false });
menu.addMenuItem(profile);
menu.addMenuItem(normal);
menu.addMenuItem(unrelated);
const indicator = {
    menu,
    loginOnly: true,
    profileItem: profile,
    profileReady: false,
    lastProfile: { login: 'fixture', name: 'Fixture' },
    updateProfile() {},
    sideColumns: { get_children: () => [menu.box] },
};
const settings = Object.assign(new Signals(), { get_boolean: () => false });
const visibility = {
    sync() {
        profile.visible = normal.visible = !indicator.loginOnly;
    },
};
const schedule = { start: 2000, end: 62000 };
const me = {
    imports: {
        models: { maintenance: { ...Model, active: (value) => Model.active(value, time) } },
        ui: { spinner: { create: () => new Actor() } },
        dev: {
            menu: {
                Controller: class {
                    sync() {}
                },
            },
        },
    },
};
const imports = {
    gi: {
        Gio: {
            File: {
                new_for_path: () => ({
                    load_contents: () => [true, JSON.stringify({ login: 'fixture', schedule })],
                }),
            },
        },
        GLib: {
            get_user_name: () => 'fixture',
            get_user_cache_dir: () => '/cache',
            build_filenamev: (parts) => parts.join('/'),
            timeout_add_seconds: () => 1,
            source_remove() {},
        },
        St: {
            BoxLayout: Actor,
            Button: Actor,
            Label: Actor,
            Icon: Actor,
            Widget: Actor,
            Bin: Actor,
            Side: {},
        },
        Clutter: { ActorAlign: {} },
    },
    byteArray: { toString: (value) => value },
    ui: {
        popupMenu: { PopupBaseMenuItem: Item, PopupMenuSection: Item, PopupMenu: Menu },
        main: { uiGroup: { add_child() {} } },
    },
    misc: { extensionUtils: { getCurrentExtension: () => me } },
};
const Maintenance = controller('ui/maintenance.js', { imports, Date: { now: () => time } });
const maintenance = new Maintenance(
    indicator,
    () => visibility.sync(),
    () => {}
);
const Settings = controller('ui/settings.js', { imports });
Settings.prototype._applyTheme = () => {};
const bridge = { on: () => () => {}, send() {} };
const control = new Settings(indicator, bridge, settings, {
    maintenance,
    visibility,
    layout: { applyPanelLayout() {} },
    reset: { active: false },
    slots: { closeEditor() {} },
    agenda: { closeDetails() {} },
    notifications: { markRead() {} },
    optionsManager: { addMenu() {}, removeMenu() {} },
});
assert.equal(maintenance.item.visible, false, 'future maintenance hidden while signed out');
indicator.loginOnly = false;
indicator.onLoginStateChanged();
assert.equal(
    maintenance.item.visible,
    false,
    'login must not reveal maintenance before its timer runs'
);
assert.equal(normal.visible, true);
assert.equal(
    unrelated.visible,
    false,
    'settings must not override visibility owned by other components'
);
menu.emit('open-state-changed', true);
settings.emit('changed', 'theme');
assert.equal(
    maintenance.item.visible,
    false,
    'menu reopening and theme changes must not flash the card'
);
time = schedule.start;
maintenance.sync();
assert.equal(maintenance.active, true);
assert.equal(maintenance.item.visible, true);
menu.emit('open-state-changed', true);
assert.equal(maintenance.item.visible, true, 'actual maintenance remains visible');
assert.equal(normal.visible, false);
assert.equal(indicator.toolbarItem.visible, false);
maintenance.check();
maintenance.result('complete');
menu.emit('open-state-changed', true);
assert.equal(maintenance.item.visible, false, 'successful check stays bypassed on reopen');
maintenance.bypassEnd = null;
time = schedule.end;
indicator.onLoginStateChanged();
assert.equal(maintenance.item.visible, false, 'expired cached schedule stays hidden');
control.destroy();
maintenance.destroy();
console.log(
    'PASS: login/reload/menu/theme cannot reveal inactive maintenance; real windows and bypass still work'
);
