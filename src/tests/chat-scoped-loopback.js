// No cluster peers are contacted. Loopback admission is injected only in this test.
const { Gio, GLib } = imports.gi;
imports.searchPath.unshift(GLib.build_filenamev([GLib.get_current_dir(), 'src']));
const Chat = imports.services.chat;
function assert(ok, message) {
    if (!ok) throw Error(message);
}
const reserve = new Gio.SocketListener();
const port = reserve.add_any_inet_port(null);
reserve.close();
const service = new Chat.ChatService(port);
const sender = new Chat.ChatService(port);
const seat = 'c1r1s1',
    login = GLib.get_user_name();
service.configure({ active: true, general: true, login, grants: [] });
sender.configure({ active: true, general: true, login, grants: [] });
service._accept = (conn) => {
    service._connections++;
    service._attach(service._peer(seat, '127.0.0.1'), conn);
};
const loop = new GLib.MainLoop(null, false);
let received = 0,
    failed = false;
const timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
    failed = true;
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
service.connect('message', (_service, key, entry) => {
    if (entry.dir !== 'in') return;
    assert(entry.text === 'Scoped message', 'wire message unchanged');
    received++;
    const peer = service.peer(key);
    assert(
        peer.history.some((row) => row.dir === 'in'),
        'message recorded'
    );
    service.configure({ active: true, general: false, login, grants: [] });
    assert(service.peer(key) === null, 'disabling general chat removes peer');
    assert(
        peer.history.length === 0 && peer.queue.length === 0,
        'history and outgoing queue erased'
    );
    loop.quit();
});
service.start();
const peer = sender._peer(seat, '127.0.0.1');
peer.scope = 'general';
assert(sender.send(seat, 'Scoped message'), 'authorized local sender queues message');
loop.run();
if (!failed) GLib.source_remove(timeout);
service.destroy();
sender.destroy();
assert(!failed && received === 1, 'authenticated handshake and message delivered');
const expiry = new Chat.ChatService();
expiry.configure({
    active: true,
    general: false,
    login,
    grants: [{ id: '42', seat, login, expires: Date.now() + 10000 }],
});
const scoped = expiry._peer(seat, '127.0.0.1');
scoped.scope = '42';
scoped.history.push({ text: 'private' });
scoped.queue.push('pending');
expiry.configure({ active: true, general: false, login, grants: [] });
assert(
    expiry.peers.length === 0 && scoped.history.length === 0 && scoped.queue.length === 0,
    'expired evaluation erases all records'
);
assert(!expiry.send(seat, 'late'), 'expired peer cannot send');
expiry.destroy();
print(
    'PASS: real local JSON handshake, message delivery, mutual-mode revocation and evaluation record cleanup'
);
// A client cannot send legacy text or claim general mode without opting in.
for (const payload of [
    'legacy plaintext\n',
    JSON.stringify({
        type: 'hello',
        protocol: 'pingoose-chat-2',
        scope: 'general',
        login,
        general: false,
    }) + '\n',
]) {
    const reserved = new Gio.SocketListener();
    const testPort = reserved.add_any_inet_port(null);
    reserved.close();
    const guarded = new Chat.ChatService(testPort);
    guarded.configure({ active: true, general: true, login, grants: [] });
    let incoming = 0;
    guarded.connect('message', (_s, _k, entry) => {
        if (entry.dir === 'in') incoming++;
    });
    guarded._accept = (conn) => {
        guarded._connections++;
        guarded._attach(guarded._peer(seat, '127.0.0.1'), conn);
    };
    guarded.start();
    const connection = new Gio.SocketClient().connect_to_host('127.0.0.1', testPort, null);
    connection.get_output_stream().write_all(imports.byteArray.fromString(payload), null);
    const denyLoop = new GLib.MainLoop(null, false);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
        denyLoop.quit();
        return GLib.SOURCE_REMOVE;
    });
    denyLoop.run();
    assert(
        incoming === 0 && guarded.peers.every((p) => p.connections.length === 0),
        'unauthorized wire payload rejected'
    );
    connection.close(null);
    guarded.destroy();
}
print('PASS: real socket rejects legacy messages and unilateral general-chat enablement');
