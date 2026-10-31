// Exercise real Gio pipes, child exit and cancellation without a Shell/display.
const { Gio, GLib } = imports.gi;
const ByteArray = imports.byteArray;
imports.searchPath.unshift(GLib.build_filenamev([GLib.get_current_dir(), 'src']));
const Image = imports.models.chatImage;
const root = GLib.build_filenamev([GLib.get_current_dir(), 'src']);
const [loaded, bytes] = Gio.File.new_for_path(root + '/services/chatImageHelper.js').load_contents(
    null
);
if (!loaded) throw Error('Helper source unavailable');
const children = [];
const helper = new Function('imports', ByteArray.toString(bytes) + '\nreturn {preview};')({
    gi: {
        GLib,
        Gio: {
            Cancellable: Gio.Cancellable,
            SubprocessFlags: Gio.SubprocessFlags,
            Subprocess: {
                new(argv, flags) {
                    const executable = GLib.getenv('PINGOOSE_TEST_GJS');
                    if (executable) argv[0] = executable;
                    const process = Gio.Subprocess.new(argv, flags);
                    children.push(process);
                    return process;
                },
            },
        },
    },
    byteArray: ByteArray,
    misc: {
        extensionUtils: {
            getCurrentExtension: () => ({ path: root, imports: { models: { chatImage: Image } } }),
        },
    },
});
function assert(condition, message) {
    if (!condition) throw Error(message);
}
const data =
    'iVBORw0KGgoAAAANSUhEUgAAAAcAAAADCAIAAADQoYKSAAAAEUlEQVR4nGNQWJWHiRhIEAUARqEZmdf6Ll4AAAAASUVORK5CYII=';
const image = {
    mime: 'image/png',
    data,
    size: GLib.base64_decode(data).length,
    name: 'fixture.png',
};
async function run() {
    const value = await helper.preview(image, new Gio.Cancellable());
    assert(value.width === 7 && value.height === 3, 'Native helper thumbnail dimensions');
    assert(
        GLib.base64_decode(value.data).length === value.rowstride * value.height,
        'Native pixels complete'
    );
    assert(children.at(-1).get_if_exited(), 'Successful decoder is reaped before resolve');

    // The raw original crosses real native pipes at the maximum accepted size.
    // PNG decoders ignore bytes after IEND; retain them to exercise byte limits.
    {
        const bytes = new Uint8Array(Image.MAX_BYTES);
        bytes.set(GLib.base64_decode(image.data));
        const large = { ...image, size: bytes.length, data: GLib.base64_encode(bytes) };
        const thumbnail = await helper.preview(large, new Gio.Cancellable());
        assert(
            thumbnail.width === 7 && thumbnail.height === 3,
            '10 MiB native pipe payload is accepted and decoded'
        );
        assert(children.at(-1).get_if_exited(), 'Large decoder is reaped before resolve');
    }

    let rejected = false;
    const corrupt = { mime: 'image/png', data: 'iVBORw0KGgo=', size: 8, name: 'bad.png' };
    try {
        await helper.preview(corrupt, new Gio.Cancellable());
    } catch (error) {
        rejected = error.code === 'invalid-image';
    }
    assert(rejected, 'Native decoder error is propagated with a fixed error code');
    assert(
        children.at(-1).get_if_exited() || children.at(-1).get_if_signaled(),
        'Failed decoder is reaped'
    );

    const before = children.length;
    const cancelled = new Gio.Cancellable();
    cancelled.cancel();
    try {
        await helper.preview(image, cancelled);
        throw Error('Cancelled request unexpectedly resolved');
    } catch (error) {
        assert(error.code === 'cancelled', 'Pre-cancelled request is rejected');
    }
    assert(children.length === before, 'Pre-cancelled requests do not spawn');

    const active = new Gio.Cancellable();
    const pending = helper.preview(image, active);
    active.cancel();
    try {
        await pending;
        throw Error('Active cancelled request unexpectedly resolved');
    } catch (error) {
        assert(error.code === 'cancelled', 'In-flight request is cancelled');
    }
    assert(
        children.at(-1).get_if_exited() || children.at(-1).get_if_signaled(),
        'Cancelled decoder is reaped'
    );
    print(
        'PASS: real Gio helper pipes deliver thumbnails, propagate decode failures and reap cancelled children'
    );
}
const loop = new GLib.MainLoop(null, false);
let failure = null;
run()
    .catch((error) => {
        failure = error;
    })
    .finally(() => loop.quit());
loop.run();
if (failure) throw failure;
