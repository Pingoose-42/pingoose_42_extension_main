const fs = require('fs'),
    vm = require('vm'),
    assert = require('assert/strict');
const source = fs.readFileSync('src/services/chat.js', 'utf8');
let scheduled = [];
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
                get_monotonic_time: () => 1000000,
            },
        },
        signals: { addSignalMethods() {} },
        byteArray: { toString: (bytes) => Buffer.from(bytes).toString() },
    },
};
vm.createContext(context);
vm.runInContext(source, context);
function run(chunks) {
    const service = new context.ChatService();
    service._cancel = {};
    let dropped = false,
        recorded = 0;
    const conn = {},
        peer = { connections: [conn], key: 'c1r1s1' };
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
        read_bytes_async(_size, _priority, _cancel, fn) {
            if (chunks.length) {
                const bytes = chunks.shift();
                this.read_bytes_finish = () => ({ get_data: () => bytes });
                fn(this, {});
            }
        },
    };
    service._read(peer, conn, input);
    return { dropped, recorded };
}
assert.equal(run([Buffer.alloc(4097, 65)]).dropped, true);
const valid = run([Buffer.from('hel'), Buffer.from('lo\n')]);
assert.equal(valid.recorded, 1);
assert.equal(valid.dropped, false);
const burst = run([Buffer.from('hi\n'.repeat(21))]);
assert.equal(burst.recorded, 20);
assert.equal(burst.dropped, true);
assert.ok(scheduled.some((timer) => timer.seconds === 10));
console.log(
    'PASS: oversized unterminated input rejected; fragmented messages supported; burst limited; idle deadline armed'
);
