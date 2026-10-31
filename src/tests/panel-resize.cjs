const assert = require('node:assert/strict');
const { Actor, Signals, moduleExport } = require('./helpers.cjs');
const Size = moduleExport(
    'models/panelSize.js',
    '({ clamp, isResizeEdge, dragHeight, availableHeight })'
);
const Clutter = {
    EVENT_PROPAGATE: false,
    EVENT_STOP: true,
    KEY_Escape: 27,
    EventType: { MOTION: 1, ENTER: 2, LEAVE: 3, BUTTON_PRESS: 4, BUTTON_RELEASE: 5, KEY_PRESS: 6 },
    ModifierType: { BUTTON1_MASK: 1 },
};
const pending = new Map();
let next = 1;
const Meta = {
    Cursor: { DEFAULT: 0, NORTH_RESIZE: 1, SOUTH_RESIZE: 2 },
    LaterType: { BEFORE_REDRAW: 0 },
    later_add(_type, callback) {
        const id = next++;
        pending.set(id, callback);
        return id;
    },
    later_remove(id) {
        pending.delete(id);
    },
};
const flush = () => {
    for (let count = 0; pending.size && count < 10; count++) {
        const callbacks = [...pending.values()];
        pending.clear();
        for (const callback of callbacks) callback();
    }
    assert.equal(pending.size, 0);
};
const stage = {
    current: null,
    grabs: [],
    grab(actor) {
        const grab = {
            dismissed: false,
            dismiss() {
                this.dismissed = true;
                stage.current = null;
            },
        };
        this.current = actor;
        this.grabs.push(grab);
        return grab;
    },
    get_grab_actor() {
        return this.current;
    },
};
const cursors = [];
const Resize = moduleExport('ui/panelResize.js', 'Controller', {
    imports: {
        gi: { Clutter, Meta },
        misc: {
            extensionUtils: {
                getCurrentExtension: () => ({ imports: { models: { panelSize: Size } } }),
            },
        },
    },
    global: { stage, display: { set_cursor: (cursor) => cursors.push(cursor) } },
});
class Settings extends Signals {
    constructor() {
        super();
        this.values = {};
        this.writes = [];
    }
    get_int(key) {
        return this.values[key] || 0;
    }
    set_int(key, value) {
        this.values[key] = value;
        this.writes.push([key, value]);
        this.emit(`changed::${key}`);
    }
}
const event = (type, y = 300, options = {}) => ({
    type: () => Clutter.EventType[type],
    get_coords: () => [options.x ?? 100, y],
    get_button: () => options.button ?? 1,
    get_state: () => options.state ?? 1,
    get_key_symbol: () => options.key ?? 27,
});
function fixture(settings = new Settings(), key = 'main-panel-height') {
    const actor = new Actor({ width: 400, height: 300 });
    actor.transform_stage_point = (x, y) => [true, x, y];
    const viewport = {
        fixed: false,
        heights: [],
        restores: 0,
        minimumHeight: () => 180,
        apply(height) {
            this.fixed = true;
            this.heights.push(height);
            actor.height = height;
        },
        restore() {
            if (this.fixed) {
                this.fixed = false;
                this.restores++;
                actor.height = 300;
            }
        },
    };
    const menu = new Signals();
    menu.isOpen = true;
    const bounds = { bottom: false, scale: 1, maximum: 800 };
    const options = { menu, ready: () => true, bounds: () => bounds };
    const resize = new Resize(actor, viewport, settings, key, options);
    return { actor, viewport, menu, bounds, resize, settings };
}

assert.equal(Size.isResizeEdge(0, 300, 400, 300, false), true, 'bottom-left corner resizes');
assert.equal(Size.isResizeEdge(400, 300, 400, 300, false), true, 'bottom-right corner resizes');
assert.equal(Size.isResizeEdge(100, 0, 400, 300, false), false, 'anchored edge stays inert');
assert.equal(Size.isResizeEdge(10, 0, 400, 300, true), true, 'bottom bar exposes top edge');
assert.equal(Size.isResizeEdge(401, 300, 400, 300, false), false, 'panel gap stays inert');
assert.equal(Size.clamp(900, 180, 100), 100, 'small monitor wins over minimum');
assert.equal(Size.dragHeight(300, 300, 500, 2, false, 180, 800), 400);
assert.equal(Size.dragHeight(300, 300, 100, 2, true, 180, 800), 400);

