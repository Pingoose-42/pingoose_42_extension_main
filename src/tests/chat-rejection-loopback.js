const { Gio, GLib } = imports.gi;
imports.searchPath.unshift(GLib.build_filenamev([GLib.get_current_dir(), 'src']));
const Chat = imports.services.chat;
const server = new Gio.SocketService(),
    port = server.add_any_inet_port(null);
let attempts = 0;
server.connect('incoming', (_server, conn) => {
    attempts++;
    conn.close(null);
    return true;
});
server.start();
const service = new Chat.ChatService(port);
service.configure({ active: true, general: true, login: GLib.get_user_name(), grants: [] });
let peer = service._peer('c1r1s1', '127.0.0.1');
peer.scope = 'general';
service.send(peer.key, 'Must not retry endlessly');
const loop = new GLib.MainLoop(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
if (attempts !== 1 || peer.queue.length || peer.connecting)
    throw Error('Rejected connection retried or kept queue');
service.close(peer.key);
peer = service._peer('c1r1s1', '127.0.0.1');
peer.scope = 'general';
service.send(peer.key, 'Cancel immediately');
const cancel = peer.connectCancel;
service.close(peer.key);
if (!cancel.is_cancelled()) throw Error('Pending connect was not cancelled');
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
if (service.peers.length || peer.history.length || peer.queue.length)
    throw Error('Closed chat revived');
service.destroy();
server.stop();
server.close();
print(
    'PASS: rejected peer attempts once; pending connection cancelled; closed history stays deleted'
);
