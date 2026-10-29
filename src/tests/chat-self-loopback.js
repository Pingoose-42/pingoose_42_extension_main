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
let received = false;
const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
service.connect('message', (_service, key, entry) => {
    if (entry.dir === 'in' && entry.text === 'Self test') {
        received = true;
        loop.quit();
    }
});
service.start();
service.open(seat, 'self-test');
service.send(seat, 'Self test');
loop.run();
if (received) GLib.source_remove(timer);
service.destroy();
if (!received) throw Error('Self chat message was not delivered');
print('PASS: self-only evaluation chat over loopback using actual admission and handshake');
