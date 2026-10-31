const assert = require('node:assert/strict');
const path = require('node:path');
const { moduleExport } = require('./helpers.cjs');
const Image = require('../models/chatImage.js');
const encode = (bytes) => Buffer.from(bytes).toString('base64');
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 42]);
const payload = { mime: 'image/png', data: encode(png), size: png.length, name: 'sample.png' };
let loader;
let nextPixbuf;
let writeError = false;
let closeError = false;
let sourceSize = [800, 600];
const loaders = [];
const Gtk = { ResponseType: { ACCEPT: 1, CANCEL: 0 }, FileChooserAction: { OPEN: 1 } };
const GLib = {
    path_get_dirname: path.dirname,
    PRIORITY_DEFAULT: 0,
    base64_encode: encode,
    base64_decode: (text) => Uint8Array.from(Buffer.from(text, 'base64')),
};
const ByteArray = {
    toString: (bytes) => Buffer.from(bytes).toString('utf8'),
    fromString: (text) => Uint8Array.from(Buffer.from(text)),
};
const Worker = moduleExport(
    'worker/chatImage.js',
    '({decode, pixels, readBounded, fromFile, choose, run})',
    {
        imports: {
            gi: {
                versions: {},
                Gio: {},
                GLib,
                Gtk,
                GdkPixbuf: {
                    Colorspace: { RGB: 0 },
                    InterpType: { BILINEAR: 2 },
                    PixbufLoader: {
                        new_with_mime_type(mime) {
                            loader = {
                                mime,
                                closes: 0,
                                connect(name, callback) {
                                    assert.equal(name, 'size-prepared');
                                    this.onSize = callback;
                                },
                                set_size(width, height) {
                                    this.size = [width, height];
                                },
                                write(bytes) {
                                    this.bytes = bytes;
                                    this.onSize(this, ...sourceSize);
                                    if (writeError) throw Error('corrupt');
                                },
                                close() {
                                    this.closes++;
                                    if (closeError) throw Error('truncated');
                                },
                                get_pixbuf() {
                                    return nextPixbuf;
                                },
                            };
                            loaders.push(loader);
                            return loader;
                        },
                    },
                },
            },
            byteArray: ByteArray,
            system: { programPath: '/src/worker/chatImage.js' },
            searchPath: [],
            models: { chatImage: Image },
        },
    }
);

function pixbuf(width, height, alpha, stride = width * (alpha ? 4 : 3), bytes) {
    const channels = alpha ? 4 : 3;
    return {
        get_width: () => width,
        get_height: () => height,
        get_has_alpha: () => alpha,
        get_rowstride: () => stride,
        get_colorspace: () => 0,
        get_bits_per_sample: () => 8,
        get_n_channels: () => channels,
        read_pixel_bytes: () => ({ get_data: () => bytes || new Uint8Array(stride * height) }),
        apply_embedded_orientation() {
            this.oriented = true;
            return this;
        },
        scale_simple(w, h, interpolation) {
            this.scaled = [w, h, interpolation];
            return pixbuf(w, h, alpha);
        },
    };
}

// Drop inter-row padding; the last row may be shorter than the source stride.
const padded = pixbuf(1, 2, false, 4, Uint8Array.from([1, 2, 3, 99, 4, 5, 6]));
assert.deepEqual(JSON.parse(JSON.stringify(Worker.pixels(padded))), {
    width: 1,
    height: 2,
    rowstride: 3,
    alpha: false,
    data: encode([1, 2, 3, 4, 5, 6]),
});
assert.throws(() => Worker.pixels(pixbuf(257, 1, true)), /invalid-image/);
assert.throws(() => Worker.pixels(pixbuf(1, 2, false, 4, new Uint8Array(6))), /invalid-image/);

