#!/usr/bin/gjs
// Compressed images and GTK stay in this disposable process, never in Shell.
imports.gi.versions.Gtk = '3.0';
imports.gi.versions.GdkPixbuf = '2.0';
const { Gio, GLib, Gtk, GdkPixbuf } = imports.gi;
const ByteArray = imports.byteArray;
const System = imports.system;
const SOURCE_ROOT = GLib.path_get_dirname(GLib.path_get_dirname(System.programPath));
imports.searchPath.unshift(SOURCE_ROOT);
const Image = imports.models.chatImage;
const INPUT_LIMIT = Math.ceil(Image.MAX_BYTES / 3) * 4 + 4096;

function failure(code) {
    return Object.assign(new Error(code), { code });
}

function joinBytes(chunks, size) {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return bytes;
}

// Read one extra byte to distinguish exactly-at-limit input from overflow.
async function readBounded(stream, limit) {
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const bytes = await new Promise((resolve, reject) => {
                stream.read_bytes_async(
                    Math.min(65536, limit + 1 - size),
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (input, result) => {
                        try {
                            resolve(input.read_bytes_finish(result).get_data());
                        } catch (error) {
                            reject(error);
                        }
                    }
                );
            });
            if (!bytes.length) return joinBytes(chunks, size);
            size += bytes.length;
            if (size > limit) throw failure('too-large');
            chunks.push(bytes);
        }
    } finally {
        try {
            stream.close(null);
        } catch (_) {
            /* Process exit also closes it. */
        }
    }
}

function pixels(pixbuf) {
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    const alpha = pixbuf.get_has_alpha();
    const channels = alpha ? 4 : 3;
    const sourceStride = pixbuf.get_rowstride();
    const rowstride = width * channels;
    if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > Image.PREVIEW_WIDTH ||
        height > Image.PREVIEW_HEIGHT ||
        pixbuf.get_colorspace() !== GdkPixbuf.Colorspace.RGB ||
        pixbuf.get_bits_per_sample() !== 8 ||
        pixbuf.get_n_channels() !== channels ||
        sourceStride < rowstride
    )
        throw failure('invalid-image');
    const source = pixbuf.read_pixel_bytes().get_data();
    if (source.length < sourceStride * (height - 1) + rowstride) throw failure('invalid-image');
    // GdkPixbuf may pad rows, and the final row need not contain that padding.
    const bytes = new Uint8Array(rowstride * height);
    for (let row = 0; row < height; row++)
        bytes.set(
            source.subarray(row * sourceStride, row * sourceStride + rowstride),
            row * rowstride
        );
    return { width, height, rowstride, alpha, data: GLib.base64_encode(bytes) };
}

function decode(bytes, mime) {
    if (Image.detectMime(bytes) !== mime) throw failure('invalid-image');
    let loader;
    let closed = false;
    let validSize = false;
    try {
        loader = GdkPixbuf.PixbufLoader.new_with_mime_type(mime);
        loader.connect('size-prepared', (source, width, height) => {
            const size = Image.fit(width, height);
            if (!size) return;
            validSize = true;
            source.set_size(size.width, size.height);
        });
        loader.write(bytes);
        // close validates truncated data as well as completing incremental decode.
        closed = true;
        loader.close();
        let pixbuf = loader.get_pixbuf();
        if (!validSize || !pixbuf) throw failure('invalid-image');
        pixbuf = pixbuf.apply_embedded_orientation();
        if (!pixbuf) throw failure('invalid-image');
        const size = Image.fit(pixbuf.get_width(), pixbuf.get_height());
        if (!size) throw failure('invalid-image');
        if (size.width !== pixbuf.get_width() || size.height !== pixbuf.get_height())
            pixbuf = pixbuf.scale_simple(size.width, size.height, GdkPixbuf.InterpType.BILINEAR);
        if (!pixbuf) throw failure('invalid-image');
        return pixels(pixbuf);
    } catch (_) {
        throw failure('invalid-image');
    } finally {
        if (loader && !closed) {
            try {
                loader.close();
            } catch (_) {
                /* Invalid/cancelled load. */
            }
        }
    }
}

async function fromFile(file) {
    const stream = await new Promise((resolve, reject) => {
        file.read_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
            try {
                resolve(source.read_finish(result));
            } catch (_) {
                reject(failure('read-failed'));
            }
        });
    });
    let bytes;
    try {
        bytes = await readBounded(stream, Image.MAX_BYTES);
    } catch (error) {
        throw failure(error.code === 'too-large' ? 'too-large' : 'read-failed');
    }
    const mime = Image.detectMime(bytes);
    if (!mime) throw failure('invalid-image');
    const image = Image.validate({
        mime,
        size: bytes.length,
        data: GLib.base64_encode(bytes),
        name: (file.get_basename() || 'image').slice(0, 128),
    });
    if (!image) throw failure('invalid-image');
    return { image, preview: decode(bytes, mime) };
}

function choose(timestamp, emit) {
    Gtk.init(null);
    return new Promise((resolve, reject) => {
        const dialog = new Gtk.FileChooserDialog({
            title: 'Send image',
            action: Gtk.FileChooserAction.OPEN,
            local_only: true,
            select_multiple: false,
        });
        dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
        dialog.add_button('Send image', Gtk.ResponseType.ACCEPT);
        dialog.set_default_response(Gtk.ResponseType.ACCEPT);
        const filter = new Gtk.FileFilter();
        filter.set_name('Images (PNG, JPEG, GIF, WebP; up to 10 MB)');
        for (const mime of Image.MIME_TYPES) filter.add_mime_type(mime);
        dialog.add_filter(filter);
        dialog.connect('response', (source, response) => {
            const file = response === Gtk.ResponseType.ACCEPT ? source.get_file() : null;
            source.destroy();
            if (!file) {
                resolve(null);
                return;
            }
            emit({ type: 'phase', value: 'processing' });
            fromFile(file).then(resolve, reject);
        });
        dialog.present_with_time(timestamp >>> 0);
        emit({ type: 'phase', value: 'choosing' });
    });
}

async function run(args, emit) {
    if (args[0] === '--choose') return choose(Number(args[1]) || 0, emit);
    if (args[0] !== '--preview') throw failure('invalid-request');
    const bytes = await readBounded(
        new Gio.UnixInputStream({ fd: 0, close_fd: false }),
        INPUT_LIMIT
    );
    let image;
    try {
        image = Image.validate(JSON.parse(ByteArray.toString(bytes)));
    } catch (_) {
        throw failure('invalid-request');
    }
    if (!image) throw failure('invalid-request');
    return decode(GLib.base64_decode(image.data), image.mime);
}

if (typeof ARGV !== 'undefined') {
    const loop = new GLib.MainLoop(null, false);
    const output = new Gio.UnixOutputStream({ fd: 1, close_fd: false });
    // Direct writes make phase changes visible before synchronous decoder work.
    const emit = (message) =>
        output.write_all(ByteArray.fromString(JSON.stringify(message) + '\n'), null);
    let exitCode = 0;
    run(ARGV, emit)
        .then(
            (value) => emit({ type: 'result', value }),
            (error) => {
                exitCode = 1;
                const codes = ['too-large', 'read-failed', 'invalid-image', 'invalid-request'];
                emit({
                    type: 'error',
                    code: codes.includes(error.code) ? error.code : 'helper-failed',
                });
            }
        )
        .finally(() => loop.quit());
    loop.run();
    System.exit(exitCode);
}
