// Shell receives only bounded, validated raw thumbnails from a separate decoder.
const { Gio, GLib } = imports.gi;
const ByteArray = imports.byteArray;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Image = Me.imports.models.chatImage;
const PIXEL_LIMIT = Image.PREVIEW_WIDTH * Image.PREVIEW_HEIGHT * 4;
const PREVIEW_LIMIT = Math.ceil(PIXEL_LIMIT / 3) * 4 + 4096;
const OUTPUT_LIMIT = Math.ceil(Image.MAX_BYTES / 3) * 4 + PREVIEW_LIMIT + 4096;
const TIMEOUT_SECONDS = 30;
const ERRORS = {
    'too-large': 'Images must be 10 MB or smaller.',
    'read-failed': 'Unable to read the selected image.',
    'invalid-image':
        'This image is damaged or its format is unavailable. Try PNG, JPEG, GIF or WebP.',
    'invalid-request': 'The image data is invalid.',
    'helper-failed': 'Unable to prepare the image.',
    timeout: 'Preparing the image took too long.',
    cancelled: 'Image preparation was cancelled.',
};

function failure(code) {
    const key =
        typeof code === 'string' && Object.prototype.hasOwnProperty.call(ERRORS, code)
            ? code
            : 'helper-failed';
    return Object.assign(new Error(ERRORS[key]), { code: key });
}

function validatePreview(value) {
    if (
        !value ||
        !Number.isInteger(value.width) ||
        !Number.isInteger(value.height) ||
        value.width < 1 ||
        value.width > Image.PREVIEW_WIDTH ||
        value.height < 1 ||
        value.height > Image.PREVIEW_HEIGHT ||
        typeof value.alpha !== 'boolean'
    )
        return null;
    const rowstride = value.width * (value.alpha ? 4 : 3);
    const size = rowstride * value.height;
    if (
        value.rowstride !== rowstride ||
        typeof value.data !== 'string' ||
        value.data.length !== Math.ceil(size / 3) * 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)
    )
        return null;
    const bytes = GLib.base64_decode(value.data);
    if (bytes.length !== size || GLib.base64_encode(bytes) !== value.data) return null;
    return {
        width: value.width,
        height: value.height,
        rowstride,
        alpha: value.alpha,
        data: value.data,
    };
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

