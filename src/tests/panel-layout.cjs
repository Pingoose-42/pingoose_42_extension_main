const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
const context = {
    imports: {
        misc: { extensionUtils: { getCurrentExtension: () => ({}) } },
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
const { Actor, Signals, controller: loadController, moduleExport } = require('./helpers.cjs');
class Columns extends Actor {
    insert_child_at_index(child, index) {
        this.children.splice(index, 0, child);
        child.parent = this;
    }
    set_child_below_sibling(child, sibling) {
        this.children.splice(this.children.indexOf(child), 1);
        this.children.splice(this.children.indexOf(sibling), 0, child);
    }
}
const hostMain = new Actor();
const mainFrame = new Columns();
const resizes = [];
let inputMethod;
const layoutSignals = new Signals();
const stage = new Signals();
stage.get_key_focus = () => null;
let child = hostMain,
    animation;
const close = function (value) {
    animation = value;
};
const host = {
    menu: {
        isOpen: true,
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
        misc: {
            extensionUtils: {
                getCurrentExtension: () => ({
                    imports: {
                        ui: {
                            mainContentSizer: {
                                Controller: class {
                                    constructor(actor, content, sections) {
                                        Object.assign(this, { actor, content, sections });
                                    }
                                    destroy() {
                                        this.destroyed = true;
                                    }
                                },
                            },
                            inputMethodPopup: {
                                Controller: class {
                                    constructor(menu) {
                                        this.menu = menu;
                                        inputMethod = this;
                                    }
                                    destroy() {
                                        this.destroyed = true;
                                    }
                                },
                            },
                            panelViewport: {
                                mainViewport(box) {
                                    mainFrame.add_child(box);
                                    return mainFrame;
                                },
                                sideViewport(panel) {
                                    const frame = new Columns();
                                    frame.add_child(panel);
                                    return frame;
                                },
                                Viewport: class {
                                    constructor(actor, scroll, onAutomatic, content, contentSizer) {
                                        Object.assign(this, {
                                            actor,
                                            scroll,
                                            onAutomatic,
                                            content,
                                            contentSizer,
                                        });
                                    }
                                    revealFocus() {}
                                },
                            },
                            panelResize: {
                                Controller: class {
                                    constructor(actor, viewport, settings, key, options) {
                                        Object.assign(this, {
                                            actor,
                                            viewport,
                                            settings,
                                            key,
                                            options,
                                        });
                                        resizes.push(this);
                                    }
                                    refresh() {}
                                    cancel() {
                                        this.cancelled = true;
                                    }
                                    destroy() {
                                        this.destroyed = true;
                                    }
                                },
                            },
                            reveal: {
                                Reveal: class extends Columns {
                                    constructor(content) {
                                        super({ visible: false });
                                        this.childActor = content;
                                        this.add_child(content);
                                    }
                                    setExpanded(visible) {
                                        this.visible = visible;
                                    }
                                },
                            },
                            popupMotion: {
                                Controller: class {
                                    constructor(menu) {
                                        this.menu = menu;
                                        this.close = menu.close;
                                        menu.close = () => this.close.call(menu, 0);
                                    }
                                    destroy() {
                                        this.menu.close = this.close;
                                    }
                                },
                            },
                        },
                        models: {
                            panelSize: {
                                availableHeight: moduleExport(
                                    'models/panelSize.js',
                                    'availableHeight'
                                ),
                            },
                        },
                    },
                }),
            },
        },
        gi: {
            St: { BoxLayout: Columns, Side: { TOP: 0, BOTTOM: 1 } },
            Clutter: { RequestMode: {}, ActorAlign: {} },
        },
        ui: {
            boxpointer: { PopupAnimation: { NONE: 0 } },
            main: { layoutManager: layoutSignals },
        },
    },
    global: { display: new Signals(), stage },
});
const layout = new Layout(host, { get_int: () => 0 });
assert.equal(resizes[0].viewport.content, hostMain, 'main sizing measures the original menu box');
assert.equal(resizes[0].viewport.contentSizer, layout._mainContentSizer);
assert.equal(inputMethod.menu, host.menu, 'layout owns the input-method popup integration');
const side = new Actor();
host.addPanel(side);
host.bringPanelNearMain(side);
assert.equal(host.sideColumns.children.at(-1), mainFrame);
assert.equal(host.menu.box, hostMain, 'Shell retains the original menu item parent');
assert.equal(hostMain.parent, mainFrame);
assert.equal(child, host.sideColumns);
host.menu.close();
assert.equal(animation, 0);
const servicePanel = new Actor(),
    projectPanel = new Actor();
host.addPanel(servicePanel);
host.addPanel(projectPanel);
host.bringPanelNearMain(servicePanel);
host.bringPanelNearMain(projectPanel);
host.bringPanelNearMain(side);
assert.deepEqual(
    host.sideColumns.children.map((child) => child.childActor || child),
    [servicePanel, projectPanel, side, mainFrame]
);
host.setPanelVisible(side, true);
assert.equal(host.sideColumns.children[2].visible, true);
host.placePanelBefore(servicePanel, side);
assert.deepEqual(
    host.sideColumns.children.map((child) => child.childActor || child),
    [projectPanel, servicePanel, side, mainFrame]
);
const sizedPanel = new Actor();
const resize = host.addPanel(sizedPanel, { key: 'chat-panel-height', scroll: new Actor() });
assert.equal(resize.key, 'chat-panel-height');
assert.equal(resize.viewport.content, sizedPanel);
assert.equal(resize.actor.get_children()[0], sizedPanel);
const favoritesPanel = new Actor();
const favoriteResize = host.addPanel(favoritesPanel, {
    scroll: new Actor(),
    key: 'favorites-panel-height',
});
assert.equal(
    favoriteResize.key,
    'favorites-panel-height',
    'favorites has its own persisted height key'
);
host.setPanelVisible(sizedPanel, false);
assert.equal(resize.cancelled, true, 'closing a side panel cancels its resize immediately');
layoutSignals.findIndexForActor = () => 0;
layoutSignals.getWorkAreaForMonitor = () => ({ y: 30, height: 1000 });
host.get_transformed_position = () => [200, 0];
host.get_transformed_size = () => [40, 30];
mainFrame.get_transformed_size = () => [500, 600];
mainFrame.height = 300;
host.sideColumns.get_theme_node = () => ({ get_padding: () => 12 });
assert.equal(
    layout._resizeBounds(mainFrame).maximum,
    484,
    'work area uses actor scale and measured theme padding'
);
layout._bottom = true;
host.get_transformed_position = () => [200, 1030];
assert.equal(
    layout._resizeBounds(mainFrame).maximum,
    484,
    'bottom anchor uses available area above the bar'
);
const background = 'background-color: rgba(255, 241, 246, 0.60);';
mainFrame.opacity = 201;
sizedPanel.opacity = 222;
layout.applyPanelAppearance(background);
layout.applyPanelLayout();
assert.equal(mainFrame.style, background);
assert.equal(sizedPanel.style, background, 'paint the side root, not its margin/scroll frame');
assert.equal(
    side.style,
    `margin-right: 0px; ${background}`,
    'unsized fallback preserves its background'
);
assert.equal(resize.actor.style?.includes('background-color') || false, false);
assert.equal(mainFrame.height, 300, 'color changes do not alter saved/custom panel heights');
assert.equal(mainFrame.opacity, 201, 'popup animation opacity is untouched');
assert.equal(sizedPanel.opacity, 222, 'content is not faded with the panel background');
const laterPanel = new Actor();
host.addPanel(laterPanel, { key: 'service-panel-height', scroll: new Actor() });
assert.equal(laterPanel.style, background, 'panels added later inherit the active background');
layout.applyPanelAppearance('background-color: rgba(246, 247, 249, 1.00);');
layout.applyPanelLayout();
assert.equal(mainFrame.style, 'background-color: rgba(246, 247, 249, 1.00);');
assert.equal(laterPanel.style, mainFrame.style, 'reset/theme changes update hidden panels too');
console.log(
    'PASS: background-only transparency preserves panel sizing, spacing and animation opacity'
);
layout.destroy();
layout.destroy();
assert.doesNotThrow(() => layout.applyPanelAppearance(background));
assert.equal(host.menu.close, close);
assert.equal(host.bringPanelNearMain, null);
assert.ok(resizes.every((resize) => resize.destroyed));
assert.equal(inputMethod.destroyed, true);
assert.equal(layout._mainContentSizer.destroyed, true);
assert.equal(layoutSignals.signals.size, 0);
assert.equal(stage.signals.size, 0);
console.log('PASS: shared panel host belongs to layout and restores popup callbacks on teardown');
