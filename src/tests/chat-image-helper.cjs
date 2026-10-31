const assert = require('node:assert/strict');
const { moduleExport } = require('./helpers.cjs');
const Image = require('../models/chatImage.js');
const encode = (bytes) => Buffer.from(bytes).toString('base64');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 42]);
const payload = { mime: 'image/png', data: encode(png), size: png.length, name: 'photo.png' };
const thumbnail = { width: 1, height: 1, rowstride: 4, alpha: true, data: encode([1, 2, 3, 4]) };
const line = (value) => JSON.stringify(value) + '\n';
const tick = () => new Promise((resolve) => setImmediate(resolve));
let nextId = 1;
const timers = new Map();
let process;
let spawns = 0;
let deferWrites = false;
let writeLimit = Infinity;

class Bytes {
    constructor(bytes) {
        this.bytes = Buffer.from(bytes);
    }
    get_size() {
        return this.bytes.length;
    }
    get_data() {
        return this.bytes;
    }
    new_from_bytes(offset, length) {
        return new Bytes(this.get_data().subarray(offset, offset + length));
    }
}

class Cancellable {
    constructor() {
        this.handlers = new Map();
        this.cancelled = false;
        this.inCallback = false;
    }
    is_cancelled() {
        return this.cancelled;
    }
    connect(callback) {
        if (this.cancelled) {
            callback();
            return 0;
        }
        const id = nextId++;
        this.handlers.set(id, callback);
        return id;
    }
    disconnect(id) {
        assert.equal(
            this.inCallback,
            false,
            'disconnect must not deadlock inside cancelled callback'
        );
        this.handlers.delete(id);
    }
    cancel() {
        if (this.cancelled) return;
        this.cancelled = true;
        this.inCallback = true;
        for (const callback of [...this.handlers.values()]) callback();
        this.inCallback = false;
    }
}

class Output {
    constructor() {
        this.queue = [];
        this.closed = false;
        this.requests = [];
        this.eof = false;
    }
    read_bytes_async(count, priority, cancel, callback) {
        assert.equal(this.pending, undefined, 'only one outstanding read per pipe');
        this.requests.push(count);
        const request = { count, cancel, callback };
        this.pending = request;
        request.cancelId = cancel.connect(() => {
            if (this.pending === request) this.complete(request, Error('cancelled I/O'));
        });
        this.flush();
    }
    read_bytes_finish(value) {
        if (value instanceof Error) throw value;
        return { get_data: () => value };
    }
    complete(request, value) {
        this.pending = undefined;
        queueMicrotask(() => {
            if (request.cancelId) request.cancel.disconnect(request.cancelId);
            request.callback(this, value);
        });
    }
    flush() {
        const request = this.pending;
        if (!request) return;
        if (this.queue.length) {
            const bytes = this.queue.shift();
            if (bytes.length > request.count) this.queue.unshift(bytes.subarray(request.count));
            this.complete(request, bytes.subarray(0, request.count));
        } else if (this.eof) this.complete(request, new Uint8Array());
    }
    push(text) {
        this.queue.push(Buffer.from(text));
        this.flush();
    }
    end() {
        this.eof = true;
        this.flush();
    }
    close() {
        assert.equal(this.pending, undefined);
        this.closed = true;
    }
}

class Child {
    constructor(args, flags) {
        this.args = args;
        this.flags = flags;
        this.output = new Output();
        this.forced = false;
        this.input = {
            closed: false,
            write_bytes_async: (bytes, priority, cancel, callback) => {
                assert.ok(
                    bytes instanceof Bytes,
                    'native async writes own a refcounted GBytes buffer'
                );
                const count = Math.min(bytes.get_size(), writeLimit);
                this.stdin =
                    (this.stdin || '') +
                    Buffer.from(bytes.get_data().subarray(0, count)).toString();
                this.writeRef = new WeakRef(bytes);
                this.completeWrite = () => callback(this.input, { cancel, count });
                if (!deferWrites) queueMicrotask(this.completeWrite);
            },
            write_bytes_finish: ({ cancel, count }) => {
                if (cancel.is_cancelled()) throw Error('cancelled write');
                return count;
            },
            close() {
                this.closed = true;
            },
        };
    }
    get_stdin_pipe() {
        return this.input;
    }
    get_stdout_pipe() {
        return this.output;
    }
    wait_async(cancel, callback) {
        assert.equal(cancel, null, 'reaping must outlive I/O cancellation');
        this.wait = callback;
    }
    wait_finish() {
        this.reaped = true;
    }
    get_successful() {
        return this.success;
    }
    finish(success = true) {
        this.success = success;
        queueMicrotask(() => this.wait(this, {}));
    }
    force_exit() {
        this.forced = true;
        this.output.end();
        this.finish(false);
    }
}

