const { Clutter, GLib, Pango, St } = imports.gi;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Chat = Me.imports.services.chat;
function wrapLabel(label) {
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}
var Controller = class Controller {
    constructor({ addButton, allowed, getChat, isBlockedLogin, send, select, onIdle }) {
        Object.assign(this, { allowed, getChat, isBlockedLogin, send, select, onIdle });
        const ui = (this.ui = { add: addButton });
        const add = addButton;
        const center = Clutter.ActorAlign.CENTER;
        ui.peerRow = new St.BoxLayout({ visible: false, style_class: 'pingoose-chat-input-row' });
        ui.peerEntry = new St.Entry({
            hint_text: 'Seat number or Intra ID',
            can_focus: true,
            x_expand: true,
            style_class: 'pingoose-chat-entry',
        });
        const connect = (ui.connect = new St.Button({
            can_focus: true,
            accessible_name: 'Connect',
            style_class: 'pingoose-chat-send',
        }));
        const connectContent = new St.BoxLayout({ x_align: center, y_align: center });
        ui.connectLabel = new St.Label({ text: 'Connect' });
        ui.connectSpinner = Me.imports.ui.spinner.create(16);
        ui.connectSpinner.hide();
        connectContent.add_child(ui.connectLabel);
        connectContent.add_child(ui.connectSpinner);
        connect.set_child(connectContent);
        ui.peerRow.add_child(ui.peerEntry);
        ui.peerRow.add_child(connect);

        ui.peerFeedback = wrapLabel(
            new St.Label({
                visible: false,
                x_expand: true,
                request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
                style_class: 'pingoose-chat-connect-error',
            })
        );

        const submitPeer = () => {
            if (!this.allowed()) return;
            if (this._lookup || this._pendingConnection) return;
            this._pendingConnection = null;
            ui.peerFeedback.hide();
            ui.peerEntry.remove_style_class_name('pingoose-chat-entry-error');
            const seat = ui.peerEntry.text.trim().toLowerCase().replace(/^@/, '');
            if (!Chat.SEAT.test(seat) && /^[a-z0-9_-]{1,64}$/.test(seat)) {
                this.lookupLogin(seat);
                return;
            }
            if (!Chat.SEAT.test(seat)) {
                this._connectionError('Enter a valid seat number or Intra ID.');
                return;
            }
            this._connectPeer(seat);
        };
        ui.peerEntry.clutter_text.connect('activate', submitPeer);
        ui.peerEntry.clutter_text.connect('text-changed', () => {
            ui.peerEntry.remove_style_class_name('pingoose-chat-entry-error');
            ui.peerFeedback.hide();
        });
        connect.connect('clicked', submitPeer);
        ui.peerReveal = new Me.imports.ui.reveal.Reveal(ui.peerRow);
        this.addSignal = add.connect('clicked', () => {
            if (!this.allowed()) return;
            if (this._lookup || this._pendingConnection) return;
            const open = !ui.peerReveal.expanded;
            this._resetPeerInput(false);
            this._setInputOpen(open);
            if (open) global.stage.set_key_focus(ui.peerEntry);
        });
    }
    get row() {
        return this.ui.peerReveal;
    }
    get feedback() {
        return this.ui.peerFeedback;
    }
    get busy() {
        return !!(this._lookup || this._pendingConnection);
    }

    lookupLogin(login) {
        if (!this.allowed() || this.busy) return false;
        this.ui.peerEntry.text = login;
        this._lookup = { login, request: String(GLib.get_monotonic_time()) };
        this._setConnectBusy(true);
        this.send('chat:lookup:' + JSON.stringify(this._lookup));
        return true;
    }

    failed(key, reason) {
        if (this._pendingConnection?.key !== key) return;
        this.ui.peerEntry.text = this._pendingConnection.input;
        this._pendingConnection = null;
        if (this.getChat().peer(key)?.background) this.getChat().close(key);
        this._connectionError(reason);
    }

    resetInput() {
        this._resetPeerInput();
    }
    ready(key) {
        this._connectionReady(key);
    }

    reset() {
        this._lookup = null;
        this._pendingConnection = null;
        this._setConnectBusy(false);
        this._resetPeerInput();
    }

    destroy() {
        this.reset();
        this.ui.add.disconnect(this.addSignal);
        this.row.destroy();
        this.feedback.destroy();
    }
    completeLookup(message) {
        if (
            !this._lookup ||
            message.request !== this._lookup.request ||
            message.login !== this._lookup.login
        )
            return;
        this._lookup = null;
        if (!this.allowed()) {
            this._setConnectBusy(false);
            return;
        }
        if (message.error) {
            this._connectionError(message.error);
            return;
        }
        if (!Chat.SEAT.test(message.seat || '')) {
            this._connectionError(
                'Could not find this user’s seat. Check the Intra ID and whether they are logged in to a cluster.'
            );
            return;
        }
        this._connectPeer(message.seat, message.login);
    }
    _setInputOpen(open) {
        this.ui.peerReveal.setExpanded(open);
        this.ui.add.style_class = 'pingoose-chat-add' + (open ? ' pingoose-toggle-active' : '');
    }
    _resetPeerInput(close = true) {
        const ui = this.ui;
        ui.peerEntry.text = '';
        ui.peerEntry.remove_style_class_name('pingoose-chat-entry-error');
        ui.peerFeedback.text = '';
        ui.peerFeedback.hide();
        if (close) this._setInputOpen(false);
    }
    _setConnectBusy(busy) {
        if (!busy) this.onIdle();
        const ui = this.ui;
        ui.connectSpinner.visible = busy;
        ui.connectLabel.visible = !busy;
        ui.connect.reactive = ui.connect.can_focus = !busy;
        ui.add.reactive = !busy;
        ui.peerEntry.clutter_text.editable = !busy;
    }
    _connectionReady(key) {
        if (this._pendingConnection?.key !== key) return;
        this._pendingConnection = null;
        this.getChat().showConnected(key);
        this.select(key);
        this._setConnectBusy(false);
        this.ui.peerEntry.text = '';
        this.ui.peerFeedback.hide();
        this._setInputOpen(false);
    }
    _connectionError(text) {
        this._setConnectBusy(false);
        const ui = this.ui;
        this._setInputOpen(true);
        ui.peerEntry.add_style_class_name('pingoose-chat-entry-error');
        ui.peerFeedback.text = text;
        ui.peerFeedback.show();
    }
    _connectPeer(seat, login = null) {
        if (this.getChat().isBlocked(seat) || (login && this.isBlockedLogin(login))) {
            this._connectionError('Connection blocked by your blacklist.');
            return;
        }
        const key = this.getChat().open(seat, 'general', true, login);
        if (!key) {
            this._connectionError(
                'Could not start a connection. Check your chat settings and connection limit.'
            );
            return;
        }
        this._pendingConnection = { key, input: this.ui.peerEntry.text };
        this.ui.peerFeedback.hide();
        this._setConnectBusy(true);
        if (this.getChat().isConnected(key)) this._connectionReady(key);
    }
};
