const assert = require('node:assert/strict');
const { Actor, moduleExport } = require('./helpers.cjs');
const Size = moduleExport('models/panelSize.js', '({ MINIMUM_VIEWPORT })');
class Scroll extends Actor {
    constructor(props) {
        super(props);
        this.explicitHeights = [];
    }
    set height(value) {
        this._height = value;
        this.explicitHeights?.push(value);
    }
    get height() {
        return this._height;
    }
    set_policy(horizontal, vertical) {
        this.policy = [horizontal, vertical];
    }
    add_actor(child) {
        this.add_child(child);
    }
    contains(child) {
        for (let item = child; item; item = item.parent) if (item === this) return true;
        return false;
    }
    get_style() {
        return this.style;
    }
}
const focused = [];
const api = moduleExport('ui/panelViewport.js', '({ Viewport, mainViewport, sideViewport })', {
    imports: {
        gi: {
            Clutter: { ActorAlign: { START: 0 }, RequestMode: { HEIGHT_FOR_WIDTH: 0 } },
            St: { ScrollView: Scroll, PolicyType: { NEVER: 0, AUTOMATIC: 1 } },
        },
        misc: {
            util: {
                ensureActorVisibleInScrollView: (actor, focus) => focused.push([actor, focus]),
            },
            extensionUtils: {
                getCurrentExtension: () => ({ imports: { models: { panelSize: Size } } }),
            },
        },
    },
});
const menuBox = new Actor({ style_class: 'popup-menu-content pingoose-main-panel' });
const menuItem = new Actor();
menuBox.add_child(menuItem);
const main = api.mainViewport(menuBox);
assert.equal(menuItem.parent, menuBox, 'menu item parent survives viewport wrapping');
assert.equal(menuBox.parent, main);
assert.equal(main.overlay_scrollbars, true);
assert.equal(
    main.enable_mouse_scrolling,
    false,
    'automatic mode does not steal nested scroll events'
);
assert.deepEqual(main.policy, [0, 0]);
assert.match(main.style_class, /popup-menu-content/);
assert.doesNotMatch(menuBox.style_class, /popup-menu-content/);
const mainSize = new api.Viewport(main);
mainSize.apply(100);
assert.deepEqual(
    main.explicitHeights,
    [100],
    'a matching natural allocation still becomes explicitly fixed'
);
assert.equal(main.enable_mouse_scrolling, true);
mainSize.revealFocus(main);
assert.equal(focused.length, 0, 'scroll root focus does not call helper on itself');
mainSize.revealFocus(menuItem);
assert.equal(focused.length, 1);
mainSize.restore();
assert.equal(main.height, -1);
assert.equal(main.enable_mouse_scrolling, false);

const root = new Actor({ width: 300, height: 300, visible: false });
root.get_theme_node = () => ({
    adjust_for_width: (width) => width - 32,
    get_length: () => 8,
    adjust_preferred_height: (min, natural) => [min + 32, natural + 32],
});
const header = new Actor();
header.get_preferred_height = () => [24, 24];
const scroll = new Scroll({ height: 200 });
scroll.style = 'padding-right: 2px;';
const input = new Actor();
input.get_preferred_height = () => [28, 28];
root.add_child(header);
root.add_child(scroll);
root.add_child(input);
const frame = api.sideViewport(root);
assert.equal(root.visible, true, 'Reveal shows frame and original panel content');
assert.equal(frame.enable_mouse_scrolling, false);
let resets = 0;
const size = new api.Viewport(frame, scroll, () => resets++, root);
assert.equal(size.chromeHeight(), 100);
assert.equal(size.minimumHeight(), 164);
size.apply(300);
assert.equal(root.height, 300);
assert.equal(scroll.height, 200);
assert.deepEqual(
    scroll.explicitHeights,
    [200],
    'matching natural scroll allocation is fixed explicitly'
);
assert.deepEqual(frame.policy, [0, 0], 'normal side resize changes inner viewport only');
assert.match(scroll.style, /max-height: 4096px/);
header.get_preferred_height = () => [48, 48];
size.apply(300);
assert.equal(scroll.height, 176, 'dynamic header growth takes space from list, not controls');
assert.equal(root.height, 300);
size.apply(90);
assert.equal(frame.height, 90);
assert.equal(root.height, -1);
assert.equal(scroll.height, -1);
assert.equal(size.overflow, true);
assert.deepEqual(
    frame.policy,
    [0, 1],
    'tiny work area scrolls whole panel so buttons remain reachable'
);
size.revealFocus(input);
assert.equal(focused.at(-1)[1], input);
size.apply(400);
assert.equal(size.overflow, false);
assert.equal(scroll.height, 276);
assert.equal(frame.enable_mouse_scrolling, false);
size.restore();
assert.equal(root.height, -1);
assert.equal(frame.height, -1);
assert.equal(scroll.style, 'padding-right: 2px;');
assert.equal(resets, 2, 'natural measurement resumes on overflow and automatic reset');
size.apply(400);
size.restore(false);
assert.equal(resets, 2, 'teardown does not restart owner timers');

let measureLater;
const ProjectPanel = moduleExport('ui/projectPanel.js', 'ProjectPanel', {
    imports: {
        gi: {
            GLib: { SOURCE_REMOVE: false },
            Meta: {
                LaterType: { BEFORE_REDRAW: 0 },
                later_add: (_type, callback) => {
                    measureLater = callback;
                    return 1;
                },
            },
        },
        misc: {
            extensionUtils: {
                getCurrentExtension: () => ({
                    imports: { services: { projectNotes: {} }, ui: { noteTextLayout: {} } },
                }),
            },
        },
    },
});
const project = Object.create(ProjectPanel.prototype);
Object.assign(project, {
    panelSize: { naturalContent: false },
    list: { width: 240, get_preferred_height: () => [500, 500] },
    listScroll: { mapped: true, height: -1 },
    indicator: {},
});
project.syncListHeight();
assert.equal(
    measureLater,
    undefined,
    'custom viewport is not overwritten by automatic wrapping measurement'
);
project.panelSize.naturalContent = true;
project.syncListHeight();
project.panelSize.naturalContent = false;
measureLater();
assert.equal(
    project.listScroll.height,
    -1,
    'pending automatic measurement cannot overwrite a newly fixed viewport'
);
project.panelSize.naturalContent = true;
project.syncListHeight();
measureLater();
assert.equal(
    project.listScroll.height,
    260,
    'overflow fallback still measures wrapped project notes at their allocated width'
);
console.log(
    'PASS: original menu ownership, natural defaults, explicit sizes, flexible viewports, dynamic chrome, overflow fallback, focus and reset'
);
