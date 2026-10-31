const assert = require('node:assert/strict');
const { moduleExport } = require('./helpers.cjs');
const Image = require('../models/chatImage.js');
const Policy = require('../models/chatPolicy.js');

function png(size = 68, name = 'photo.png') {
    const bytes = Buffer.alloc(size, 37);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    return { mime: 'image/png', size, name, data: bytes.toString('base64') };
}
const sample = png();
assert.deepEqual(Image.validate(sample), sample);
assert.equal(Image.validate(png(Image.MAX_BYTES)).size, Image.MAX_BYTES);
for (const invalid of [
    { ...sample, size: Image.MAX_BYTES + 1 },
    { ...sample, size: sample.size - 1 },
    { ...sample, mime: 'image/svg+xml' },
    { ...sample, mime: 'image/jpeg' },
    { ...sample, data: sample.data + '\n' },
    { ...sample, data: sample.data.replace(/^i/, '?') },
    { ...sample, data: sample.data.slice(0, -2) + '==' },
    { ...sample, name: 'x'.repeat(129) },
])
    assert.equal(Image.validate(invalid), null);
const padded = png(9);
assert.equal(Image.validate({ ...padded, data: padded.data + '=' }), null);
assert.equal(Image.detectMime([255, 216, 255, 0]), 'image/jpeg');
assert.equal(Image.detectMime(Buffer.from('GIF89a')), 'image/gif');
assert.equal(Image.detectMime(Buffer.from('RIFFxxxxWEBP')), 'image/webp');
assert.equal(Image.validate({ ...sample, name: '../photo\n.png' }).name, '.._photo_.png');
assert.deepEqual(Image.fit(4000, 3000), { width: 256, height: 192 });
assert.deepEqual(Image.fit(10000, 100), { width: 256, height: 3 });
assert.deepEqual(Image.fit(20, 10), { width: 20, height: 10 });
assert.equal(Image.fit(0, 10), null);

let tick = 1,
    id = 0;
const timers = new Map(),
    writes = [],
    writeBatches = [],
    frames = [];
class Bytes {
    constructor(data) {
        this.data = Buffer.from(data);
    }
    get_size() {
        return this.data.length;
    }
    new_from_bytes(offset, length) {
        return new Bytes(this.data.subarray(offset, offset + length));
    }
}
const Chat = moduleExport('services/chat.js', 'ChatService', {
    imports: {
        models: { chatPolicy: Policy, chatImage: Image },
        gi: {
            Gio: {
                Cancellable: class {
                    cancel() {}
                },
            },
            GLib: {
                Bytes,
                get_user_name: () => 'fixture',
                get_host_name: () => 'c1r1s1',
                uuid_string_random: () => `fixture-${++id}`,
                get_monotonic_time: () => tick * 1000000,
                DateTime: { new_now_local: () => ({ format: () => '12:34' }) },
                timeout_add_seconds(_priority, seconds, callback) {
                    const key = ++id;
                    timers.set(key, { seconds, callback });
                    return key;
                },
                source_remove: (key) => timers.delete(key),
            },
        },
        byteArray: {
            fromString: (text) => Buffer.from(text),
            toString: (bytes) => Buffer.from(bytes).toString(),
        },
        signals: {
            addSignalMethods(proto) {
                proto.emit = function (...event) {
                    (this.events ||= []).push(event);
                };
                proto.disconnectAll = function () {};
            },
        },
    },
});
function fixture({ capable = true, local = false } = {}) {
    const service = new Chat();
    service.configure({ active: true, general: true, login: 'fixture', grants: [] });
    const peer = service._peer('c1r1s2', 'host');
    peer.scope = 'general';
    peer.background = false;
    const conn = {
        close() {
            this.closed = true;
        },
        get_remote_address: () => ({
            get_address: () => ({ get_is_loopback: () => local, equal: () => false }),
        }),
        get_local_address: () => ({ get_address: () => ({}) }),
        get_output_stream: () => ({
            write_bytes_async(bytes, _priority, _cancel, done) {
                assert(bytes instanceof Bytes, 'Gio receives an owning GBytes');
                const data = bytes.data;
                const batch = (data.toString().match(/\n/g) || []).length;
                assert(batch <= 16, 'native writes contain at most 16 bounded frames');
                assert(data.length <= 16 * 4097, 'native write buffers remain bounded');
                writeBatches.push(batch);
                const count = conn.zero ? 0 : Math.min(data.length, conn.partial || Infinity);
                writes.push(() => {
                    const lines = (
                        (conn.wirePending || '') + data.subarray(0, count).toString()
                    ).split('\n');
                    conn.wirePending = lines.pop();
                    for (const text of lines) {
                        assert(Buffer.byteLength(text) <= 4096, 'each wire line keeps its limit');
                        frames.push(JSON.parse(text));
                    }
                    if (conn.receiver) {
                        const [remote, remotePeer, remoteConn] = conn.receiver;
                        for (const text of lines) {
                            if (
                                !remote._allowLine(remotePeer, remoteConn, text) ||
                                !remote._handleLine(remotePeer, remoteConn, text)
                            ) {
                                remote._drop(remotePeer, remoteConn);
                                done(
                                    {
                                        write_bytes_finish() {
                                            throw Error('remote rejected');
                                        },
                                    },
                                    {}
                                );
                                return;
                            }
                        }
                    }
                    done(
                        {
                            write_bytes_finish() {
                                if (conn.fail) throw Error('write failed');
                                return count;
                            },
                        },
                        {}
                    );
                });
            },
        }),
    };
    peer.connections.push(conn);
    service._connections++;
    service._handshakes.set(conn, {
        ready: true,
        sent: true,
        written: true,
        hello: {
            type: 'hello',
            protocol: 'pingoose-chat-2',
            scope: 'general',
            login: 'peer',
            general: true,
            ...(capable ? { features: ['image-v1'] } : {}),
        },
    });
    return { service, peer, conn };
}
function drain() {
    while (writes.length) writes.shift()();
}
const sender = fixture(),
    receiver = fixture();
