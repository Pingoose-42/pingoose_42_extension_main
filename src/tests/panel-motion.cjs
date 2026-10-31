const assert = require('node:assert/strict');
const { Actor, Signals, moduleExport, controller } = require('./helpers.cjs');
const settings = Object.assign(new Signals(), {
    enabled: true,
    duration: 200,
    get_boolean() {
        return this.enabled;
    },
    get_int() {
        return this.duration;
    },
});
const desktop = Object.assign(new Signals(), { enable_animations: true });
const Preferences = controller('ui/motionPreferences.js', {
    imports: {
        gi: { St: { Settings: { get: () => desktop } } },
        misc: { extensionUtils: { getSettings: () => settings } },
    },
});
const extensionUtils = {
    getCurrentExtension: () => ({
        imports: { ui: { motionPreferences: { Controller: Preferences } } },
    }),
};
class Widget extends Actor {
    _init(props) {
        Object.assign(this, props);
        this.transitions = new Map();
    }
    get_parent() {
        return this.parent;
    }
    destroy() {
        this.emit('destroy');
        super.destroy();
    }
    queue_relayout() {}
    notify(name) {
        this.emit('notify::' + name);
    }
    remove_transition(name) {
        this.transitions.delete(name);
    }
    ease_property(name, target, params) {
        this.transitions.set(name, { target, ...params });
    }
    set_allocation(box) {
        this.box = box;
    }
}
class Box {
    constructor(width = 300, height = 500) {
        this.x1 = this.y1 = 0;
        this.x2 = width;
        this.y2 = height;
    }
    get_width() {
        return this.x2 - this.x1;
    }
    get_height() {
        return this.y2 - this.y1;
    }
}
const Reveal = moduleExport('ui/reveal.js', 'Reveal', {
    imports: {
        gi: {
            GObject: {
                registerClass: (_meta, Type) =>
                    class extends Type {
                        constructor(...args) {
                            super();
                            this._init(...args);
                        }
                    },
                ParamSpec: { double() {} },
                ParamFlags: { READWRITE: 1 },
            },
            St: { Widget },
            Clutter: {
                RequestMode: {},
                AnimationMode: { EASE_OUT_CUBIC: 1 },
                ActorBox: Box,
                EVENT_STOP: 1,
                EVENT_PROPAGATE: 0,
            },
        },
        misc: { extensionUtils },
    },
});
function reveal(horizontal = false) {
    const child = new Actor();
    child.get_preferred_width = () => [300, 300];
    child.get_preferred_height = () => [200, 500];
    child.allocate = (box) => {
        child.box = box;
    };
    const actor = new Reveal(child, horizontal);
    const parent = new Actor({ mapped: true });
    parent.add_child(actor);
    return actor;
}
const section = reveal();
section.setExpanded(true);
let transition = section.transitions.get('progress');
assert.equal(transition.duration, 200);
section.setExpanded(true);
assert.equal(section.transitions.get('progress'), transition, 'polls must not restart motion');
section.progress = 0.6;
section.vfunc_allocate(new Box(300, 300));
assert.equal(section.childActor.box.get_height(), 500, 'scroll viewport retains full height');
assert.deepEqual(Array.from(section.vfunc_get_preferred_height(300)), [120, 300]);
section.setExpanded(false);
assert.equal(section.visible, true, 'collapse remains painted until completion');
assert.equal(section.emit('captured-event'), 1, 'closing content cannot accept clicks');
assert.equal(section.transitions.get('progress').duration, 120);
const stale = section.transitions.get('progress');
section.progress = 0.3;
section.setExpanded(true);
assert.equal(section.transitions.get('progress').duration, 140);
stale.onComplete();
assert.equal(section.visible, true, 'stale close cannot hide a reopened section');
section.transitions.get('progress').onComplete();
assert.equal(section.progress, 1);
section.vfunc_allocate(new Box(300, 240));
assert.equal(
    section.childActor.box.get_height(),
    240,
    'expanded viewport respects available height'
);
assert.equal(section.transitions.size, 0);
assert.equal(section.childActor.adjustment.value, 0);
section.childActor.adjustment.value = 220;
section.setExpanded(false);
section.transitions.get('progress').onComplete();
assert.equal(section.visible, false);
section.setExpanded(true, false);
assert.equal(section.childActor.adjustment.value, 220, 'collapse preserves scroll position');
section.setExpanded(false);
section.mapped = false;
section.emit('notify::mapped');
assert.equal(section.progress, 0);
assert.equal(section.transitions.size, 0, 'closing popup settles child transitions');
section.setExpanded(true, false);
section.hide();
section.emit('notify::mapped');
assert.equal(
    section.visible,
    false,
    'maintenance can hide an expanded section without it reopening itself'
);
section.parent.mapped = false;
section.setExpanded(false);
section.setExpanded(true);
assert.equal(section.progress, 1, 'hidden-parent restoration does not animate');
assert.equal(section.transitions.size, 0);
const side = reveal(true);
side.setExpanded(true);
side.progress = 0.4;
side.vfunc_allocate(new Box(120, 500));
assert.equal(side.childActor.box.x1, 0);
assert.equal(side.childActor.box.get_width(), 300, 'side content width never squeezes');
assert.equal(side.childActor.box.get_height(), 500);
assert.deepEqual(Array.from(side.vfunc_get_preferred_width(-1)), [120, 120]);
side.progress = 0.333;
assert.deepEqual(
    Array.from(side.vfunc_get_preferred_width(-1)),
    [100, 100],
    'side widths stay on the pixel grid'
);
section.progress = 0.333;
assert.deepEqual(
    Array.from(section.vfunc_get_preferred_height(300)),
    [67, 167],
    'section heights stay on the pixel grid'
);
settings.enabled = false;
settings.emit('changed::panel-animations');
assert.equal(side.progress, 1);
assert.equal(side.transitions.size, 0, 'turning animations off settles immediately');
side.setExpanded(false);
assert.equal(side.visible, false);
settings.enabled = true;
desktop.enable_animations = false;
side.setExpanded(true);
assert.equal(side.progress, 1, 'desktop reduced motion takes precedence');
section.destroy();
side.destroy();
assert.equal(settings.signals.size, 0);
assert.equal(desktop.signals.size, 0, 'no shared setting signals retained');
console.log(
    'PASS: reveal reversal, stale completion, stable text/scroll allocation, restore, maintenance, reduced motion and disposal'
);