const f = fixture();
assert.equal(f.viewport.heights.length, 0, 'automatic default never fixes allocation');
assert.equal(f.resize.capture(event('MOTION', 300)), false);
assert.equal(cursors.at(-1), Meta.Cursor.SOUTH_RESIZE);
f.resize.capture(event('LEAVE', 300));
assert.equal(
    cursors.at(-1),
    Meta.Cursor.DEFAULT,
    'leave clears cursor even at last edge coordinates'
);
assert.equal(f.resize.capture(event('BUTTON_PRESS', 150)), false, 'content clicks propagate');
assert.equal(f.resize.capture(event('BUTTON_PRESS', 300, { button: 3 })), false);
assert.equal(f.resize.capture(event('BUTTON_PRESS', 300)), true);
assert.equal(
    f.resize.capture(event('MOTION', 420)),
    true,
    'active drag is consumed before child controls'
);
flush();
assert.equal(f.actor.height, 420);
assert.equal(f.settings.writes.length, 0, 'preview never broadcasts settings changes');
assert.equal(
    f.resize.capture(event('BUTTON_RELEASE', 420, { x: 900 })),
    true,
    'outside release is consumed'
);
flush();
assert.deepEqual(f.settings.writes, [['main-panel-height', 420]]);
assert.equal(stage.grabs.at(-1).dismissed, true);

f.resize.capture(event('BUTTON_PRESS', 420));
f.resize.dragEvent(event('MOTION', 600));
flush();
f.resize.capture(event('KEY_PRESS'));
flush();
assert.equal(f.actor.height, 420, 'Escape restores original custom height');
assert.equal(stage.grabs.at(-1).dismissed, false, 'cancelled release is still intercepted');
f.resize.capture(event('BUTTON_RELEASE', 600));
assert.equal(stage.grabs.at(-1).dismissed, true);
assert.equal(f.settings.writes.length, 1);

f.bounds.maximum = 250;
f.resize.refresh();
flush();
assert.equal(f.actor.height, 250);
assert.equal(
    f.settings.get_int('main-panel-height'),
    420,
    'work area clamp does not overwrite saved preference'
);
f.bounds.maximum = 800;
f.resize.refresh();
flush();
assert.equal(f.actor.height, 420);
f.settings.set_int('main-panel-height', 0);
assert.equal(f.viewport.fixed, false);

f.resize.capture(event('BUTTON_PRESS', 300));
f.resize.dragEvent(event('MOTION', 400));
flush();
f.actor.mapped = false;
f.actor.emit('notify::mapped');
assert.equal(f.resize.drag, null);
assert.equal(stage.grabs.at(-1).dismissed, true);
f.actor.mapped = true;
f.resize.capture(event('BUTTON_PRESS', 300));
stage.current = new Actor();
f.resize.capture(event('LEAVE'));
assert.equal(f.resize.drag, null, 'a competing modal/grab cancels resizing');
assert.equal(stage.grabs.at(-1).dismissed, true);

const bottom = fixture(f.settings, 'chat-panel-height');
bottom.bounds.bottom = true;
bottom.bounds.scale = 2;
bottom.resize.capture(event('BUTTON_PRESS', 0));
bottom.resize.dragEvent(event('MOTION', -100));
flush();
assert.equal(bottom.actor.height, 350, 'bottom anchor grows upward using actor scale');
bottom.resize.dragEvent(event('BUTTON_RELEASE', -100));
assert.equal(f.settings.get_int('main-panel-height'), 0);
assert.equal(f.settings.get_int('chat-panel-height'), 350);
bottom.resize.capture(event('BUTTON_PRESS', 0));
bottom.bounds.scale = 1;
bottom.resize.dragEvent(event('MOTION', -50));
assert.equal(bottom.resize.drag, null, 'scale change cancels instead of jumping');
bottom.resize.capture(event('BUTTON_PRESS', 0));
bottom.menu.emit('open-state-changed', false);
assert.equal(bottom.resize.drag, null);
bottom.resize.capture(event('BUTTON_PRESS', 0));
bottom.resize.destroy();
f.resize.destroy();
flush();
assert.equal(stage.grabs.at(-1).dismissed, true);
assert.equal(bottom.actor.signals.size, 0);
assert.equal(bottom.menu.signals.size, 0);
assert.equal(f.settings.signals.size, 0);
console.log(
    'PASS: independent panel sizes, scaled free-edge drag, preview/commit, Escape, work area clamp, competing grabs and lifecycle cleanup'
);