sender.conn.receiver = [receiver.service, receiver.peer, receiver.conn];
const larger = png(100000);
assert(sender.service.sendImage(sender.peer.key, larger));
const firstWrite = sender.peer.activeWrite;
assert.equal(firstWrite.output, sender.service._handshakes.get(sender.conn).output);
assert(firstWrite.bytes instanceof Bytes, 'pending async writes retain the owning buffer');
assert.equal(sender.service.imageSendStatus(sender.peer.key), 'busy');
assert(sender.service.send(sender.peer.key, 'after the picture'));
drain();
assert.equal(firstWrite.bytes, null, 'completed writes release their wire buffer');
assert.equal(sender.peer.activeWrite, null);
assert(frames.filter((frame) => frame.type === 'image-chunk').length > 20);
assert(writeBatches.includes(16), 'large images amortize native writes across ordered chunks');
assert.equal(receiver.peer.history.length, 2);
assert.equal(receiver.peer.history[0].image.data, larger.data);
assert.equal(receiver.peer.history[1].text, 'after the picture');
assert.equal(receiver.peer.unread, 2);
assert.equal(sender.service.canSendImage(sender.peer.key), true);
assert.equal(receiver.service._incomingImages.size, 0);
assert.equal(sender.peer.sendingImage, null);
assert(!receiver.peer.history[0].text.includes(larger.data));
assert.equal(sender.peer.history[0].kind, 'image');

const partial = fixture(),
    partialReceiver = fixture();
partial.conn.partial = 127;
partial.conn.receiver = [partialReceiver.service, partialReceiver.peer, partialReceiver.conn];
const partialImage = png(5000);
assert(partial.service.sendImage(partial.peer.key, partialImage));
assert(partial.service.send(partial.peer.key, 'after partial writes'));
drain();
assert.equal(partialReceiver.peer.history[0].image.data, partialImage.data);
assert.equal(partialReceiver.peer.history[1].text, 'after partial writes');
assert.equal(partial.peer.activeWrite, null);
partial.service.destroy();
partialReceiver.service.destroy();
const zeroWrite = fixture();
zeroWrite.conn.zero = true;
assert(zeroWrite.service.sendImage(zeroWrite.peer.key, sample));
drain();
assert.equal(zeroWrite.peer.connections.length, 0, 'zero-byte writes fail instead of looping');
assert.equal(zeroWrite.peer.sendingImage, null);
zeroWrite.service.destroy();

const old = fixture({ capable: false });
assert.equal(old.service.imageSendStatus(old.peer.key), 'unsupported');
assert.equal(old.service.sendImage(old.peer.key, sample), false);
assert(old.service.send(old.peer.key, 'old clients still receive text'));
drain();
assert.equal(frames.at(-1).type, 'message');

function begin(test, payload = sample, transferId = 'transfer') {
    return test.service._handleLine(
        test.peer,
        test.conn,
        JSON.stringify({
            type: 'image-begin',
            id: transferId,
            mime: payload.mime,
            size: payload.size,
            name: payload.name,
        })
    );
}
for (const invalid of [
    { type: 'image-chunk', id: 'transfer', index: 1, data: sample.data },
    { type: 'image-chunk', id: 'wrong', index: 0, data: sample.data },
    { type: 'image-chunk', id: 'transfer', index: 0, data: 'AAAA' },
    { type: 'image-chunk', id: 'transfer', index: 0, data: '?'.repeat(sample.data.length) },
    { type: 'image-end', id: 'transfer' },
]) {
    const test = fixture();
    assert(begin(test));
    assert.equal(test.service._handleLine(test.peer, test.conn, JSON.stringify(invalid)), false);
    assert.equal(
        test.service._incomingImages.size,
        0,
        'invalid/partial/out-of-order transfers release buffers'
    );
    assert.equal(test.peer.history.length, 0);
    test.service.destroy();
}
const oversized = fixture();
assert.equal(begin(oversized, { ...sample, size: Image.MAX_BYTES + 1 }), false);
assert.equal(begin(oversized, { ...sample, mime: 'image/svg+xml' }), false);
const badMagic = fixture();
assert(begin(badMagic));
assert(
    badMagic.service._handleLine(
        badMagic.peer,
        badMagic.conn,
        JSON.stringify({
            type: 'image-chunk',
            id: 'transfer',
            index: 0,
            data: Buffer.alloc(sample.size).toString('base64'),
        })
    )
);
assert.equal(
    badMagic.service._handleLine(
        badMagic.peer,
        badMagic.conn,
        JSON.stringify({ type: 'image-end', id: 'transfer' })
    ),
    false
);
assert.equal(badMagic.service._incomingImages.size, 0);

