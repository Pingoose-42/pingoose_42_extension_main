const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
let read, wait, proc;
class Cancellable {
    cancel() {
        this.cancelled = true;
    }
    is_cancelled() {
        return !!this.cancelled;
    }
}
class Input {
    read_line_finish_utf8(result) {
        return [result.line];
    }
    read_line_async(_priority, _cancel, done) {
        read = (line) => done(this, { line });
    }
}
const WorkerBridge = vm.runInNewContext(
    fs.readFileSync('src/services/workerBridge.js', 'utf8') + '\nWorkerBridge',
    {
        imports: {
            gi: {
                GLib: {},
                Gio: {
                    Cancellable,
                    DataInputStream: Input,
                    SubprocessFlags: {},
                    Subprocess: {
                        new() {
                            proc = {
                                get_stdout_pipe() {},
                                wait_finish() {},
                                wait_async(_cancel, done) {
                                    wait = () => done(proc, {});
                                },
                                send_signal() {},
                            };
                            return proc;
                        },
                    },
                },
            },
            misc: { extensionUtils: { getCurrentExtension: () => ({ path: '/fixture' }) } },
        },
        logError: (error) => {
            throw error;
        },
    }
);
for (const exitFirst of [true, false]) {
    let resetting = true;
    const bridge = new WorkerBridge({
        acceptMessage: (msg) => !resetting || msg.type === 'reset-ready',
    });
    const messages = [];
    bridge.on('agenda', () => messages.push('agenda'));
    bridge.on('reset-ready', () => messages.push('ready'));
    bridge.on('process-exited', () => messages.push('exit'));
    bridge.start();
    read('{"type":"agenda"}');
    assert.equal(messages.length, 0);
    if (exitFirst) wait();
    read('{"type":"reset-ready"}');
    assert.deepEqual(messages, ['ready']);
    read(null);
    if (!exitFirst) wait();
    assert.deepEqual(
        messages,
        ['ready', 'exit'],
        'drain final messages before exit, regardless of callback order'
    );
    assert.equal(bridge.isRunning, false);
    resetting = false;
    bridge._dispatch({ type: 'agenda' });
    assert.deepEqual(messages, ['ready', 'exit', 'agenda']);
    bridge.destroy();
    assert.equal(bridge._listeners.size, 0);
}
const bridge = new WorkerBridge();
let received = 0;
const unsubscribe = bridge.on('notification', () => received++);
bridge._dispatch({ type: 'notification' });
unsubscribe();
bridge._dispatch({ type: 'notification' });
assert.equal(received, 1);
bridge.start();
const staleRead = read;
bridge.stop();
staleRead('{"type":"notification"}');
assert.equal(received, 1);
console.log(
    'PASS: one dispatch, reset filtering, unsubscribe, final-message drain and stale process rejection'
);
