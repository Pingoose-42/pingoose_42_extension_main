// Real self-chat with production admission and handshake, no remote seats contacted.
const { Gio, GLib } = imports.gi;
imports.searchPath.unshift(GLib.build_filenamev([GLib.get_current_dir(), 'src']));
const Chat = imports.services.chat;
const reserve = new Gio.SocketListener();
const port = reserve.add_any_inet_port(null);
reserve.close();
const service = new Chat.ChatService(port),
    login = GLib.get_user_name(),
    seat = 'c1r1s1';
service.configure({
    active: true,
    general: false,
    login,
    grants: [{ id: 'self-test', seat, login, testSelf: true, expires: Date.now() + 600000 }],
});
const loop = new GLib.MainLoop(null, false);
let delivered = false;
const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
const handleLine = service._handleLine.bind(service);
service._handleLine = (peer, conn, text) => {
    const accepted = handleLine(peer, conn, text);
    if (accepted && JSON.parse(text).text === 'Self test') {
        delivered = true;
        loop.quit();
    }
    return accepted;
};
service.start();
service.open(seat, 'self-test');
service.send(seat, 'Self test');
loop.run();
if (delivered) GLib.source_remove(timer);
const peer = service.peer(seat);
if (peer.history.filter((entry) => entry.text === 'Self test').length !== 1 || peer.unread !== 0)
    throw Error('Self chat must keep one outgoing record without unread notification');
service.destroy();
if (!delivered) throw Error('Self chat message was not delivered');
print(
    'PASS: self-only evaluation chat uses actual loopback admission, records once and suppresses received echo'
);