// Exercise Shell popup integration: preserve native state/grabs and retime fade.
desktop.enable_animations = true;
const menu = new Signals();
menu.actor = new Actor({ visible: false });
menu.isOpen = false;
let fadeDuration,
    nativeAnimation,
    bottom = false;
menu.actor.get_transition = () => ({
    set_duration(value) {
        fadeDuration = value;
    },
});
menu._boxPointer = {
    open() {
        menu.actor.visible = true;
    },
};
const open = (menu.open = function (animation) {
    this.isOpen = true;
    this.actor.visible = true;
    nativeAnimation = animation;
});
const close = (menu.close = function (animation) {
    this.isOpen = false;
    nativeAnimation = animation;
    if (!animation) {
        this.actor.visible = false;
        this.emit('menu-closed');
    }
});
const columns = new Widget();
columns._init({ translation_y: 0 });
columns.ease = (params) => {
    columns.motion = params;
};
const Motion = controller('ui/popupMotion.js', {
    imports: {
        gi: { Clutter: { AnimationMode: {} } },
        misc: { extensionUtils },
        ui: {
            boxpointer: { PopupAnimation: { NONE: 0, FADE: 2 } },
            environment: { adjustAnimationTime: (value) => value },
        },
    },
});
const motion = new Motion(menu, columns, () => bottom);
menu.open();
assert.equal(nativeAnimation, 2);
assert.equal(columns.translation_y, -12);
assert.equal(columns.motion.translation_y, 0);
assert.equal(fadeDuration, 200);
menu.close();
assert.equal(menu.isOpen, false, 'native close releases the popup immediately');
assert.equal(columns.motion.translation_y, -12);
menu.open();
assert.equal(menu.isOpen, true, 'shortcut reopens during closing transition');
menu.close(0);
assert.equal(columns.translation_y, 0);
bottom = true;
settings.duration = 500;
menu.open();
assert.equal(columns.translation_y, 12, 'bottom bar opens in the opposite direction');
assert.equal(columns.motion.duration, 500);
assert.equal(fadeDuration, 500);
menu.close();
menu.actor.visible = false;
menu.emit('menu-closed');
assert.equal(columns.translation_y, 0);
settings.enabled = false;
menu.open();
assert.equal(nativeAnimation, 0);
motion.destroy();
assert.equal(menu.open, open);
assert.equal(menu.close, close);
assert.equal(settings.signals.size, 0);
assert.equal(desktop.signals.size, 0);
console.log(
    'PASS: native popup lifecycle, configured fade/slide duration, rapid reopen, top/bottom direction and callback restoration'
);
