const fs = require('fs'),
    vm = require('vm'),
    assert = require('assert/strict');
const context = {
    imports: {
        models: { chatPolicy: require('../models/chatPolicy.js') },
        gi: {
            Gio: { Cancellable: class {} },
            GLib: {
                DateTime: { new_now_local: () => ({ format: () => '12:00' }) },
                get_user_name: () => 'fixture',
                get_monotonic_time: () => 1000000,
            },
        },
        signals: { addSignalMethods() {} },
        byteArray: {},
    },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('src/services/chat.js', 'utf8'), context);
const service = new context.ChatService();
service.emit = () => {};
service._closeStream = (conn) => service._handshakes.delete(conn);
const peer = service._peer('c1r1s1', 'c1r1s1');
peer.background = false;
service._announceConnection(peer, 'Connected to c1r1s1');
function disconnect(ready, queued = []) {
    const conn = {};
    peer.connections = [conn];
    peer.queue = queued;
    service._connections = 1;
    service._handshakes.set(conn, { ready });
    service._drop(peer, conn);
}
disconnect(true);
service._announceConnection(peer, 'Connected to c1r1s1');
service._announceConnection(peer, 'Connection from c1r1s1');
assert.equal(
    peer.history.length,
    1,
    'idle disconnects and either reconnect direction remain silent'
);
assert.equal(peer.history[0].text, 'Connected to c1r1s1');
disconnect(true, ['pending']);
assert.match(peer.history.at(-1).text, /not sent/, 'lost messages remain visible');
disconnect(false);
assert.match(peer.history.at(-1).text, /unavailable/, 'connection failures remain visible');
const probe = service._peer('c1r1s2', 'c1r1s2');
service._announceConnection(probe, 'Connected');
assert.equal(probe.connectionAnnounced, undefined, 'background probes do not consume first notice');
probe.background = false;
service._announceConnection(probe, 'Connected');
assert.equal(probe.history.length, 1);
console.log('PASS: first connection notice only; failures retained; probes stay silent');
