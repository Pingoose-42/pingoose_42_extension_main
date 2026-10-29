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
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

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
            Policy.accepts(this.policy, peer.key, state.hello) &&
            peer.scope === state.hello.scope
        );
    }
    _sendHello(peer, conn) {
        const state = this._handshakes.get(conn);
        if (!state || state.sent) return;
        state.sent = true;
        const hello = {
            type: 'hello',
            protocol: 'pingoose-chat-2',
            scope: peer.scope,
            login: this.policy.login,
            general: this.policy.general,
        };
        conn.get_output_stream().write_all_async(
            ByteArray.fromString(JSON.stringify(hello) + '\n'),
            GLib.PRIORITY_DEFAULT,
            this._cancel,
            (stream, result) => {
                try {
                    stream.write_all_finish(result);
                } catch (_) {
                    peer.queue = [];
                    this._drop(peer, conn);
                    return;
                }
                if (!this._handshakes.has(conn)) return;
                state.written = true;
                state.ready = !!state.hello;
                this._ready(peer, conn);
                this._flush(peer);
            }
        );
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
            this.emit('peer-changed', peer.key);
            this._sendHello(peer, conn);
            state.ready = !!state.written;
            this._ready(peer, conn);
            this._flush(peer);
            return true;
        }
        if (
            !this._authorized(peer, conn) ||
            value?.type !== 'message' ||
            typeof value.text !== 'string' ||
            value.text.length > 1000
        )
            return false;
        if (value.text.trim()) this._record(peer, 'in', value.text);
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
        peer.unread = 0;
        for (const conn of [...peer.connections]) this._drop(peer, conn);
        this.emit('peer-changed', key);
    }

    destroy() {
        this._destroyed = true;
        this._cancel.cancel();
        for (const peer of this._peers.values()) {
            peer.connectCancel?.cancel();
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

    _record(peer, dir, text) {
        if (!this._alive(peer) || this.isBlocked(peer.key)) return;
        if (peer.background && dir === 'sys') return;
        if (dir !== 'sys') peer.background = false;
        const entry = { dir, text, time: now() };
        peer.history.push(entry);
        if (peer.history.length > MAX_HISTORY)
            peer.history.splice(0, peer.history.length - MAX_HISTORY);
        peer.activity = Date.now();
        if (dir === 'in') peer.unread++;
        this.emit('message', peer.key, entry);
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
            admit(selfTest?.seat || 'localhost');
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
        this._handshakes.set(conn, { ready: false, sent: false, hello: null });
        peer.connections.push(conn);
        const input = new Gio.DataInputStream({
            base_stream: conn.get_input_stream(),
            close_base_stream: false,
        });
        if (outgoing) this._sendHello(peer, conn);
        this._read(peer, conn, input);
        this.emit('peer-changed', peer.key);
        this._flush(peer);
    }

    _read(peer, conn, input, pending = []) {
        if (this._destroyed || !peer.connections.includes(conn)) return;
        const old = this._streams.get(conn);
        if (old) GLib.source_remove(old);
        const timer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._handshakes.get(conn)?.hello ? 60 : 10,
            () => {
                this._streams.delete(conn);
                this._drop(peer, conn);
                return GLib.SOURCE_REMOVE;
            }
        );
        this._streams.set(conn, timer);
        input.read_bytes_async(1024, GLib.PRIORITY_DEFAULT, this._cancel, (stream, result) => {
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
            for (const byte of bytes) {
                if (byte !== 10) {
                    pending.push(byte);
                    if (pending.length > MAX_LINE) {
                        this._drop(peer, conn);
                        return;
                    }
                    continue;
                }
                const time = GLib.get_monotonic_time() / 1000000;
                peer.rate ||= { time, count: 0 };
                for (const rate of [peer.rate, this._rate]) {
                    if (time - rate.time >= 10) {
                        rate.time = time;
                        rate.count = 0;
                    }
                    rate.count++;
                }
                if (peer.rate.count > 20 || this._rate.count > 100) {
                    this._drop(peer, conn);
                    return;
                }
                let text;
                try {
                    text = ByteArray.toString(Uint8Array.from(pending)).replace(/\r$/, '');
                } catch (_) {
                    this._drop(peer, conn);
                    return;
                }
                pending = [];
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

    _flush(peer) {
        if (peer.writing || !peer.queue.length || !peer.connections.length) return;
        const conn = peer.connections.find((connection) => this._authorized(peer, connection));
        if (!conn) return;
        const text = peer.queue.shift();
        peer.writing = true;
        conn.get_output_stream().write_all_async(
            ByteArray.fromString(JSON.stringify({ type: 'message', text }) + '\n'),
            GLib.PRIORITY_DEFAULT,
            this._cancel,
            (stream, result) => {
                let ok = true;
                try {
                    stream.write_all_finish(result);
                } catch (_) {
                    ok = false;
                }
                if (this._destroyed || !this._alive(peer)) return;
                peer.writing = false;
                if (!ok) {
                    this._record(peer, 'sys', `Send failed: ${text}`);
                    this._drop(peer, conn);
                }
                this._flush(peer);
            }
        );
    }

    _drop(peer, conn) {
        const index = peer.connections.indexOf(conn);
        if (index < 0) return;
        const authorized = this._handshakes.get(conn)?.ready === true;
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
        this.emit('peer-changed', peer.key);
    }

    _closeStream(conn) {
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
