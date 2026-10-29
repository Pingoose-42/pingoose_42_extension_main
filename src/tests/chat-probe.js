// Local sockets only: exercise production hello, silence and one-shot discovery.
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
const grant = {
    id: 'probe-test',
    login: GLib.get_user_name(),
    seat: 'c1r1s1',
    testSelf: true,
    expires: Date.now() + 600000,
};
service.configure({ active: true, general: false, login: grant.login, grants: [grant] });
const loop = new GLib.MainLoop(null, false);
let ready = false,
    messages = 0,
    attempts = 0;
const connect = service._connect.bind(service);
service._connect = (peer) => {
    attempts++;
    connect(peer);
};
service.connect('message', () => messages++);
service.connect('availability-changed', () => {
    ready = service.available(grant);
    loop.quit();
});
const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
service.start();
assert(!service.available(grant), 'hidden before handshake');
service.probe(grant);
service.probe(grant);
loop.run();
if (ready) GLib.source_remove(timer);
assert(ready, 'validated hello enables evaluation chat');
assert(attempts === 1, 'one attempt for repeated grant');
assert(
    messages === 0 && service.peer(grant.seat).history.length === 0,
    'probe creates no messages or notifications'
);
assert(service.peer(grant.seat).background, 'probe stays out of chat UI');
service.close(grant.seat);
service.probe(grant);
assert(attempts === 1, 'closing the idle socket does not reprobe');
service.configure({ active: false, general: false, login: grant.login, grants: [] });
assert(!service.available(grant), 'logout revokes availability');
service.destroy();
print(
    'PASS: silent authenticated probe, one attempt, hidden background peer and logout revocation'
);
const silentServer = new Gio.SocketService();
const silentPort = silentServer.add_any_inet_port(null);
let connections = [],
    silentAttempts = 0;
silentServer.connect('incoming', (_server, conn) => {
    silentAttempts++;
    connections.push(conn);
    return true;
});
silentServer.start();
const silent = new Chat.ChatService(silentPort);
silent.configure({
    active: true,
    general: false,
    login: grant.login,
    grants: [grant],
    sessions: [grant],
});
let silentMessages = 0;
silent.connect('message', () => silentMessages++);
silent.probe(grant);
const silenceLoop = new GLib.MainLoop(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
    silenceLoop.quit();
    return GLib.SOURCE_REMOVE;
});
silenceLoop.run();
assert(!silent.available(grant), 'TCP connection without a valid hello must stay hidden');
silent.configure({
    active: true,
    general: false,
    login: grant.login,
    grants: [],
    sessions: [grant],
});
silent.configure({
    active: true,
    general: false,
    login: grant.login,
    grants: [grant],
    sessions: [grant],
});
silent.probe(grant);
assert(!silent.available(grant), 'confirmed offline then online requires a fresh handshake');
assert(silentMessages === 0, 'silent peer generates no chat entries');
silent.destroy();
for (const conn of connections) conn.close(null);
silentServer.stop();
silentServer.close();
print(
    'PASS: nonresponsive peer stays hidden; restored availability requires an authenticated handshake'
);
