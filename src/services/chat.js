// Scoped chat: versioned JSON messages over TCP. Legacy plaintext is rejected.
// Pure Gio (no Shell imports) so it can also be exercised from a plain gjs script.
const { Gio, GLib } = imports.gi;
const Signals = imports.signals;
const ByteArray = imports.byteArray;

var PORT = 9000;
var DOMAIN = '42gyeongsan.kr';
var SEAT = /^c[0-9]+r[0-9]+s[0-9]+$/i;
let Policy;
try {
    Policy = imports.models.chatPolicy;
} catch (_) {
    Policy = imports.misc.extensionUtils.getCurrentExtension().imports.models.chatPolicy;
}
const MAX_LINE = 4096;
const MAX_CONNECTIONS = 16;
const MAX_HISTORY = 200;
const IMAGE_CHUNK = 3072;
const IMAGE_WRITE_CHUNKS = 16;
const MAX_IMAGE_TRANSFERS = 2;
const MAX_TRANSFER_BYTES = 20 * 1024 * 1024;
const IMAGE_TIMEOUT = 60;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
let Images;
function imageModel() {
    if (!Images) {
        try {
            Images = imports.models.chatImage;
        } catch (_) {
            Images = imports.misc.extensionUtils.getCurrentExtension().imports.models.chatImage;
        }
    }
    return Images;
}

// Conversation key for a host: "c2r3s4" for cluster seats, otherwise the host itself.
function peerKey(host) {
    host = host.toLowerCase().replace(/\.$/, '');
    if (['localhost', '127.0.0.1', '::1'].includes(host)) return 'localhost';
    const label = host.split('.')[0];
    if (SEAT.test(label) && (host === label || host.endsWith(`.${DOMAIN}`))) return label;
    return host;
}

// "c2r3s4" -> {key: 'c2r3s4', host: 'c2r3s4.42gyeongsan.kr'}; null when unusable.
function normalizePeer(input) {
    const host = String(input ?? '')
        .trim()
        .toLowerCase()
        .replace(/\.$/, '');
    if (!host || host.length > 253) return null;
    if (SEAT.test(host)) return { key: host.toLowerCase(), host: `${host}.${DOMAIN}` };
    if (!HOST.test(host) && !Gio.InetAddress.new_from_string(host)) return null;
    const key = peerKey(host);
    return { key, host: key === 'localhost' ? '127.0.0.1' : host };
}

function now() {
    return GLib.DateTime.new_now_local().format('%H:%M');
}

// GBytes owns its storage across the async boundary. In contrast, GJS may
// release the temporary C array passed to write_all_async when that call returns.
function writeBytes(output, bytes, cancellable, complete) {
    let offset = 0;
    const size = bytes.get_size();
    const next = () => {
        try {
            const remaining = offset ? bytes.new_from_bytes(offset, size - offset) : bytes;
            output.write_bytes_async(
                remaining,
                GLib.PRIORITY_DEFAULT,
                cancellable,
                (stream, result) => {
                    let count;
                    try {
                        count = stream.write_bytes_finish(result);
                        if (!Number.isInteger(count) || count <= 0 || count > size - offset)
                            throw Error('Incomplete chat write');
                    } catch (error) {
                        complete(error);
                        return;
                    }
                    offset += count;
                    if (offset < size) next();
                    else complete(null);
                }
            );
        } catch (error) {
            complete(error);
        }
    };
    next();
}

