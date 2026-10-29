const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
let enabled = true,
    callback,
    removed = 0;
const Controller = vm.runInNewContext(
    fs.readFileSync('src/ui/autoHideScrollbars.js', 'utf8') + '\nController',
    {
        imports: {
            gi: {
                Clutter: {},
                St: {},
                GLib: {
                    PRIORITY_DEFAULT: 0,
                    SOURCE_REMOVE: false,
                    timeout_add(_p, ms, fn) {
                        assert.equal(ms, 900);
                        callback = fn;
                        return 1;
                    },
                    source_remove() {
                        removed++;
                    },
                },
            },
        },
    }
);
const controller = Object.create(Controller.prototype);
controller.settings = { get_boolean: () => enabled };
const bar = { opacity: 255, reactive: true };
const state = { bars: [{ bar, opacity: 255, reactive: true }], timer: 0, dragging: false };
controller.apply(state);
assert.equal(bar.opacity, 0);
assert.equal(bar.reactive, false);
controller.activity(state);
assert.equal(bar.opacity, 255);
callback();
assert.equal(bar.opacity, 0);
state.dragging = true;
controller.activity(state);
assert.equal(bar.opacity, 255);
assert.equal(state.timer, 0);
state.dragging = false;
controller.activity(state);
enabled = false;
controller.apply(state);
assert.equal(bar.opacity, 255);
assert.ok(removed > 0);
console.log(
    'PASS: scrollbar idle hiding, activity reveal, drag protection and setting-off restoration'
);
