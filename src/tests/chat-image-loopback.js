// Real Gio sockets, production admission/handshake and a full 10 MiB original.
const { Gio, GLib } = imports.gi;
imports.searchPath.unshift(GLib.build_filenamev([GLib.get_current_dir(), 'src']));
const Chat = imports.services.chat;
const Image = imports.models.chatImage;
const reserve = new Gio.SocketListener();
const port = reserve.add_any_inet_port(null);
reserve.close();
const receiver = new Chat.ChatService(port);
const sender = new Chat.ChatService(port);
const seat = 'c1r1s1';
const login = GLib.get_user_name();
const policy = {
    active: true,
    general: false,
    login,
    grants: [{ id: 'image-test', seat, login, testSelf: true, expires: Date.now() + 600000 }],
};
receiver.configure(policy);
sender.configure(policy);
const bytes = new Uint8Array(Image.MAX_BYTES);
const seed = GLib.base64_decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
);
bytes.set(seed);
for (let index = seed.length; index < bytes.length; index++) bytes[index] = index % 251;
const payload = {
    mime: 'image/png',
    name: 'original-10MiB.png',
    size: bytes.length,
    data: GLib.base64_encode(bytes),
};
if (!Image.validate(payload)) throw Error('10 MiB original rejected by model');
const loop = new GLib.MainLoop(null, false);
let sent = false,
    imageReceived = false,
    textReceived = false,
    expired = false,
    failure = null;
function serviceState(service) {
    const peer = service.peer(seat);
    return {
        state: service.state,
        imageStatus: service.imageSendStatus(seat),
        connections: peer?.connections.length || 0,
        connecting: !!peer?.connecting,
        queue: peer?.queue.map((item) => (typeof item === 'string' ? 'text' : item.kind)) || [],
        writing: !!peer?.writing,
        sendingImage: peer?.sendingImage
            ? {
                  phase: peer.sendingImage.phase,
                  offset: peer.sendingImage.offset,
                  index: peer.sendingImage.index,
                  size: peer.sendingImage.image.size,
              }
            : null,
        incoming: [...service._incomingImages.values()].map((transfer) => ({
            length: transfer.length,
            next: transfer.next,
            size: transfer.info.size,
        })),
        handshakes: [...service._handshakes.values()].map((state) => ({
            sent: state.sent,
            written: !!state.written,
            ready: state.ready,
            self: !!state.self,
            hello: !!state.hello,
            imageFeature: state.hello?.features?.includes('image-v1') || false,
        })),
        history:
            peer?.history.map((entry) => ({
                dir: entry.dir,
                kind: entry.kind || 'text',
                text: entry.kind === 'image' ? '[Image]' : entry.text.slice(0, 160),
                imageSize: entry.image?.size || 0,
            })) || [],
    };
}
function snapshot() {
    return {
        sent,
        imageReceived,
        textReceived,
        expired,
        failure,
        sender: serviceState(sender),
        receiver: serviceState(receiver),
    };
}
const debug = GLib.getenv('PINGOOSE_CHAT_IMAGE_DEBUG') === '1';
const stopSeconds = Number(GLib.getenv('PINGOOSE_CHAT_IMAGE_STOP_SECONDS') || 0);
let debugTimer = 0;
if (debug)
    debugTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, stopSeconds || 10, () => {
        print('IMAGE DEBUG ' + JSON.stringify(snapshot()));
        if (stopSeconds) {
            debugTimer = 0;
            failure = 'Stopped after requested diagnostic snapshot';
            loop.quit();
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    });
const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 55, () => {
    expired = true;
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
sender.connect('connection-ready', () => {
    if (sent) return;
    sent = true;
    if (!sender.canSendImage(seat) || !sender.sendImage(seat, payload))
        failure = 'Negotiated image sending unavailable';
    else if (!sender.send(seat, 'text after image')) failure = 'Text queue blocked by image';
    if (failure) loop.quit();
});
receiver.connect('message', (_receiver, _key, entry) => {
    if (entry.dir !== 'in') return;
    if (entry.kind === 'image') {
        if (entry.image.size !== Image.MAX_BYTES || entry.image.data !== payload.data)
            failure = 'Original image bytes changed in transit';
        if (entry.text !== '[Image] original-10MiB.png')
            failure = 'Image notification is not a safe summary';
        imageReceived = true;
    } else if (entry.text === 'text after image') textReceived = true;
    if (failure || (imageReceived && textReceived)) loop.quit();
});
receiver.start();
sender.open(seat, 'image-test');
loop.run();
if (!expired) GLib.source_remove(timer);
if (debugTimer) GLib.source_remove(debugTimer);
const finalState = snapshot();
const incoming = receiver.peer(seat);
const outgoing = sender.peer(seat);
const incomingCount = incoming?.history.filter((entry) => entry.kind === 'image').length;
const outgoingCount = outgoing?.history.filter((entry) => entry.kind === 'image').length;
sender.destroy();
receiver.destroy();
if (
    failure ||
    expired ||
    !imageReceived ||
    !textReceived ||
    incomingCount !== 1 ||
    outgoingCount !== 1
)
    throw Error('Real image transfer did not complete exactly once: ' + JSON.stringify(finalState));
if (sender._incomingImages.size || receiver._incomingImages.size)
    throw Error('Image transfer buffers survived shutdown');
print(
    'PASS: negotiated real TCP image transfer preserves 10 MiB original bytes, keeps safe summary and text order, and cleans up'
);