const GLib = {
    Bytes,
    PRIORITY_DEFAULT: 0,
    SOURCE_REMOVE: false,
    timeout_add_seconds(priority, seconds, callback) {
        assert.equal(seconds, 30);
        const id = nextId++;
        timers.set(id, callback);
        return id;
    },
    source_remove: (id) => timers.delete(id),
    base64_encode: encode,
    base64_decode: (text) => Uint8Array.from(Buffer.from(text, 'base64')),
};
const Gio = {
    Cancellable,
    SubprocessFlags: { STDIN_PIPE: 1, STDOUT_PIPE: 2, STDERR_SILENCE: 4 },
    Subprocess: {
        new(args, flags) {
            spawns++;
            process = new Child(args, flags);
            return process;
        },
    },
};
const gi = new Proxy(
    { Gio, GLib },
    {
        get(target, name) {
            assert.ok(
                name === 'Gio' || name === 'GLib',
                'the Shell facade never loads GTK or compressed-image decoders'
            );
            return target[name];
        },
    }
);
const Helper = moduleExport(
    'services/chatImageHelper.js',
    '({choose, preview, validatePreview, PREVIEW_LIMIT})',
    {
        imports: {
            gi,
            byteArray: {
                toString: (bytes) => Buffer.from(bytes).toString('utf8'),
                fromString: (text) => Uint8Array.from(Buffer.from(text)),
            },
            misc: {
                extensionUtils: {
                    getCurrentExtension: () => ({
                        path: '/extension',
                        imports: { models: { chatImage: Image } },
                    }),
                },
            },
        },
    }
);
function complete(child, value) {
    child.output.push(line({ type: 'result', value }));
    child.output.end();
    child.finish();
}
function assertClean(child) {
    assert.equal(child.reaped, true);
    assert.equal(child.input.closed, true);
    assert.equal(child.output.closed, true);
    assert.equal(timers.size, 0);
}

