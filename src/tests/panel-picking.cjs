const assert = require('node:assert/strict');
const { moduleExport } = require('./helpers.cjs');

class BoxLayout {
    constructor({ width = 0, height = 0, allocated = true, native = true } = {}) {
        Object.assign(this, { width, height, allocated, native });
    }
    vfunc_get_paint_volume(volume) {
        this.nativeCalls = (this.nativeCalls || 0) + 1;
        this.nativeVolume = volume;
        return this.allocated && this.native;
    }
}

let registration;
const Panel = moduleExport('ui/panelContent.js', 'Panel', {
    imports: {
        gi: {
            St: { BoxLayout },
            GObject: {
                registerClass(metadata, Type) {
                    registration = metadata;
                    return Type;
                },
            },
        },
    },
});
assert.equal(registration.GTypeName, 'PingoosePanelContent');
assert.equal(Object.getPrototypeOf(Panel.prototype), BoxLayout.prototype);

function volume(width, height, origin = { x: 0, y: 0, z: 0 }) {
    return {
        width,
        height,
        origin,
        get_width() {
            return this.width;
        },
        get_height() {
            return this.height;
        },
        set_width(value) {
            this.width = value;
        },
        set_height(value) {
            this.height = value;
        },
        // Any correction belongs to native StViewport. The local subclass must
        // not reinterpret or replace the origin, including scroll compensation.
        set_origin() {
            assert.fail('native paint-volume origin must remain untouched');
        },
    };
}

for (const origin of [
    { x: 0, y: 0, z: 0 },
    { x: 12, y: 84, z: 0 },
]) {
    const panel = new Panel({ width: 392, height: 300 });
    const bounds = volume(360, 268, origin);
    assert.equal(panel.vfunc_get_paint_volume(bounds), true);
    assert.equal(panel.nativeCalls, 1, 'native calculation runs exactly once');
    assert.equal(panel.nativeVolume, bounds);
    assert.equal(bounds.width, 392, 'paint/pick bounds include the right padding');
    assert.equal(bounds.height, 300, 'paint/pick bounds include the bottom padding');
    assert.equal(bounds.origin, origin);
}

const panel = new Panel({ width: 392, height: 300 });
const overflowing = volume(500, 900);
assert.equal(panel.vfunc_get_paint_volume(overflowing), true);
assert.equal(overflowing.width, 500, 'retain larger native horizontal content bounds');
assert.equal(overflowing.height, 900, 'retain larger native vertical content bounds');

for (const props of [{ native: false }, { allocated: false }]) {
    const unavailable = new Panel({ width: 392, height: 300, ...props });
    const untouched = volume(360, 268);
    assert.equal(unavailable.vfunc_get_paint_volume(untouched), false);
    assert.equal(untouched.width, 360);
    assert.equal(untouched.height, 268);
    assert.equal(unavailable.nativeCalls, 1);
}

const zero = new Panel();
const empty = volume(0, 0);
assert.equal(zero.vfunc_get_paint_volume(empty), true);
assert.equal(empty.width, 0);
assert.equal(empty.height, 0);
const retained = volume(30, 40);
assert.equal(zero.vfunc_get_paint_volume(retained), true);
assert.equal(retained.width, 30, 'zero allocation does not shrink valid native bounds');
assert.equal(retained.height, 40);

console.log(
    'PASS: local panel paint bounds include allocation, preserve native origin and larger bounds, and honor unavailable allocations'
);