nextPixbuf = pixbuf(256, 192, true);
const preview = Worker.decode(png, 'image/png');
assert.deepEqual(
    loader.size,
    [256, 192],
    'resize is requested before compressed pixels are decoded'
);
assert.equal(loader.closes, 1);
assert.equal(nextPixbuf.oriented, true);
assert.equal(preview.width, 256);
assert.equal(Buffer.from(preview.data, 'base64').length, 256 * 192 * 4);
sourceSize = [8, 6];
nextPixbuf = pixbuf(8, 6, false);
Worker.decode(png, 'image/png');
assert.deepEqual(loader.size, [8, 6], 'small originals are never enlarged');
sourceSize = [600, 800];
nextPixbuf = pixbuf(192, 256, false);
assert.equal(Worker.decode(png, 'image/png').height, 192);
assert.deepEqual(
    nextPixbuf.scaled,
    [144, 192, 2],
    'orientation is fitted back inside both thumbnail bounds'
);
assert.throws(() => Worker.decode(png, 'image/jpeg'), /invalid-image/);
writeError = true;
assert.throws(() => Worker.decode(png, 'image/png'), /invalid-image/);
assert.equal(loader.closes, 1, 'failed writes close the incremental loader');
writeError = false;
closeError = true;
assert.throws(() => Worker.decode(png, 'image/png'), /invalid-image/);
assert.equal(loader.closes, 1, 'truncated-image close is not retried');
closeError = false;

function stream(data, chunkSize = 3) {
    let offset = 0;
    return {
        reads: [],
        closed: false,
        read_bytes_async(count, priority, cancel, callback) {
            this.reads.push(count);
            const bytes = data.subarray(offset, offset + Math.min(count, chunkSize));
            offset += bytes.length;
            queueMicrotask(() => callback(this, bytes));
        },
        read_bytes_finish(bytes) {
            return { get_data: () => bytes };
        },
        close() {
            this.closed = true;
        },
    };
}

(async () => {
    const exact = stream(png);
    assert.deepEqual(Array.from(await Worker.readBounded(exact, png.length)), Array.from(png));
    assert.equal(exact.reads.at(-1), 1, 'one bounded EOF probe permits an exactly-at-limit image');
    assert.equal(exact.closed, true);
    const large = stream(new Uint8Array(10), 10);
    await assert.rejects(Worker.readBounded(large, 9), /too-large/);
    assert.deepEqual(large.reads, [10]);
    assert.equal(large.closed, true);

    nextPixbuf = pixbuf(1, 1, true);
    const file = {
        read_async(priority, cancel, callback) {
            queueMicrotask(() => callback(this, stream(png)));
        },
        read_finish: (value) => value,
        get_basename: () => 'a'.repeat(150) + '.png',
    };
    const selected = await Worker.fromFile(file);
    assert.equal(selected.image.data, payload.data, 'the sender keeps original compressed bytes');
    assert.equal(selected.image.name.length, 128);
    assert.equal(selected.preview.width, 1);

    let dialog;
    let initialized = 0;
    Gtk.init = () => initialized++;
    Gtk.FileFilter = class {
        set_name() {}
        add_mime_type() {}
    };
    Gtk.FileChooserDialog = class {
        constructor(props) {
            dialog = this;
            this.props = props;
            this.buttons = [];
        }
        add_button(label, response) {
            this.buttons.push([label, response]);
        }
        set_default_response() {}
        add_filter() {}
        connect(name, callback) {
            assert.equal(name, 'response');
            this.respond = callback;
        }
        present_with_time(time) {
            this.time = time;
        }
        get_file() {
            return file;
        }
        destroy() {
            this.destroyed = true;
        }
    };
    const phases = [];
    const cancelled = Worker.choose(123456, (event) => phases.push(event.value));
    assert.equal(initialized, 1);
    assert.equal(dialog.time, 123456, 'chooser uses the initiating event timestamp');
    assert.ok(dialog.buttons.some(([label, response]) => label === 'Send image' && response === 1));
    dialog.respond(dialog, Gtk.ResponseType.CANCEL);
    assert.equal(await cancelled, null);
    assert.equal(dialog.destroyed, true);
    assert.deepEqual(phases, ['choosing']);
    const chosen = Worker.choose(3, (event) => phases.push(event.value));
    dialog.respond(dialog, Gtk.ResponseType.ACCEPT);
    assert.equal((await chosen).image.data, payload.data);
    assert.deepEqual(phases, ['choosing', 'choosing', 'processing']);
    console.log(
        'Chat image worker: bounded file reads, original bytes, scaled pixel output and chooser lifecycle pass.'
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
