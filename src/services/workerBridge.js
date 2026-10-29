const { Gio, GLib } = imports.gi;
const ByteArray = imports.byteArray;
const Me = imports.misc.extensionUtils.getCurrentExtension();

var WorkerBridge = class WorkerBridge {
    constructor({ acceptMessage = () => true } = {}) {
        this._acceptMessage = acceptMessage;
        this._listeners = new Map();
        this._commands = [];
        this._writing = false;
        this._process = null;
        this._cancel = null;
        this._workerStatus = null;
    }

    on(event, callback) {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set());
        }
        this._listeners.get(event).add(callback);
        return () => this.off(event, callback);
    }

    off(event, callback) {
        const set = this._listeners.get(event);
        if (set) {
            set.delete(callback);
            if (set.size === 0) {
                this._listeners.delete(event);
            }
        }
    }

    emit(event, data) {
        const set = this._listeners.get(event);
        if (set) {
            for (const callback of Array.from(set)) {
                try {
                    callback(data);
                } catch (error) {
                    logError(error, `WorkerBridge error handling event '${event}'`);
                }
            }
        }
        const wildcards = this._listeners.get('*');
        if (wildcards) {
            for (const callback of Array.from(wildcards)) {
                try {
                    callback(event, data);
                } catch (error) {
                    logError(error, `WorkerBridge wildcard error on '${event}'`);
                }
            }
        }
    }

    get isRunning() {
        return !!this._process;
    }

    get status() {
        return this._workerStatus;
    }

    get process() {
        return this._process;
    }

    start() {
        if (this._process) return;
        this._cancel = new Gio.Cancellable();
        this._commands = [];
        this._writing = false;
        this._exited = false;
        this._drained = false;
        this._workerStatus = null;

        try {
            this._process = Gio.Subprocess.new(
                ['/usr/bin/gjs', `${Me.path}/worker/webview.js`],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE
            );
            const proc = this._process;
            const input = new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe() });
            this._read(proc, input, this._cancel);
            proc.wait_async(null, (child, result) => {
                try {
                    child.wait_finish(result);
                } catch (_) {
                    /* Already stopping. */
                }
                if (this._process === child) {
                    this._exited = true;
                    this._finishExit(child);
                }
            });
            this.emit('started');
        } catch (_) {
            this._process = null;
            this.emit('error', 'Unable to start Intra monitoring. Check your GJS installation.');
        }
    }

    _read(proc, input, cancel) {
        input.read_line_async(GLib.PRIORITY_DEFAULT, cancel, (stream, result) => {
            try {
                const [line] = stream.read_line_finish_utf8(result);
                if (this._process !== proc || cancel.is_cancelled()) return;
                if (line === null) {
                    this._drained = true;
                    this.emit('eof');
                    this._finishExit(proc);
                    return;
                }
                if (line.length <= 4194304) {
                    try {
                        const message = JSON.parse(line);
                        this._dispatch(message);
                    } catch (_) {
                        this.emit(
                            'error',
                            'Unable to display the notification. Restart the extension.'
                        );
                    }
                }
                this._read(proc, stream, cancel);
            } catch (_) {
                if (!cancel.is_cancelled()) {
                    this.emit('error', 'Unable to read from the Intra helper.');
                    this._drained = true;
                    this._finishExit(proc);
                }
            }
        });
    }

    _finishExit(process) {
        if (this._process !== process || !this._exited || !this._drained) return;
        this._process = null;
        this._cancel?.cancel();
        this._cancel = null;
        this._commands = [];
        this._writing = false;
        this.emit('process-exited', process);
    }

    _dispatch(message) {
        if (!message || typeof message !== 'object' || !this._acceptMessage(message)) return;
        if (message.type === 'status' && typeof message.state === 'string') {
            this._workerStatus = message.state;
        }
        if (message.type) {
            this.emit(message.type, message);
        }
    }

    send(command) {
        if (!this._process) {
            this.emit('error', 'Intra monitoring is stopped. Restart the extension.');
            return;
        }
        if (command === 'show' || command === 'login' || /^(project|service):open:/.test(command)) {
            const time =
                typeof global !== 'undefined' && global.get_current_time
                    ? global.get_current_time() >>> 0
                    : 0;
            command = `present:${time}:${command}`;
        }
        this._commands.push(command);
        this._writeNext();
    }

    _writeNext() {
        if (this._writing || !this._process || !this._commands.length) return;
        const proc = this._process;
        const cancel = this._cancel;
        const bytes = ByteArray.fromString(`${this._commands.shift()}\n`);
        this._writing = true;
        proc.get_stdin_pipe().write_all_async(
            bytes,
            GLib.PRIORITY_DEFAULT,
            cancel,
            (stream, result) => {
                try {
                    stream.write_all_finish(result);
                } catch (_) {
                    if (this._process === proc) {
                        this.emit('error', 'Unable to send a command to the Intra helper.');
                    }
                }
                if (this._process === proc) {
                    this._writing = false;
                    this._writeNext();
                }
            }
        );
    }

    stop() {
        const proc = this._process;
        this._process = null;
        this._cancel?.cancel();
        this._cancel = null;
        this._commands = [];
        this._writing = false;
        if (proc) {
            try {
                proc.send_signal(15);
            } catch (_) {
                /* It already exited. */
            }
        }
    }

    destroy() {
        this.stop();
        this._listeners.clear();
    }
};