var ChatService = class ChatService {
    constructor(port = PORT, blocked = []) {
        this.port = port;
        this._blocked = new Set(blocked.map((key) => String(key).toLowerCase()));
        this.state = 'stopped';
        this.policy = { active: false, general: false, login: GLib.get_user_name(), grants: [] };
        this._handshakes = new Map();
        this._probes = new Set();
        this._available = new Set();
        this._peers = new Map();
        this._cancel = new Gio.Cancellable();
        this._connections = 0;
        this._streams = new Map();
        this._rate = { time: 0, count: 0 };
        this._imageRate = { time: 0, bytes: 0 };
        this._incomingImages = new Map();
        this._imageSequence = 0;
        this._instance = null;
        this._destroyed = false;
    }

    configure(policy) {
        const previous = this.policy;
        this.policy = policy;
        this._evaluationChats ||= new Map();
        const sessions = (policy.sessions || []).filter(
            (session) => policy.active && session.expires > Date.now()
        );
        for (const [key, saved] of this._evaluationChats)
            if (
                !sessions.some(
                    (session) => session.id === saved.id && session.login === saved.login
                )
            )
                this._evaluationChats.delete(key);
        for (const set of [this._probes, this._available]) {
            for (const key of set) {
                const [id, login, seat, expires] = JSON.parse(key);
                if (
                    !policy.active ||
                    expires <= Date.now() ||
                    !policy.grants.some(
                        (item) =>
                            item.id === id &&
                            item.login === login &&
                            item.seat === seat &&
                            item.expires === expires
                    )
                )
                    set.delete(key);
            }
        }
        for (const peer of this.peers) {
            if (!peer.scope || Policy.allowed(policy, peer.key, peer.scope)) continue;
            const old = (previous.grants || []).find(
                (grant) => grant.id === peer.scope && grant.seat === peer.key
            );
            const session =
                old && sessions.find((item) => item.id === old.id && item.login === old.login);
            const saved =
                session && !peer.background
                    ? {
                          ...session,
                          seat: peer.key,
                          history: [...peer.history],
                          unread: peer.unread,
                          connectionAnnounced: peer.connectionAnnounced,
                      }
                    : null;
            this.close(peer.key);
            if (saved) this._evaluationChats.set(saved.id + ':' + saved.login, saved);
        }
        for (const [key, saved] of [...this._evaluationChats]) {
            const grant = policy.grants.find(
                (item) => item.id === saved.id && item.login === saved.login
            );
            if (!grant || this.isBlocked(grant.seat)) continue;
            // Do not replace a separate conversation already open on the destination seat.
            const existing = this.peer(grant.seat);
            if (existing && existing.scope !== grant.id) continue;
            this._evaluationChats.delete(key);
            const seat = this.open(grant.seat, grant.id, false, grant.login);
            const peer = seat && this.peer(seat);
            if (peer) {
                peer.history = [...saved.history, ...peer.history].slice(-MAX_HISTORY);
                peer.unread = saved.unread;
                peer.connectionAnnounced = saved.connectionAnnounced;
                this.emit('peer-changed', seat);
            }
        }
        for (const key of this._trimImageHistory()) this.emit('image-history-pruned', key);
    }
    _grantKey(grant) {
        return JSON.stringify([grant.id, grant.login, grant.seat, grant.expires]);
    }
    available(grant) {
        return (
            !this.isBlocked(grant.seat) &&
            this.canOpen(grant.seat, grant.id) &&
            this._available.has(this._grantKey(grant))
        );
    }
    probe(grant) {
        const key = this._grantKey(grant);
        if (
            this._probes.has(key) ||
            !this.canOpen(grant.seat, grant.id) ||
            this.isBlocked(grant.seat)
        )
            return;
        // Never replace a conversation the user already opened for another scope.
        if (this.peer(grant.seat) && this.peer(grant.seat).scope !== grant.id) return;
        this._probes.add(key);
        this.open(grant.seat, grant.id, true);
    }
    _ready(peer, conn) {
        if (!this._authorized(peer, conn)) return;
        this.emit('connection-ready', peer.key);
        const grant = this.policy.grants.find(
            (item) =>
                item.id === peer.scope &&
                item.seat === peer.key &&
                item.login === this._handshakes.get(conn).hello.login
        );
        if (!grant) return;
        const key = this._grantKey(grant);
        if (this._available.has(key)) return;
        this._available.add(key);
        this.emit('availability-changed');
    }
    canOpen(seat, scope) {
        return Policy.allowed(this.policy, seat, scope);
    }
    _authorized(peer, conn) {
        const state = this._handshakes.get(conn);
        return (
            state?.ready &&
            !this.isBlocked(peer.key) &&
            Policy.accepts(this.policy, peer.key, state.hello) &&
            peer.scope === state.hello.scope
        );
    }
    _sendHello(peer, conn) {
        const state = this._handshakes.get(conn);
        if (!state || state.sent) return;
        state.sent = true;
        this._instance ||= GLib.uuid_string_random();
        const hello = {
            type: 'hello',
            protocol: 'pingoose-chat-2',
            scope: peer.scope,
            login: this.policy.login,
            general: this.policy.general,
            features: ['image-v1'],
            instance: this._instance,
        };
        // Keep the stream and the owning GBytes alive until completion.
        state.output ||= conn.get_output_stream();
        state.helloBytes = new GLib.Bytes(ByteArray.fromString(JSON.stringify(hello) + '\n'));
        writeBytes(state.output, state.helloBytes, this._cancel, (error) => {
            state.helloBytes = null;
            if (error) {
                peer.queue = [];
                this._drop(peer, conn);
                return;
            }
            if (!this._handshakes.has(conn)) return;
            state.written = true;
            state.ready = !!state.hello;
            this._ready(peer, conn);
            this._flush(peer);
        });
    }
    _handleLine(peer, conn, text) {
        let value;
        try {
            value = JSON.parse(text);
        } catch (_) {
            value = null;
        }
        const state = this._handshakes.get(conn);
        if (!state) return false;
        if (!state.hello) {
            if (
                !Policy.accepts(this.policy, peer.key, value) ||
                (peer.scope && peer.scope !== value.scope)
            )
                return false;
            if (
                this._blocked.has('@' + value.login.toLowerCase()) ||
                (peer.expectedLogin && peer.expectedLogin !== value.login)
            )
                return false;
            peer.login = value.login;
            peer.scope = value.scope;
            state.hello = value;
            state.self =
                value.instance === this._instance &&
                !!this._instance &&
                this._localConnection(conn);
            this.emit('peer-changed', peer.key);
            this._sendHello(peer, conn);
            state.ready = !!state.written;
            this._ready(peer, conn);
            this._flush(peer);
            return true;
        }
        if (!this._authorized(peer, conn)) return false;
        if (['image-begin', 'image-chunk', 'image-end'].includes(value?.type)) {
            const accepted = this._receiveImage(peer, conn, value);
            if (!accepted) this._clearImageTransfer(conn);
            return accepted;
        }
        if (value?.type !== 'message' || typeof value.text !== 'string' || value.text.length > 1000)
            return false;
        if (value.text.trim() && !state.self) this._record(peer, 'in', value.text);
        return true;
    }

    _localConnection(conn) {
        try {
            const remote = conn.get_remote_address().get_address();
            return remote.get_is_loopback() || remote.equal(conn.get_local_address().get_address());
        } catch (_) {
            return false;
        }
    }

    _imageCapable(peer, conn) {
        const hello = this._handshakes.get(conn)?.hello;
        return (
            this._authorized(peer, conn) &&
            Array.isArray(hello.features) &&
            hello.features.includes('image-v1')
        );
    }

    _queuedImageBytes() {
        let bytes = 0;
        for (const peer of this._peers.values()) {
            if (peer.sendingImage) bytes += peer.sendingImage.image.size;
            for (const item of peer.queue) if (item?.kind === 'image') bytes += item.image.size;
        }
        return bytes;
    }

    imageSendStatus(key) {
        const peer = this.peer(key);
        if (
            !peer ||
            !this._alive(peer) ||
            this.isBlocked(key) ||
            !this.canOpen(key, peer.scope) ||
            !this.isConnected(key)
        )
            return 'unavailable';
        if (!peer.connections.some((conn) => this._imageCapable(peer, conn))) return 'unsupported';
        if (
            peer.sendingImage ||
            peer.queue.some((item) => item?.kind === 'image') ||
            peer.queue.length >= 32 ||
            this._queuedImageBytes() >= MAX_TRANSFER_BYTES
        )
            return 'busy';
        return 'ready';
    }

    canSendImage(key) {
        return this.imageSendStatus(key) === 'ready';
    }

    sendImage(key, payload) {
        if (!this.canSendImage(key)) return false;
        const image = imageModel().validate(payload);
        if (!image || this._queuedImageBytes() + image.size > MAX_TRANSFER_BYTES) return false;
        const peer = this.peer(key);
        peer.queue.push({ kind: 'image', image });
        this._record(peer, 'out', imageModel().summary(image), image);
        this._flush(peer);
        return true;
    }

    _clearImageTransfer(conn) {
        const transfer = this._incomingImages.get(conn);
        if (transfer?.timer) GLib.source_remove(transfer.timer);
        this._incomingImages.delete(conn);
    }

    _receiveImage(peer, conn, frame) {
        if (
            !this._imageCapable(peer, conn) ||
            typeof frame.id !== 'string' ||
            !/^[a-zA-Z0-9-]{1,64}$/.test(frame.id)
        )
            return false;
        const transfer = this._incomingImages.get(conn);
        if (frame.type === 'image-begin') {
            const info = imageModel().metadata(frame);
            const bytes = [...this._incomingImages.values()].reduce(
                (sum, value) => sum + value.info.size,
                0
            );
            if (
                !info ||
                transfer ||
                this._incomingImages.size >= MAX_IMAGE_TRANSFERS ||
                bytes + info.size > MAX_TRANSFER_BYTES
            )
                return false;
            const incoming = { id: frame.id, info, chunks: [], length: 0, next: 0, timer: 0 };
            incoming.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, IMAGE_TIMEOUT, () => {
                incoming.timer = 0;
                this._record(peer, 'sys', 'Image transfer timed out. Ask the sender to retry.');
                this._drop(peer, conn);
                return GLib.SOURCE_REMOVE;
            });
            this._incomingImages.set(conn, incoming);
            return true;
        }
        if (!transfer || transfer.id !== frame.id) return false;
        if (frame.type === 'image-chunk') {
            const data = frame.data;
            const expected = Math.ceil(transfer.info.size / 3) * 4;
            if (
                frame.index !== transfer.next ||
                typeof data !== 'string' ||
                data.length !== Math.min(IMAGE_CHUNK, expected - transfer.length) ||
                !data.length ||
                data.length % 4 ||
                !/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
                (transfer.length + data.length < expected && data.includes('='))
            )
                return false;
            const time = GLib.get_monotonic_time() / 1000000;
            if (time - this._imageRate.time >= 10) this._imageRate = { time, bytes: 0 };
            this._imageRate.bytes += data.length;
            if (
                this._imageRate.bytes >
                MAX_IMAGE_TRANSFERS * Math.ceil(imageModel().MAX_BYTES / 3) * 4
            )
                return false;
            transfer.chunks.push(data);
            transfer.length += data.length;
            transfer.next++;
            return true;
        }
        if (frame.type !== 'image-end' || transfer.length !== Math.ceil(transfer.info.size / 3) * 4)
            return false;
        const image = imageModel().validate({ ...transfer.info, data: transfer.chunks.join('') });
        this._clearImageTransfer(conn);
        if (!image) return false;
        if (!this._handshakes.get(conn).self)
            this._record(peer, 'in', imageModel().summary(image), image);
        return true;
    }

    isBlocked(key) {
        const seat = peerKey(key);
        return [...this._blocked].some(
            (rule) =>
                rule ===
                    '@' +
                        (
                            this.peer(seat)?.login ||
                            this.peer(seat)?.expectedLogin ||
                            ''
                        ).toLowerCase() ||
                rule === seat ||
                (/^c[0-9]+$/.test(rule) && seat.startsWith(`${rule}r`)) ||
                (/^c[0-9]+r[0-9]+$/.test(rule) && seat.startsWith(`${rule}s`))
        );
    }

    setBlocked(keys) {
        this._blocked = new Set(keys.map((key) => String(key).toLowerCase()));
        for (const peer of this.peers) if (this.isBlocked(peer.key)) this.close(peer.key);
    }

    start() {
        this._stopService();
        const service = new Gio.SocketService();
        try {
            service.add_inet_port(this.port, null);
        } catch (_) {
            service.close();
            this._setState('port-busy');
            return;
        }
        service.connect('incoming', (_service, connection) => {
            this._accept(connection);
            return true;
        });
        service.start();
        this._service = service;
        this._setState('listening');
    }

    get peers() {
        return [...this._peers.values()].sort((a, b) => b.activity - a.activity);
    }

    get unread() {
        let total = 0;
        for (const peer of this._peers.values()) total += peer.unread;
        return total;
    }

    showConnected(key) {
        const peer = this.peer(key);
        if (!peer || !this.isConnected(key)) return;
        peer.background = false;
        this._announceConnection(peer, `Connected to ${peer.host}`);
        this.emit('peer-changed', key);
    }

    isConnected(key) {
        const peer = this.peer(key);
        return !!peer?.connections.some((conn) => this._authorized(peer, conn));
    }

    peer(key) {
        return this._peers.get(key) ?? null;
    }

    // Starts (or reuses) a conversation; returns its key, or null for bad input.
    open(input, scope = 'general', background = false, expectedLogin = null) {
        if (
            expectedLogin &&
            (!/^[a-zA-Z0-9_-]{1,64}$/.test(expectedLogin) ||
                this._blocked.has('@' + expectedLogin.toLowerCase()))
        )
            return null;
        if (!SEAT.test(String(input ?? '').trim())) return null;
        const target = normalizePeer(input);
        if (
            !target ||
            this.isBlocked(target.key) ||
            (!this._peers.has(target.key) && this._peers.size >= 64)
        )
            return null;
        if (!this.canOpen(target.key, scope)) return null;
        if (
            this.peer(target.key)?.scope !== scope ||
            (expectedLogin &&
                this.peer(target.key)?.login &&
                this.peer(target.key).login !== expectedLogin)
        )
            this.close(target.key);
        const selfTest = this.policy.grants.find(
            (grant) =>
                grant.testSelf &&
                grant.login === this.policy.login &&
                grant.id === scope &&
                grant.seat === target.key
        );
        const peer = this._peer(target.key, selfTest ? '127.0.0.1' : target.host);
        peer.scope = scope;
        peer.expectedLogin = expectedLogin;
        if (expectedLogin) peer.login = expectedLogin;
        if (!background) peer.background = false;
        if (!peer.connections.length && !peer.connecting) this._connect(peer);
        this.emit('peer-changed', peer.key);
        return peer.key;
    }

    send(key, text) {
        const peer = this._peers.get(key);
        text = String(text ?? '')
            .replace(/[\r\n]+/g, ' ')
            .trim()
            .slice(0, 1000);
        if (
            !peer ||
            !this.canOpen(peer.key, peer.scope) ||
            !text ||
            peer.queue.length >= 32 ||
            this.isBlocked(peer.key)
        )
            return false;
        peer.queue.push(text);
        this._record(peer, 'out', text);
        if (peer.connections.length) this._flush(peer);
        else if (!peer.connecting) this._connect(peer);
        return true;
    }

    markRead(key) {
        const peer = this._peers.get(key);
        if (!peer?.unread) return;
        peer.unread = 0;
        this.emit('peer-changed', key);
    }

    close(key) {
        const peer = this._peers.get(key);
        if (!peer) return;
        for (const [id, saved] of this._evaluationChats || [])
            if (saved.id === peer.scope) this._evaluationChats.delete(id);
        this._peers.delete(key);
        peer.connectCancel?.cancel();
        peer.connectCancel = null;
        peer.connecting = false;
        peer.history = [];
        peer.queue = [];
        this._clearSendingImage(peer);
        peer.unread = 0;
        for (const conn of [...peer.connections]) this._drop(peer, conn);
        this.emit('peer-changed', key);
    }

    destroy() {
        this._destroyed = true;
        this._cancel.cancel();
        for (const peer of this._peers.values()) {
            peer.connectCancel?.cancel();
            this._clearSendingImage(peer);
            for (const conn of peer.connections) this._closeStream(conn);
        }
        for (const conn of [...this._streams.keys()]) this._closeStream(conn);
        this._peers.clear();
        this._probes.clear();
        this._available.clear();
        this._evaluationChats?.clear();
        this._stopService();
        this.disconnectAll();
    }

    _stopService() {
        if (!this._service) return;
        this._service.stop();
        this._service.close();
        this._service = null;
    }

    _setState(state) {
        this.state = state;
        this.emit('server-state', state);
    }

    _peer(key, host) {
        let peer = this._peers.get(key);
        if (!peer) {
            peer = {
                key,
                host,
                connections: [],
                queue: [],
                writing: false,
                connecting: false,
                background: true,
                history: [],
                unread: 0,
                activity: Date.now(),
            };
            if (this._peers.size >= 64) {
                const idle = [...this._peers.values()].find(
                    (value) => !value.connections.length && !value.connecting
                );
                if (idle) this.close(idle.key);
            }
            this._peers.set(key, peer);
        } else if (host && !peer.host) {
            peer.host = host;
        }
        return peer;
    }

    _alive(peer) {
        return !this._destroyed && this._peers.get(peer.key) === peer;
    }

    _announceConnection(peer, text) {
        if (peer.background || peer.connectionAnnounced) return;
        peer.connectionAnnounced = true;
        this._record(peer, 'sys', text);
    }

    _record(peer, dir, text, image = null) {
        if (!this._alive(peer) || this.isBlocked(peer.key)) return;
        if (peer.background && dir === 'sys') return;
        if (dir !== 'sys') peer.background = false;
        const entry = { dir, text, time: now() };
        if (image) {
            entry.kind = 'image';
            entry.image = image;
            entry.imageOrder = ++this._imageSequence;
        }
        peer.history.push(entry);
        if (peer.history.length > MAX_HISTORY)
            peer.history.splice(0, peer.history.length - MAX_HISTORY);
        peer.activity = Date.now();
        if (dir === 'in') peer.unread++;
        const pruned = image ? this._trimImageHistory() : [];
        this.emit('message', peer.key, entry);
        for (const key of pruned) this.emit('image-history-pruned', key);
    }

    _trimImageHistory() {
        const entries = new Map();
        const add = (entry, key) => {
            if (!entry.image) return;
            if (!entries.has(entry)) entries.set(entry, new Set());
            entries.get(entry).add(key);
        };
        for (const peer of this._peers.values())
            for (const entry of peer.history) add(entry, peer.key);
        for (const saved of this._evaluationChats?.values() || [])
            for (const entry of saved.history) add(entry, saved.seat);
        if (!entries.size) return [];
        const pruned = new Set();
        let bytes = [...entries.keys()].reduce((sum, entry) => sum + entry.image.size, 0);
        for (const entry of [...entries.keys()].sort((a, b) => a.imageOrder - b.imageOrder)) {
            if (bytes <= imageModel().MAX_HISTORY_BYTES) break;
            bytes -= entry.image.size;
            entry.text = `[Image no longer kept in memory] ${entry.image.name}`;
            entry.image = null;
            for (const key of entries.get(entry)) pruned.add(key);
        }
        return [...pruned];
    }

    _connect(peer) {
        if (
            !this._alive(peer) ||
            peer.connecting ||
            !this.canOpen(peer.key, peer.scope) ||
            !peer.host ||
            this._connections >= MAX_CONNECTIONS
        )
            return;
        this._connections++; // Reserve capacity while the connection is pending.
        peer.connecting = true;
        this.emit('peer-changed', peer.key);
        const client = new Gio.SocketClient({ timeout: 5 });
        peer.connectCancel = new Gio.Cancellable();
        client.connect_to_host_async(
            peer.host,
            this.port,
            peer.connectCancel,
            (_client, result) => {
                this._connections--;
                let conn = null,
                    error = null;
                try {
                    conn = client.connect_to_host_finish(result);
                } catch (e) {
                    error = e;
                }
                if (this._destroyed) {
                    if (conn) this._closeStream(conn);
                    return;
                }
                peer.connecting = false;
                peer.connectCancel = null;
                if (!this._alive(peer)) {
                    if (conn) this._closeStream(conn);
                    return;
                }
                if (!conn) {
                    this.emit(
                        'connection-failed',
                        peer.key,
                        'Could not connect. The seat may be offline or Cluster Chat may be unavailable.'
                    );
                    const lost = peer.queue.length;
                    peer.queue = [];
                    this._record(
                        peer,
                        'sys',
                        `Connection failed: ${error?.message ?? 'unknown'}${lost ? ` (${lost} messages not sent)` : ''}`
                    );
                    this.emit('peer-changed', peer.key);
                    return;
                }
                this._connections++;
                this._announceConnection(peer, `Connected to ${peer.host}`);
                this._attach(peer, conn, true);
            }
        );
    }

    _accept(conn) {
        if (this._connections >= MAX_CONNECTIONS) {
            this._closeStream(conn);
            return;
        }
        this._connections++;
        const timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
            this._streams.delete(conn);
            this._connections--;
            try {
                conn.close(null);
            } catch (_) {}
            return GLib.SOURCE_REMOVE;
        });
        this._streams.set(conn, timeout);
        let address;
        try {
            address = conn.get_remote_address().get_address();
        } catch (_) {
            this._connections--;
            this._closeStream(conn);
            return;
        }
        const ip = address.to_string();
        const admit = (name) => {
            if (!this._streams.has(conn)) return;
            if (
                !this.policy.active ||
                !SEAT.test(peerKey(name ?? ip)) ||
                (!this.policy.general &&
                    !this.policy.grants.some(
                        (grant) => grant.seat === peerKey(name ?? ip) && grant.expires > Date.now()
                    )) ||
                this._destroyed ||
                this.isBlocked(name ?? ip) ||
                (!this._peers.has(peerKey(name ?? ip)) && this._peers.size >= 64)
            ) {
                this._connections--;
                this._closeStream(conn);
                return;
            }
            const peer = this._peer(peerKey(name ?? ip), name ?? ip);
            this._announceConnection(peer, `Connection from ${name ?? ip}`);
            this._attach(peer, conn);
        };
        if (address.get_is_loopback()) {
            const selfTest = this.policy.grants.find(
                (grant) =>
                    grant.testSelf &&
                    grant.login === this.policy.login &&
                    grant.expires > Date.now()
            );
            const localSeat = peerKey(GLib.get_host_name());
            admit(selfTest?.seat || (SEAT.test(localSeat) ? localSeat : 'localhost'));
            return;
        }
        // Only cluster hosts (or the private network they sit on) may open a chat.
        Gio.Resolver.get_default().lookup_by_address_async(
            address,
            this._cancel,
            (resolver, result) => {
                let name = null;
                try {
                    name = resolver
                        .lookup_by_address_finish(result)
                        .toLowerCase()
                        .replace(/\.$/, '');
                } catch (_) {
                    /* No PTR. */
                }
                if (!this._streams.has(conn)) return;
                if (this._destroyed) {
                    this._closeStream(conn);
                    return;
                }
                if (name?.endsWith(`.${DOMAIN}`)) admit(name);
                else if (address.get_is_site_local()) {
                    // A missing PTR must not bypass a seat block: compare forward DNS addresses.
                    const seats = [...this._blocked].filter((key) => SEAT.test(key));
                    let pending = seats.length;
                    let blocked =
                        this._blocked.has(ip) ||
                        [...this._blocked].some((rule) => /^c[0-9]+(?:r[0-9]+)?$/.test(rule));
                    const finish = () => {
                        if (!this._streams.has(conn)) return;
                        if (blocked || this._destroyed) {
                            this._connections--;
                            this._closeStream(conn);
                        } else admit(null);
                    };
                    if (!pending) finish();
                    for (const seat of seats) {
                        resolver.lookup_by_name_async(
                            `${seat}.${DOMAIN}`,
                            this._cancel,
                            (dns, lookup) => {
                                try {
                                    const addresses = dns.lookup_by_name_finish(lookup);
                                    if (
                                        this._blocked.has(seat) &&
                                        addresses.some((value) => value.equal(address))
                                    )
                                        blocked = true;
                                } catch (_) {
                                    // Cannot safely identify the sender while a blocked seat is unresolved.
                                    if (this._blocked.has(seat)) blocked = true;
                                }
                                if (--pending === 0) finish();
                            }
                        );
                    }
                } else {
                    this._connections--;
                    this._closeStream(conn);
                }
            }
        );
    }

    _attach(peer, conn, outgoing = false) {
        const input = new Gio.DataInputStream({
            base_stream: conn.get_input_stream(),
            close_base_stream: false,
        });
        this._handshakes.set(conn, {
            ready: false,
            sent: false,
            hello: null,
            input,
            output: conn.get_output_stream(),
        });
        peer.connections.push(conn);
        if (outgoing) this._sendHello(peer, conn);
        this._read(peer, conn, input);
        this.emit('peer-changed', peer.key);
        this._flush(peer);
    }

    _read(peer, conn, input, pending = []) {
        if (this._destroyed || !peer.connections.includes(conn)) return;
        const state = this._handshakes.get(conn);
        if (!state) return;
        if (!state.reading) {
            state.reading = true;
            state.lastRead = GLib.get_monotonic_time() / 1000000;
            const old = this._streams.get(conn);
            if (old) GLib.source_remove(old);
            const schedule = (seconds) => {
                const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
                    this._streams.delete(conn);
                    const remaining =
                        state.lastRead +
                        (state.hello ? 60 : 10) -
                        GLib.get_monotonic_time() / 1000000;
                    if (remaining > 0) schedule(Math.max(1, Math.ceil(remaining)));
                    else this._drop(peer, conn);
                    return GLib.SOURCE_REMOVE;
                });
                this._streams.set(conn, timer);
            };
            schedule(state.hello ? 60 : 10);
        }
        // Bound each event-loop turn while amortizing native callbacks over
        // several wire frames; MAX_LINE still bounds every individual line.
        input.read_bytes_async(16 * 1024, GLib.PRIORITY_DEFAULT, this._cancel, (stream, result) => {
            let bytes;
            try {
                bytes = stream.read_bytes_finish(result).get_data();
            } catch (_) {
                this._drop(peer, conn);
                return;
            }
            if (this._destroyed || !peer.connections.includes(conn)) return;
            if (!bytes?.length) {
                this._drop(peer, conn);
                return;
            }
            state.lastRead = GLib.get_monotonic_time() / 1000000;
            for (const byte of bytes) {
                if (byte !== 10) {
                    pending.push(byte);
                    if (pending.length > MAX_LINE) {
                        this._drop(peer, conn);
                        return;
                    }
                    continue;
                }
                let text;
                try {
                    text = ByteArray.toString(Uint8Array.from(pending)).replace(/\r$/, '');
                } catch (_) {
                    this._drop(peer, conn);
                    return;
                }
                pending = [];
                if (!this._allowLine(peer, conn, text)) {
                    this._drop(peer, conn);
                    return;
                }
                if (!this._handleLine(peer, conn, text)) {
                    peer.queue = [];
                    this._record(
                        peer,
                        'sys',
                        'Chat is not authorized. Both clients must allow this conversation.'
                    );
                    this._drop(peer, conn);
                    return;
                }
            }
            this._read(peer, conn, stream, pending);
        });
    }

    _allowLine(peer, conn, text) {
        let frame;
        try {
            frame = JSON.parse(text);
        } catch (_) {}
        // Chunks are bounded by their authenticated transfer, sequence, bytes
        // and absolute deadline; they are not separate user chat messages.
        if (
            frame?.type === 'image-chunk' &&
            this._incomingImages.has(conn) &&
            this._imageCapable(peer, conn)
        )
            return true;
        const time = GLib.get_monotonic_time() / 1000000;
        peer.rate ||= { time, count: 0 };
        for (const rate of [peer.rate, this._rate]) {
            if (time - rate.time >= 10) {
                rate.time = time;
                rate.count = 0;
            }
            rate.count++;
        }
        return peer.rate.count <= 20 && this._rate.count <= 100;
    }

    _clearSendingImage(peer) {
        if (peer.sendingImage?.timer) GLib.source_remove(peer.sendingImage.timer);
        peer.sendingImage = null;
    }

    _flush(peer) {
        if (
            !this._alive(peer) ||
            peer.writing ||
            (!peer.sendingImage && !peer.queue.length) ||
            !peer.connections.length
        )
            return;
        const item = peer.sendingImage || peer.queue[0];
        const imageItem = !!peer.sendingImage || item?.kind === 'image';
        const conn =
            peer.sendingImage?.conn ||
            peer.connections.find((connection) =>
                imageItem
                    ? this._imageCapable(peer, connection)
                    : this._authorized(peer, connection)
            );
        if (!conn) return;
        if (!this._authorized(peer, conn)) return;
        let frame, wire, advance, description;
        if (imageItem) {
            if (!peer.sendingImage) {
                const queued = peer.queue.shift();
                const transfer = {
                    image: queued.image,
                    conn,
                    id: GLib.uuid_string_random(),
                    phase: 'begin',
                    index: 0,
                    offset: 0,
                    timer: 0,
                };
                transfer.timer = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT,
                    IMAGE_TIMEOUT,
                    () => {
                        transfer.timer = 0;
                        this._record(peer, 'sys', 'Image sending timed out. Try sending it again.');
                        this._drop(peer, conn);
                        return GLib.SOURCE_REMOVE;
                    }
                );
                peer.sendingImage = transfer;
            }
            const transfer = peer.sendingImage;
            description = imageModel().summary(transfer.image);
            if (transfer.phase === 'begin') {
                const { mime, size, name } = transfer.image;
                frame = { type: 'image-begin', id: transfer.id, mime, size, name };
                advance = () => {
                    transfer.phase = 'data';
                };
            } else if (transfer.phase === 'data') {
                const lines = [];
                let offset = transfer.offset,
                    index = transfer.index;
                for (
                    let count = 0;
                    count < IMAGE_WRITE_CHUNKS && offset < transfer.image.data.length;
                    count++
                ) {
                    const data = transfer.image.data.slice(offset, offset + IMAGE_CHUNK);
                    lines.push(
                        JSON.stringify({ type: 'image-chunk', id: transfer.id, index, data })
                    );
                    offset += data.length;
                    index++;
                }
                wire = lines.join('\n') + '\n';
                advance = () => {
                    transfer.offset = offset;
                    transfer.index = index;
                    if (transfer.offset === transfer.image.data.length) transfer.phase = 'end';
                };
            } else {
                frame = { type: 'image-end', id: transfer.id };
                advance = () => {
                    this._clearSendingImage(peer);
                    this.emit('peer-changed', peer.key);
                };
            }
        } else {
            const text = peer.queue.shift();
            frame = { type: 'message', text };
            description = text;
            advance = () => {};
        }
        const state = this._handshakes.get(conn);
        state.output ||= conn.get_output_stream();
        const write = {
            output: state.output,
            bytes: new GLib.Bytes(ByteArray.fromString(wire || JSON.stringify(frame) + '\n')),
        };
        peer.writing = true;
        peer.activeWrite = write;
        peer.writeConnection = conn;
        const completed = (error) => {
            write.bytes = null;
            if (this._destroyed || !this._alive(peer) || peer.activeWrite !== write) return;
            peer.writing = false;
            peer.activeWrite = null;
            peer.writeConnection = null;
            if (error) {
                this._record(peer, 'sys', `Send failed: ${description}`);
                this._drop(peer, conn);
            } else advance();
            this._flush(peer);
        };
        writeBytes(write.output, write.bytes, this._cancel, completed);
    }

    _drop(peer, conn) {
        const index = peer.connections.indexOf(conn);
        if (index < 0) return;
        const authorized = this._handshakes.get(conn)?.ready === true;
        if (peer.sendingImage?.conn === conn) {
            this._clearSendingImage(peer);
            this._record(peer, 'sys', 'Image transfer interrupted. Try sending it again.');
        }
        if (peer.writeConnection === conn) {
            peer.activeWrite = null;
            peer.writeConnection = null;
            peer.writing = false;
        }
        peer.connections.splice(index, 1);
        this._connections--;
        this._closeStream(conn);
        if (!this._alive(peer)) return;
        if (!peer.connections.length) {
            const unsent = peer.queue.length;
            peer.queue = [];
            peer.writing = false;
            if (!authorized)
                this.emit(
                    'connection-failed',
                    peer.key,
                    'Connection rejected or timed out. Check that both users have Cluster Chat enabled and are not blocked.'
                );
            if (!authorized)
                this._record(
                    peer,
                    'sys',
                    'Connection unavailable or chat is disabled on the other seat.'
                );
            if (unsent)
                this._record(
                    peer,
                    'sys',
                    `${unsent} message(s) were not sent. Automatic retry stopped.`
                );
            // Only an explicit open/send may reconnect; a rejected handshake must never loop.
        }
        if (
            peer.connections.length &&
            !peer.connections.some((connection) => this._imageCapable(peer, connection))
        ) {
            const remaining = peer.queue.filter((item) => item?.kind !== 'image');
            if (remaining.length !== peer.queue.length)
                this._record(
                    peer,
                    'sys',
                    'Queued image was not sent: the remaining connection does not support images.'
                );
            peer.queue = remaining;
        }
        this.emit('peer-changed', peer.key);
    }

    _closeStream(conn) {
        this._clearImageTransfer(conn);
        this._handshakes.delete(conn);
        const timer = this._streams.get(conn);
        if (timer) GLib.source_remove(timer);
        this._streams.delete(conn);
        try {
            conn.close(null);
        } catch (_) {
            /* Already closed. */
        }
    }
};
Signals.addSignalMethods(ChatService.prototype);