const expired = fixture();
assert(begin(expired));
const deadline = expired.service._incomingImages.get(expired.conn).timer;
timers.get(deadline).callback();
timers.delete(deadline);
assert.equal(expired.service._incomingImages.size, 0);
assert(expired.conn.closed);
const blocked = fixture();
assert(begin(blocked));
blocked.service.setBlocked([blocked.peer.key]);
assert.equal(blocked.service._incomingImages.size, 0);
assert.equal(blocked.service.peer(blocked.peer.key), null);

const failed = fixture();
failed.conn.fail = true;
assert(failed.service.sendImage(failed.peer.key, sample));
drain();
assert.equal(failed.peer.sendingImage, null);
assert.equal(failed.service._queuedImageBytes(), 0);
assert(failed.peer.history.some((entry) => entry.dir === 'sys' && /Send failed/.test(entry.text)));
assert(failed.peer.history.every((entry) => !entry.text.includes(sample.data)));

const memory = fixture();
const original = png(Image.MAX_BYTES);
for (let index = 0; index < 5; index++)
    memory.service._record(memory.peer, 'out', '[Image]', original);
assert.equal(memory.peer.history[0].image, null);
assert.match(memory.peer.history[0].text, /no longer kept/);
assert.equal(
    memory.peer.history.slice(1).reduce((sum, entry) => sum + entry.image.size, 0),
    Image.MAX_HISTORY_BYTES
);
assert(original.data, 'history pruning must not mutate a payload still being transmitted');
assert(memory.service.events.some(([event]) => event === 'image-history-pruned'));

const bounded = fixture();
function additionalPeer(owner, key) {
    const extra = fixture();
    const peer = owner.service._peer(key, 'host');
    peer.scope = 'general';
    peer.connections.push(extra.conn);
    owner.service._connections++;
    owner.service._handshakes.set(extra.conn, extra.service._handshakes.get(extra.conn));
    extra.service._handshakes.delete(extra.conn);
    extra.peer.connections = [];
    extra.service.destroy();
    return { service: owner.service, peer, conn: extra.conn };
}
const boundedSecond = additionalPeer(bounded, 'c1r1s3');
const boundedThird = additionalPeer(bounded, 'c1r1s4');
assert(begin(bounded, original, 'one'));
assert(begin(boundedSecond, original, 'two'));
assert.equal(
    begin(boundedThird, original, 'three'),
    false,
    'inbound concurrency and reserved bytes are globally bounded'
);
assert.equal(bounded.service._incomingImages.size, 2);
assert(bounded.service.sendImage(bounded.peer.key, original));
assert(bounded.service.sendImage(boundedSecond.peer.key, original));
assert.equal(
    bounded.service.sendImage(boundedThird.peer.key, original),
    false,
    'outbound bytes are bounded across peers'
);
assert.equal(bounded.service._queuedImageBytes(), 20 * 1024 * 1024);
bounded.service.destroy();
drain();
assert.equal(bounded.service._queuedImageBytes(), 0);
assert.equal(bounded.service._incomingImages.size, 0);

for (const local of [true, false]) {
    const test = fixture({ local });
    test.service._instance = 'same-instance';
    const state = test.service._handshakes.get(test.conn);
    state.hello = null;
    state.ready = false;
    assert(
        test.service._handleLine(
            test.peer,
            test.conn,
            JSON.stringify({
                type: 'hello',
                protocol: 'pingoose-chat-2',
                scope: 'general',
                login: 'fixture',
                general: true,
                features: ['image-v1'],
                instance: 'same-instance',
            })
        )
    );
    test.service._record(test.peer, 'out', 'once');
    assert(
        test.service._handleLine(
            test.peer,
            test.conn,
            JSON.stringify({ type: 'message', text: 'once' })
        )
    );
    assert.equal(test.peer.history.filter((entry) => entry.text === 'once').length, local ? 1 : 2);
    assert.equal(
        test.peer.unread,
        local ? 0 : 1,
        'matching login/nonce without local transport must not suppress incoming messages'
    );
    test.service.destroy();
}
for (const test of [sender, receiver, old, oversized, badMagic, expired, blocked, failed, memory])
    test.service.destroy();
assert.equal(timers.size, 0, 'all image deadlines are cleaned up');
console.log(
    'PASS: image validation/limits, preview fit, negotiated bounded transfers, text interleave, failures, history pruning and local-only self echo suppression'
);