(async () => {
    if (global.process.argv.includes('--buffer-lifetime')) {
        deferWrites = true;
        const work = Helper.preview(payload);
        const child = process;
        // The native API borrows a pointer: this double keeps only a WeakRef.
        for (let index = 0; index < 3; index++) {
            await tick();
            global.gc();
        }
        assert.ok(child.writeRef.deref(), 'stdin bytes survive GC until the async write finishes');
        child.completeWrite();
        complete(child, thumbnail);
        await work;
        for (let index = 0; index < 3; index++) {
            await tick();
            global.gc();
        }
        assert.equal(
            child.writeRef.deref(),
            undefined,
            'the completed callback releases its large write buffer'
        );
        assertClean(child);
        return;
    }
    assert.equal(Helper.validatePreview({ ...thumbnail, rowstride: 5 }), null);
    assert.equal(Helper.validatePreview({ ...thumbnail, width: 257 }), null);
    assert.equal(Helper.validatePreview({ ...thumbnail, height: 193 }), null);
    assert.equal(
        Helper.validatePreview({ ...thumbnail, data: 'AQIDBP==' }),
        null,
        'noncanonical base64 is rejected'
    );
    assert.equal(Helper.validatePreview({ ...thumbnail, data: encode([1, 2, 3]) }), null);
    assert.equal(Helper.validatePreview({ ...thumbnail, alpha: 1 }), null);
    await assert.rejects(Helper.preview({ ...payload, mime: 'image/jpeg' }), /invalid/);
    assert.equal(spawns, 0, 'invalid original payloads never spawn a decoder');
    const alreadyCancelled = new Cancellable();
    alreadyCancelled.cancel();
    await assert.rejects(Helper.choose(1, alreadyCancelled), /cancelled/);
    assert.equal(spawns, 0);

    let resolved = false;
    let work = Helper.preview(payload).then((value) => {
        resolved = true;
        return value;
    });
    let child = process;
    assert.deepEqual(Array.from(child.args), [
        '/usr/bin/gjs',
        '/extension/worker/chatImage.js',
        '--preview',
        '0',
    ]);
    assert.equal(child.flags, 7);
    await tick();
    assert.deepEqual(JSON.parse(child.stdin), payload);
    const output = line({ type: 'result', value: thumbnail });
    child.output.push(output.slice(0, 12));
    child.output.push(output.slice(12));
    child.output.end();
    await tick();
    assert.equal(resolved, false, 'valid output still waits for process exit');
    child.finish();
    assert.deepEqual(JSON.parse(JSON.stringify(await work)), thumbnail);
    assertClean(child);

    work = Helper.preview(payload);
    child = process;
    child.finish();
    await tick();
    child.output.push(line({ type: 'result', value: thumbnail }));
    child.output.end();
    await work;
    assertClean(child);

    writeLimit = 7;
    work = Helper.preview(payload);
    child = process;
    await tick();
    assert.equal(
        child.stdin,
        JSON.stringify(Image.validate(payload)),
        'short writes advance without duplicates or missing bytes'
    );
    complete(child, thumbnail);
    await work;
    assertClean(child);
    writeLimit = Infinity;

    const cancelled = new Cancellable();
    work = Helper.choose(123, cancelled);
    child = process;
    assert.equal(child.args[3], '123');
    child.output.push(line({ type: 'phase', value: 'choosing' }));
    await tick();
    assert.equal(timers.size, 0, 'the user may leave the native chooser open without a deadline');
    cancelled.cancel();
    await assert.rejects(work, /cancelled/);
    assert.equal(child.forced, true);
    assert.equal(cancelled.handlers.size, 0);
    assertClean(child);

    const duringWrite = new Cancellable();
    work = Helper.preview(payload, duringWrite);
    child = process;
    duringWrite.cancel();
    await assert.rejects(work, /cancelled/);
    assert.equal(duringWrite.handlers.size, 0);
    assertClean(child);

    work = Helper.choose(3);
    child = process;
    child.output.push(line({ type: 'phase', value: 'choosing' }));
    complete(child, null);
    assert.equal(await work, null, 'the chooser Cancel button is a normal empty result');
    assertClean(child);

    work = Helper.choose(3);
    child = process;
    child.output.push(line({ type: 'phase', value: 'choosing' }));
    child.output.push(line({ type: 'phase', value: 'processing' }));
    await tick();
    assert.equal(timers.size, 1, 'file reads and decoding have a fresh bounded deadline');
    complete(child, { image: payload, preview: thumbnail });
    assert.equal((await work).image.data, payload.data);
    assertClean(child);

    work = Helper.preview(payload);
    child = process;
    await tick();
    const [timerId, timeout] = [...timers][0];
    timers.delete(timerId);
    timeout();
    await assert.rejects(work, /too long/);
    assert.equal(child.forced, true);
    assertClean(child);

    for (const invalid of [
        line({ type: 'result', value: { ...thumbnail, width: 99999999 } }),
        line({ type: 'result', value: thumbnail }) + line({ type: 'result', value: thumbnail }),
        '{broken}\n',
        'x'.repeat(Helper.PREVIEW_LIMIT + 1),
    ]) {
        work = Helper.preview(payload);
        child = process;
        child.output.push(invalid);
        await assert.rejects(work, /prepare/);
        assert.equal(child.forced, true);
        assertClean(child);
    }

    work = Helper.preview(payload);
    child = process;
    child.output.push(line({ type: 'error', code: 'invalid-image' }));
    await assert.rejects(work, /damaged/);
    assertClean(child);
    work = Helper.preview(payload);
    child = process;
    child.output.push(line({ type: 'error', code: 'private/path/or/decoder/details' }));
    await assert.rejects(
        work,
        (error) =>
            error.message === 'Unable to prepare the image.' && error.code === 'helper-failed'
    );
    assertClean(child);
    work = Helper.preview(payload);
    child = process;
    child.output.push('{"type":"result"');
    child.output.end();
    child.finish();
    await assert.rejects(work, /prepare/);
    assertClean(child);
    work = Helper.preview(payload);
    child = process;
    child.output.end();
    child.finish(false);
    await assert.rejects(work, /prepare/);
    assertClean(child);
    const gcCheck = require('node:child_process').spawnSync(
        global.process.execPath,
        ['--expose-gc', __filename, '--buffer-lifetime'],
        { encoding: 'utf8' }
    );
    assert.equal(gcCheck.status, 0, gcCheck.stdout + gcCheck.stderr);
    console.log(
        'Chat image helper: bounded IPC, pixel validation, process reaping, cancellation and chooser/decode deadlines pass.'
    );
})().catch((error) => {
    console.error(error);
    global.process.exitCode = 1;
});