function request(mode, payload, timestamp, cancellable) {
    if (cancellable?.is_cancelled()) return Promise.reject(failure('cancelled'));
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['/usr/bin/gjs', `${Me.path}/worker/chatImage.js`, mode, String(timestamp >>> 0)],
                Gio.SubprocessFlags.STDIN_PIPE |
                    Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_SILENCE
            );
        } catch (_) {
            reject(failure('helper-failed'));
            return;
        }
        const input = proc.get_stdin_pipe();
        const output = proc.get_stdout_pipe();
        const io = new Gio.Cancellable();
        const limit = mode === '--choose' ? OUTPUT_LIMIT : PREVIEW_LIMIT;
        let timer = 0;
        let cancelId = 0;
        let exited = false;
        let readDone = false;
        let readPending = false;
        let writeDone = !payload;
        let settled = false;
        let error = null;
        let result;
        let hasResult = false;
        let phase = 'starting';
        let chunks = [];
        let lineSize = 0;
        let total = 0;

        const clearTimer = () => {
            if (timer) GLib.source_remove(timer);
            timer = 0;
        };
        const abort = (reason) => {
            if (settled || error) return;
            error = reason;
            clearTimer();
            io.cancel();
            try {
                proc.force_exit();
            } catch (_) {
                /* Already exited. */
            }
            if (!readPending) readDone = true;
            // Completion is deferred to I/O/wait callbacks, outside cancelled signals.
        };
        const armTimer = () => {
            clearTimer();
            timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TIMEOUT_SECONDS, () => {
                timer = 0;
                abort(failure('timeout'));
                return GLib.SOURCE_REMOVE;
            });
        };
        const finish = () => {
            if (settled || !exited || !readDone || !writeDone) return;
            settled = true;
            clearTimer();
            if (cancelId) cancellable.disconnect(cancelId);
            try {
                input.close(null);
            } catch (_) {
                /* Already closed. */
            }
            try {
                output.close(null);
            } catch (_) {
                /* Already closed. */
            }
            if (cancellable?.is_cancelled()) error = failure('cancelled');
            if (!error && (!hasResult || !proc.get_successful())) error = failure('helper-failed');
            chunks = [];
            if (error) reject(error);
            else resolve(result);
        };
        const message = (line) => {
            let value;
            try {
                value = JSON.parse(ByteArray.toString(line));
            } catch (_) {
                throw failure('helper-failed');
            }
            if (!value || hasResult) throw failure('helper-failed');
            if (value.type === 'phase' && mode === '--choose') {
                if (value.value === 'choosing' && phase === 'starting') {
                    phase = 'choosing';
                    clearTimer(); // The user may leave the chooser open indefinitely.
                    return;
                }
                if (value.value === 'processing' && phase === 'choosing') {
                    phase = 'processing';
                    armTimer();
                    return;
                }
                throw failure('helper-failed');
            }
            if (value.type === 'error') throw failure(value.code);
            if (value.type !== 'result') throw failure('helper-failed');
            if (mode === '--choose') {
                if (value.value === null && phase === 'choosing') result = null;
                else {
                    if (phase !== 'processing') throw failure('helper-failed');
                    const image = Image.validate(value.value?.image);
                    const thumbnail = validatePreview(value.value?.preview);
                    if (!image || !thumbnail) throw failure('helper-failed');
                    result = { image, preview: thumbnail };
                }
            } else {
                result = validatePreview(value.value);
                if (!result) throw failure('helper-failed');
            }
            hasResult = true;
            armTimer(); // A completed chooser must still close its pipes and exit.
        };
        const consume = (bytes) => {
            total += bytes.length;
            if (total > limit) throw failure('helper-failed');
            let start = 0;
            for (let index = 0; index < bytes.length; index++) {
                if (bytes[index] !== 10) continue;
                const piece = bytes.subarray(start, index);
                chunks.push(piece);
                lineSize += piece.length;
                message(joinBytes(chunks, lineSize));
                chunks = [];
                lineSize = 0;
                start = index + 1;
            }
            if (start < bytes.length) {
                chunks.push(bytes.subarray(start));
                lineSize += bytes.length - start;
            }
        };
        const read = () => {
            readPending = true;
            output.read_bytes_async(
                Math.min(65536, limit + 1 - total),
                GLib.PRIORITY_DEFAULT,
                io,
                (stream, reply) => {
                    readPending = false;
                    try {
                        const bytes = stream.read_bytes_finish(reply).get_data();
                        if (bytes.length && !error) consume(bytes);
                        else readDone = true;
                        if (readDone && lineSize && !error) throw failure('helper-failed');
                    } catch (reason) {
                        readDone = true;
                        abort(
                            typeof reason.code === 'string' && ERRORS[reason.code]
                                ? reason
                                : failure('helper-failed')
                        );
                    }
                    if (error) readDone = true;
                    if (!readDone) read();
                    finish();
                }
            );
        };
        // Always reap, even when the caller or timeout cancels all pipe I/O.
        proc.wait_async(null, (child, reply) => {
            try {
                child.wait_finish(reply);
            } catch (_) {
                abort(failure('helper-failed'));
            }
            exited = true;
            finish();
        });
        armTimer();
        read();
        if (payload) {
            // GBytes gives the native async operation ownership of its buffer.
            // Raw Uint8Array arguments may be temporary C copies in older GJS.
            let writeBytes = new GLib.Bytes(ByteArray.fromString(JSON.stringify(payload)));
            const finishWrite = () => {
                writeBytes = null;
                writeDone = true;
                try {
                    input.close(null);
                } catch (_) {
                    /* Child exited/cancelled. */
                }
                finish();
            };
            const write = () => {
                try {
                    input.write_bytes_async(
                        writeBytes,
                        GLib.PRIORITY_DEFAULT,
                        io,
                        (stream, reply) => {
                            try {
                                const count = stream.write_bytes_finish(reply);
                                const size = writeBytes.get_size();
                                if (!Number.isInteger(count) || count <= 0 || count > size)
                                    throw failure('helper-failed');
                                if (!error && count < size) {
                                    writeBytes = writeBytes.new_from_bytes(count, size - count);
                                    write();
                                    return;
                                }
                            } catch (_) {
                                abort(failure('helper-failed'));
                            }
                            finishWrite();
                        }
                    );
                } catch (_) {
                    abort(failure('helper-failed'));
                    finishWrite();
                }
            };
            write();
        } else {
            try {
                input.close(null);
            } catch (_) {
                abort(failure('helper-failed'));
            }
        }
        if (cancellable) cancelId = cancellable.connect(() => abort(failure('cancelled')));
    });
}

function choose(timestamp, cancellable = null) {
    return request('--choose', null, timestamp, cancellable);
}

function preview(image, cancellable = null) {
    const value = Image.validate(image);
    if (!value) return Promise.reject(failure('invalid-request'));
    return request('--preview', value, 0, cancellable);
}
