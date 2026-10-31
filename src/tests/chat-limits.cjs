const fs = require('fs'),
    vm = require('vm'),
    assert = require('assert/strict');
const source = fs.readFileSync('src/services/chat.js', 'utf8');
let scheduled = [],
    monotonic = 1;
const context = {
    imports: {
        models: { chatPolicy: require('../models/chatPolicy.js') },
        gi: {
            Gio: { Cancellable: class {} },
            GLib: {
                PRIORITY_DEFAULT: 0,
                SOURCE_REMOVE: 0,
                get_user_name: () => 'fixture',
                timeout_add_seconds: (_p, seconds, fn) => {
                    scheduled.push({ seconds, fn });
                    return scheduled.length;
                },
                source_remove() {},
                get_monotonic_time: () => monotonic * 1000000,
            },
        },
        signals: { addSignalMethods() {} },
        byteArray: { toString: (bytes) => Buffer.from(bytes).toString() },
    },
};
vm.createContext(context);
vm.runInContext(source, context);
function run(chunks, authorized = false) {
    const service = new context.ChatService();
    service._cancel = {};
    let dropped = false,
        recorded = 0;
    const conn = {},
        peer = { connections: [conn], key: 'c1r1s1' };
    service._handshakes.set(conn, { hello: authorized ? {} : null });
    service._drop = () => {
        dropped = true;
        peer.connections = [];
    };
    service._record = () => recorded++;
    service._handleLine = () => {
        recorded++;
        return true;
    };
    const input = {
        read_bytes_async(size, _priority, _cancel, fn) {
            assert.equal(size, 16 * 1024, 'native read turns stay bounded');
            this.pending = fn;
            if (chunks.length) {
                this.deliver(chunks.shift());
            }
        },
        deliver(bytes) {
            this.read_bytes_finish = () => ({ get_data: () => bytes });
            this.pending(this, {});
        },
    };
    service._read(peer, conn, input);
    return {
        get dropped() {
            return dropped;
        },
        recorded,
        input,
    };
}
assert.equal(run([Buffer.alloc(4097, 65)]).dropped, true);
const valid = run([Buffer.from('hel'), Buffer.from('lo\n')]);
assert.equal(valid.recorded, 1);
assert.equal(valid.dropped, false);
const burst = run([Buffer.from('hi\n'.repeat(21))]);
assert.equal(burst.recorded, 20);
assert.equal(burst.dropped, true);
assert.ok(scheduled.some((timer) => timer.seconds === 10));
for (const [authorized, limit] of [
    [false, 10],
    [true, 60],
]) {
    scheduled = [];
    monotonic = 1;
    const idle = run([], authorized);
    assert.equal(scheduled[0].seconds, limit);
    monotonic = limit - 1;
    idle.input.deliver(Buffer.from('partial'));
    idle.input.deliver(Buffer.from(' fragment'));
    assert.equal(scheduled.length, 1, 'fragments update activity without creating more sources');
    monotonic = limit + 1;
    scheduled[0].fn();
    assert.equal(idle.dropped, false, 'recent bytes keep the connection alive');
    assert.equal(scheduled[1].seconds, limit - 2);
    monotonic += limit - 2;
    scheduled[1].fn();
    assert.equal(idle.dropped, true, 'no further bytes still reach the established idle deadline');
}
console.log(
    'PASS: oversized unterminated input rejected; fragmented messages supported; burst limited; idle deadline armed'
);
