const assert = require('node:assert/strict');
const { controller } = require('./helpers.cjs');
let time = 10_000_000,
    timer,
    disconnects = 0;
const actors = [];
const signals = new Map();
const values = {
    'flash-count': 2,
    'flash-brightness': 100,
    'flash-thickness': 5,
    'flash-interval': 1,
};
const settings = {
    get_int: (key) => values[key],
    get_double: (key) => values[key],
    connect(type, fn) {
        signals.set(type, fn);
        return 1;
    },
    disconnect() {
        disconnects++;
    },
};
class Frame {
    constructor(props) {
        Object.assign(this, props);
        actors.push(this);
    }
    ease(options) {
        this.animation = options;
    }
    remove_all_transitions() {
        this.animation = null;
    }
    destroy() {
        this.destroyed = true;
    }
}
const platform = {
    GLib: {
        get_monotonic_time: () => time,
        timeout_add(_priority, delay, fn) {
            timer = { delay, fn };
            return 1;
        },
        source_remove() {
            timer = null;
        },
    },
    Clutter: { AnimationMode: { EASE_OUT_QUAD: 0 } },
    St: { Widget: Frame, Settings: { get: () => ({ enable_animations: true }) } },
    Main: {
        sessionMode: { isLocked: false },
        layoutManager: { monitors: [{ x: 0, y: 0, width: 100, height: 100 }] },
        uiGroup: { add_child() {} },
    },
};
const Flash = controller('ui/screenFlash.js', platform);
const flash = new Flash({}, settings, { get_boolean: () => true });
flash.show();
assert.equal(actors.length, 1);
assert.equal(actors[0].animation.opacity, 160);
assert.match(actors[0].style, /5px/);
flash.show();
assert.equal(actors.length, 1);
actors[0].animation.onComplete();
time += 500000;
actors[0].animation.onComplete();
assert.equal(timer.delay, 500);
time += 500000;
const pending = timer;
timer = null;
pending.fn();
assert.equal(actors.length, 2);
signals.get('changed::flash-count')();
assert.equal(actors[1].destroyed, true);
assert.equal(timer, null);
values['flash-count'] = 0;
flash.previewFlash();
assert.equal(actors.length, 2);
values['flash-count'] = 1;
values['flash-brightness'] = 200;
flash.previewFlash();
assert.equal(actors[2].animation.opacity, 255);
flash.destroy();
assert.equal(disconnects, 1);
assert.equal(actors[2].destroyed, true);
console.log(
    'PASS: flash defaults, cadence, no overlap, disabled effect, preview brightness and timer/actor cleanup'
);
