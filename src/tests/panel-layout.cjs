const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
const context = {
    imports: {
        gi: { Clutter: { ActorAlign: { START: 0, END: 1 } } },
        ui: { main: { layoutManager: { findMonitorForActor: () => ({ y: 0, height: 1080 }) } } },
    },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('src/ui/layout.js', 'utf8'), context);
const main = {},
    older = {
        visible: true,
        set_style(s) {
            this.style = s;
        },
    },
    near = {
        visible: true,
        set_style(s) {
            this.style = s;
        },
    };
const columns = {
    get_children: () => [older, near, main],
    set_style(s) {
        this.style = s;
    },
};
const values = {
    'popup-top-margin': 6,
    'popup-left-margin': 9,
    'main-panel-gap': 12,
    'panel-gap': 12,
};
const controller = Object.create(context.Controller.prototype);
controller._indicator = { sideColumns: columns, menu: { box: main } };
controller._settings = { get_int: (key) => values[key] };
controller._applyPanelLayout();
assert.match(columns.style, /padding-top: 6px; padding-right: 9px/);
values['main-panel-gap'] = 0;
values['panel-gap'] = 4;
controller._applyPanelLayout();
assert.equal(older.style, 'margin-right: 4px;');
assert.equal(near.style, 'margin-right: 0px;');
near.visible = false;
controller._applyPanelLayout();
assert.equal(older.style, 'margin-right: 0px;');
console.log('PASS: default margins, independent gaps, zero gap and nearest visible panel');

controller._indicator.get_transformed_position = () => [100, 1050];
controller._indicator.height = 30;
controller._applyPanelLayout();
assert.equal(main.y_align, 1);
assert.equal(older.y_align, 1);
assert.equal(main.y_expand, false);
assert.match(columns.style, /padding-bottom: 6px/);
controller._indicator.get_transformed_position = () => [100, 0];
controller._applyPanelLayout();
assert.equal(main.y_align, 0);
assert.match(columns.style, /padding-top: 6px/);
console.log('PASS: bottom panel aligns all columns at the bottom; top panel remains top aligned');

// Layout owns the shared host independently of whether general chat is enabled.
const { Actor, controller: loadController } = require('./helpers.cjs');
class Columns extends Actor {
    set_child_below_sibling(child, sibling) {
        this.children.splice(this.children.indexOf(child), 1);
        this.children.splice(this.children.indexOf(sibling), 0, child);
    }
}
const hostMain = new Actor();
let child = hostMain,
    animation;
const close = function (value) {
    animation = value;
};
const host = {
    menu: {
        box: hostMain,
        actor: new Actor(),
        close,
        _boxPointer: {
            bin: {
                remove_child(actor) {
                    assert.equal(actor, child);
                    child = null;
                },
                set_child(actor) {
                    child = actor;
                },
            },
        },
    },
};
const Layout = loadController('ui/layout.js', {
    imports: {
        gi: { St: { BoxLayout: Columns }, Clutter: { RequestMode: {}, ActorAlign: {} } },
        ui: { boxpointer: { PopupAnimation: { NONE: 0 } } },
    },
});
const layout = new Layout(host, {});
const side = new Actor();
host.sideColumns.add_child(side);
host.bringPanelNearMain(side);
assert.equal(host.sideColumns.children.at(-1), hostMain);
assert.equal(child, host.sideColumns);
host.menu.close();
assert.equal(animation, 0);
const servicePanel = new Actor(),
    projectPanel = new Actor();
host.sideColumns.add_child(servicePanel);
host.sideColumns.add_child(projectPanel);
host.bringPanelNearMain(servicePanel);
host.bringPanelNearMain(projectPanel);
host.bringPanelNearMain(side);
assert.deepEqual(host.sideColumns.children, [servicePanel, projectPanel, side, hostMain]);
layout.destroy();
assert.equal(host.menu.close, close);
assert.equal(host.bringPanelNearMain, null);
console.log('PASS: shared panel host belongs to layout and restores popup callbacks on teardown');
