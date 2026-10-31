const CountLabel = imports.misc.extensionUtils.getCurrentExtension().imports.ui.countLabel;
// Chat UI adapted from origin/deeeev-gangjeon; displayed beside the main menu.
const { Clutter, Gio, GLib, Pango, St } = imports.gi;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const PopupMenu = imports.ui.popupMenu;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Chat = Me.imports.services.chat;
const Flags = Me.imports.models.featureFlags;
const Policy = Me.imports.models.chatPolicy;
function wrapLabel(label) {
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}
var ChatPanel = class ChatPanel {
    constructor(indicator, send) {
        this._send = send;
        this._indicator = indicator;
        this._settings = imports.misc.extensionUtils.getSettings();
        this._blocked = this._settings.get_strv('blocked-chat-seats');
        this._expanded = this._settings.get_boolean('expand-chat');
        this._buildChat();
        this._favorites = new Me.imports.ui.favorites.Panel(this);
        this.sync();
        this._settingsSignal = this._settings.connect('changed', (_settings, key) => {
            this.sync();
        });
    }
    sync() {
        if (!this._chatUi) return;
        const blocked = this._settings.get_strv('blocked-chat-seats');
        if (JSON.stringify(blocked) !== JSON.stringify(this._blocked)) {
            this._blocked = blocked;
            this._chat.setBlocked(blocked);
        }
        const active = !this._indicator.loginOnly;
        const general = Flags.enabled(this._settings, 'hidden-cluster-chat');
        const selected = this._chat.peer(this._chatActive);
        if (selected?.scope && selected.scope !== 'general')
            this._selectedEvaluation = selected.scope;
        if (
            !this._sessions?.some(
                (session) => session.id === this._selectedEvaluation && session.expires > Date.now()
            )
        )
            this._selectedEvaluation = null;
        this._chat.configure({
            active,
            general,
            login: GLib.get_user_name(),
            grants: this._grants || [],
            sessions: this._sessions || [],
        });
        const moved =
            this._selectedEvaluation &&
            this._chat.peers.find((peer) => peer.scope === this._selectedEvaluation);
        if (moved && moved.key !== this._chatActive) {
            this._chatActive = moved.key;
            this._renderChat();
        }
        if (active && this._chat.state === 'stopped') this._chat.start();
        this._chatUi.item.visible = active && general && this._settings.get_boolean('show-chat');
        this._chatUi.add.visible = general;
        if (!active || !general) this.connection.reset();
        if (this._chatActive && !this._chat.peer(this._chatActive)) {
            this._chatActive = null;
            this._chatUi.entry.text = '';
            this._renderChat();
            this._chatBannerSource?.destroy();
            this._chatBannerSource = null;
            this._updatePanelLabel();
            if (!general && !this._selectedEvaluation) this._expanded = false;
        }
        this._chatUi.visible = active && this._expanded && (general || !!this._chatActive);
        this._indicator.setPanelVisible(this._chatUi.root, this._chatUi.visible);
        this._updatePanelLabel();
        this._chatUi.toggle.style_class =
            'pingoose-visit-intra' + (this._chatUi.visible ? ' pingoose-toggle-active' : '');
        if (this._settings.get_boolean('expand-chat') !== this._expanded)
            this._settings.set_boolean('expand-chat', this._expanded);
        this._favorites?.sync();
        this._attachments?.refresh();
        this._attachments?.setVisible(this._indicator.menu.isOpen && this._chatUi.visible);
        this._indicator.syncPanelLayout?.();
        if (
            this._expanded &&
            this._indicator.menu.isOpen &&
            !this._indicator.loginOnly &&
            this._chatActive
        )
            this._chat.markRead(this._chatActive);
    }
    updateEvaluations(rows) {
        this._sessions = rows
            .filter(
                (row) =>
                    !row.missing &&
                    (!row.devTest || Flags.enabled(this._settings, 'hidden-dev-options'))
            )
            .flatMap((row) =>
                (row.users || []).map((login) => ({
                    id: String(row.id),
                    login,
                    expires: Date.parse(row.begin),
                }))
            )
            .filter((session) => session.expires > Date.now());
        this._grants = Policy.grantsFrom(
            rows.filter(
                (row) => !row.devTest || Flags.enabled(this._settings, 'hidden-dev-options')
            ),
            Date.now(),
            GLib.get_user_name()
        );
        const expired = this._chat.peers.some(
            (peer) =>
                peer.scope &&
                peer.scope !== 'general' &&
                !this._grants.some((grant) => grant.id === peer.scope && grant.seat === peer.key)
        );
        this.sync();
        for (const grant of this._grants) this._chat.probe(grant);
        if (expired) {
            this._chatBannerSource?.destroy();
            this._chatBannerSource = null;
        }
    }
    canEvaluation(row, login) {
        return (this._grants || []).find(
            (grant) =>
                grant.id === String(row.id) &&
                grant.login === login &&
                grant.expires > Date.now() &&
                this._chat.available(grant)
        );
    }
    openEvaluation(row, login) {
        const grant = this.canEvaluation(row, login);
        if (!grant || this._indicator.loginOnly) return;
        const key = this._chat.open(grant.seat, grant.id, false, login);
        if (!key) return;
        this._expanded = true;
        this._indicator.bringPanelNearMain(this._chatUi.root);
        this._selectChat(key);
        this.sync();
    }
    completeLookup(message) {
        if (message.favorite) this._favorites?.complete(message);
        else this.connection.completeLookup(message);
    }
    get connecting() {
        return this.connection.busy;
    }
    connectUser(login) {
        return this.connection.lookupLogin(login);
    }
    _updatePanelLabel() {
        const count = this._chat.unread;
        CountLabel.update(
            this._chatUi.toggle.get_child(),
            'Cluster Chat',
            count > 5 ? '5+' : count,
            this._chatUi.visible
        );
    }
    reset() {
        this._attachments?.reset();
        this._favorites?.reset();
        this._chatBannerSource?.destroy();
        this._chatBannerSource = null;
        this._expanded = false;
        this.connection.reset();
        this._grants = [];
        this._sessions = [];
        this._selectedEvaluation = null;
        this._chatUi.entry.text = '';
        this._chat.destroy();
        this._chat = new Chat.ChatService(Chat.PORT, this._blocked);
        this._bindChatSignals();
        this._chatActive = null;
        this._renderChatStatus();
        this._renderChat();
        this._updatePanelLabel();
        this.sync();
    }
    completeClusters(message) {
        this._favorites?.completeClusters(message);
    }

    close() {
        if (!this._attachments?.suspendingMenu)
            this._attachments?.cancel('Image selection cancelled.');
        if (this._favorites) this._favorites.expanded = false;
        this._expanded = false;
        this.sync();
    }

    destroy() {
        this._attachments?.destroy();
        this.connection.destroy();
        this._indicator.menu.disconnect(this._menuSignal);
        this._favorites?.destroy();
        this._chatBannerSource?.destroy();
        this._chatBannerSource = null;
        this._settings.disconnect(this._settingsSignal);
        this._chat.destroy();
        this._chatUi = null;
    }
    _buildChat() {
        const indicator = this._indicator;
        const center = Clutter.ActorAlign.CENTER;
        this._chat = new Chat.ChatService(Chat.PORT, this._blocked);
        this._chatActive = null;
        const ui = (this._chatUi = { stick: true });
        const root = new St.BoxLayout({
            vertical: true,
            reactive: true,
            visible: false,
            y_expand: false,
            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
            y_align: Clutter.ActorAlign.START,
            style_class: 'pingoose-chat pingoose-chat-panel',
        });
        ui.root = root;
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        item.remove_all_children();
        item.add_style_class_name('pingoose-overview-item');
        const toggle = new St.Button({
            label: 'Cluster Chat',
            can_focus: true,
            x_expand: true,
            style_class: 'pingoose-visit-intra',
        });
        ui.toggle = toggle;
        item.add_child(toggle);
        indicator.menu.addMenuItem(item);
        ui.item = item;
        toggle.connect('clicked', () => {
            this._expanded = !this._expanded;
            if (!this._expanded) this._attachments?.cancel('Image selection cancelled.');
            if (this._expanded) indicator.bringPanelNearMain(root);
            if (this._expanded && this._chat.state === 'stopped') this._chat.start();
            this.sync();
        });

        const header = new St.BoxLayout({ style_class: 'pingoose-chat-header' });
        header.add_child(
            new St.Label({
                text: 'Cluster Chat',
                x_expand: true,
                y_align: center,
                style_class: 'pingoose-heading',
            })
        );
        // Clicking the status retries the listener when the port was taken.
        ui.status = new St.Button({
            can_focus: true,
            y_align: center,
            style_class: 'pingoose-chat-status',
        });
        ui.status.connect('clicked', () => {
            if (this._chat.state !== 'listening') this._chat.start();
        });
        const dismiss = new St.Button({
            label: '×',
            can_focus: true,
            accessible_name: 'Close Cluster Chat',
            style_class: 'pingoose-dismiss',
        });
        dismiss.connect('clicked', () => this.close());
        header.add_child(dismiss);
        root.add_child(header);
        root.add_child(ui.status);

        const chipRow = new St.BoxLayout({ style_class: 'pingoose-chat-chip-row' });
        const chipScroll = new St.ScrollView({
            x_expand: true,
            overlay_scrollbars: false,
            style_class: 'pingoose-chat-chip-scroll',
        });
        chipScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.NEVER);
        ui.chipScroll = chipScroll;
        ui.chipOverflow = false;
        chipScroll.connect('notify::allocation', () => this._syncChipOverflow());
        ui.chips = new St.BoxLayout({ style_class: 'pingoose-chat-chips' });
        chipScroll.add_actor(ui.chips);
        chipRow.add_child(chipScroll);
        const add = (ui.add = new St.Button({
            label: '+',
            can_focus: true,
            y_align: center,
            accessible_name: 'New chat',
            style_class: 'pingoose-chat-add',
        }));
        chipRow.add_child(add);
        ui.favorites = new St.Button({
            label: '☆',
            accessible_name: 'Favorites',
            can_focus: true,
            y_align: center,
            visible: false,
            style_class: 'pingoose-chat-add',
        });
        ui.favorites.connect('clicked', () => this._favorites?.toggle());
        chipRow.add_child(ui.favorites);
        root.add_child(chipRow);

        this.connection = new Me.imports.ui.chatConnection.Controller({
            addButton: add,
            allowed: () =>
                !this._indicator.loginOnly && Flags.enabled(this._settings, 'hidden-cluster-chat'),
            getChat: () => this._chat,
            isBlockedLogin: (login) => this._blocked.includes('@' + login),
            send: (command) => this._send(command),
            select: (key) => this._selectChat(key),
            onIdle: () => this._favorites?.finishConnect(),
        });
        root.add_child(this.connection.row);
        root.add_child(this.connection.feedback);

        const scroll = new St.ScrollView({
            x_expand: true,
            overlay_scrollbars: false,
            style_class: 'pingoose-chat-scroll',
        });
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        ui.log = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'pingoose-chat-log',
        });
        scroll.add_actor(ui.log);
        root.add_child(scroll);
        // Follow new messages only while the view is already at the bottom.
        const adjustment = (ui.adjustment = scroll.vscroll.adjustment);
        adjustment.connect('notify::value', () => {
            ui.stick = adjustment.value + adjustment.page_size >= adjustment.upper - 4;
        });
        adjustment.connect('changed', () => {
            if (ui.stick) adjustment.value = adjustment.upper - adjustment.page_size;
        });

        const inputRow = new St.BoxLayout({ style_class: 'pingoose-chat-input-row' });
        ui.entry = new St.Entry({
            can_focus: true,
            x_expand: true,
            style_class: 'pingoose-chat-entry',
        });
        ui.entry.clutter_text.max_length = 1000;
        ui.entry.clutter_text.set_selectable(true);
        ui.entry.clutter_text.reactive = true;
        // Forward only padding clicks; glyph events already reach Clutter.Text.
        ui.entry.connect('button-press-event', (_actor, event) => {
            if (!ui.entry.reactive || event.get_button() !== 1 || event.get_source() !== ui.entry)
                return Clutter.EVENT_PROPAGATE;
            ui.entry.clutter_text.grab_key_focus();
            ui.entry.clutter_text.event(event, false);
            return Clutter.EVENT_STOP;
        });
        ui.send = new St.Button({
            can_focus: true,
            accessible_name: 'Send',
            style_class: 'pingoose-chat-send',
        });
        ui.send.set_child(
            new St.Icon({
                gicon: new Gio.FileIcon({
                    file: Gio.File.new_for_path(Me.path + '/assets/send-symbolic.svg'),
                }),
                icon_size: 16,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            })
        );
        this._attachments = new Me.imports.ui.chatAttachments.Controller({
            menu: indicator.menu,
            getTarget: () => ({
                service: this._chat,
                key: this._chatActive,
                peer: this._chat.peer(this._chatActive),
                available: !this._indicator.loginOnly,
            }),
            onPreviewReady: () => this._followChatBottom(),
        });
        inputRow.add_child(this._attachments.button);
        inputRow.add_child(ui.entry);
        inputRow.add_child(ui.send);
        root.add_child(inputRow);
        root.add_child(this._attachments.feedback);
        indicator.addPanel(root, { key: 'chat-panel-height', scroll });
        const submit = () => {
            if (!this._chatActive || !this._chat.send(this._chatActive, ui.entry.text)) return;
            ui.entry.text = '';
        };
        ui.entry.clutter_text.connect('activate', submit);
        ui.send.connect('clicked', submit);
        this._bindChatSignals();
        this._menuSignal = indicator.menu.connect('open-state-changed', (_menu, open) => {
            this._attachments.onMenuState(open);
            this.connection.resetInput();
            this._favorites?.resetInput();
            this.sync();
            if (!open || !this._chat || !this._expanded) return;
            if (this._chatActive) this._chat.markRead(this._chatActive);
            this._updatePanelLabel();
        });
        this._renderChatStatus();
        this._renderChat();
    }

    _bindChatSignals() {
        this._chat.connect('availability-changed', () => {
            this._attachments?.refresh();
            this.onAvailabilityChanged?.();
        });
        this._chat.connect('connection-failed', (_chat, key, reason) =>
            this.connection.failed(key, reason)
        );
        this._chat.connect('connection-ready', (_chat, key) => this.connection.ready(key));
        this._chat.connect('server-state', () => this._renderChatStatus());
        this._chat.connect('peer-changed', () => {
            this._attachments?.refresh();
            this._renderChatChips();
            this._updatePanelLabel();
        });
        this._chat.connect('message', (_chat, key, entry) => this._chatMessage(key, entry));
        this._chat.connect('image-history-pruned', () => this._attachments?.prune());
    }

    _renderChatStatus() {
        const ui = this._chatUi;
        if (!ui) return;
        const state = this._chat.state;
        const seat = GLib.get_host_name().split('.')[0];
        ui.status.label =
            state === 'listening'
                ? `● ${seat} · Ready`
                : state === 'port-busy'
                  ? `● :${this._chat.port} in use · Retry`
                  : 'Open a chat to connect';
        ui.status.style_class = `pingoose-chat-status pingoose-chat-status-${state === 'listening' ? 'ok' : 'err'}`;
    }

    _renderChatChips() {
        const ui = this._chatUi;
        if (!ui) return;
        const center = Clutter.ActorAlign.CENTER;
        ui.chips.destroy_all_children();
        for (const peer of this._chat.peers.filter((peer) => !peer.background)) {
            const chip = new St.BoxLayout({
                style_class:
                    peer.key === this._chatActive
                        ? 'pingoose-chat-chip pingoose-chat-chip-active'
                        : 'pingoose-chat-chip',
            });
            const pick = new St.Button({
                can_focus: true,
                style_class: 'pingoose-chat-chip-button',
            });
            const content = new St.BoxLayout({ style_class: 'pingoose-chat-chip-content' });
            const dot = peer.connections.length ? 'on' : peer.connecting ? 'wait' : 'off';
            content.add_child(
                new St.Label({
                    text: '●',
                    y_align: center,
                    style_class: `pingoose-chat-dot pingoose-chat-dot-${dot}`,
                })
            );
            content.add_child(
                new St.Label({
                    text: peer.login ? `${peer.login} (${peer.key})` : peer.key,
                    y_align: center,
                })
            );
            if (peer.unread) {
                content.add_child(
                    new St.Label({
                        text: peer.unread > 9 ? '9+' : String(peer.unread),
                        y_align: center,
                        style_class: 'pingoose-chat-badge',
                    })
                );
            }
            pick.set_child(content);
            pick.connect('clicked', () => this._selectChat(peer.key));
            const close = new St.Button({
                label: '×',
                can_focus: true,
                y_align: center,
                accessible_name: `Close chat with ${peer.key}`,
                style_class: 'pingoose-chat-chip-close',
            });
            close.connect('clicked', () => {
                this._chat.close(peer.key);
                if (this._chatActive !== peer.key) return;
                this._chatActive = this._chat.peers[0]?.key ?? null;
                this._renderChat();
            });
            chip.add_child(pick);
            chip.add_child(close);
            ui.chips.add_child(chip);
        }
        this._syncChipOverflow();
    }

    _syncChipOverflow() {
        const ui = this._chatUi;
        if (!ui?.chipScroll || ui.chipScroll.width <= 0) return;
        const children = ui.chips.get_children();
        const spacing = ui.chips.get_theme_node().get_length('spacing');
        const natural =
            children.reduce((sum, child) => sum + child.get_preferred_width(-1)[1], 0) +
            Math.max(0, children.length - 1) * spacing;
        const available = ui.chipScroll
            .get_theme_node()
            .get_content_box(ui.chipScroll.get_allocation_box())
            .get_width();
        const overflow = natural > available + 1;
        if (overflow === ui.chipOverflow) return;
        ui.chipOverflow = overflow;
        ui.chipScroll.set_policy(
            overflow ? St.PolicyType.ALWAYS : St.PolicyType.NEVER,
            St.PolicyType.NEVER
        );
    }

    _renderChat() {
        const ui = this._chatUi;
        this._renderChatChips();
        ui.log.destroy_all_children();
        ui.placeholder = null;
        ui.stick = true;
        const peer = this._chatActive ? this._chat.peer(this._chatActive) : null;
        ui.entry.reactive = ui.send.reactive = !!peer;
        this._attachments?.refresh();
        ui.entry.hint_text = peer ? `Message ${peer.key}…` : 'No connected chats.';
        if (!peer?.history.length) {
            ui.placeholder = wrapLabel(
                new St.Label({
                    x_expand: true,
                    style_class: 'pingoose-chat-empty',
                    text: peer ? 'No messages yet.' : 'No connected chats.',
                })
            );
            ui.log.add_child(ui.placeholder);
            return;
        }
        for (const entry of peer.history) this._appendChatEntry(entry);
    }

    _appendChatEntry(entry) {
        const ui = this._chatUi;
        while (ui.log.get_children().length >= 200) ui.log.get_children()[0].destroy();
        ui.placeholder?.destroy();
        ui.placeholder = null;
        if (entry.dir === 'sys') {
            ui.log.add_child(
                wrapLabel(
                    new St.Label({
                        text: `${entry.text} · ${entry.time}`,
                        x_align: Clutter.ActorAlign.CENTER,
                        style_class: 'pingoose-chat-system',
                    })
                )
            );
            return;
        }
        const out = entry.dir === 'out';
        const align = out ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
        const bubble = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            x_align: align,
            style_class: `pingoose-chat-bubble pingoose-chat-bubble-${out ? 'out' : 'in'}`,
        });
        if (entry.kind === 'image') bubble.add_child(this._attachments.preview(entry));
        else {
            // Plain text only: peer input must never be parsed as Pango markup.
            const message = wrapLabel(
                new St.Label({
                    text: entry.text,
                    reactive: true,
                    can_focus: true,
                    style_class: 'pingoose-chat-text',
                })
            );
            Me.imports.ui.selectableText.attach(message);
            bubble.add_child(message);
        }
        bubble.add_child(
            new St.Label({ text: entry.time, x_align: align, style_class: 'pingoose-chat-time' })
        );
        ui.log.add_child(bubble);
    }

    _followChatBottom() {
        const ui = this._chatUi;
        if (ui?.stick && ui.adjustment)
            ui.adjustment.value = Math.max(
                ui.adjustment.lower,
                ui.adjustment.upper - ui.adjustment.page_size
            );
    }

    _isViewingChat(key) {
        return (
            this._indicator.menu.isOpen &&
            !this._indicator.loginOnly &&
            this._expanded &&
            this._chatUi.visible &&
            this._chatUi.root.mapped &&
            this._chatActive === key
        );
    }

    _chatMessage(key, entry) {
        if (!this._chatUi) return;
        if (!this._chatActive) {
            this._chatActive = key;
            this._renderChat();
        } else if (key === this._chatActive) {
            if (entry.dir === 'out') this._chatUi.stick = true;
            this._appendChatEntry(entry);
        }
        if (entry.dir !== 'in') return;
        if (this._isViewingChat(key)) {
            this._chat.markRead(key);
            return;
        }
        this._renderChatChips();
        this._updatePanelLabel();
        this._notifyChat(key, entry.text);
    }

    _notifyChat(key, text) {
        if (!this._settings.get_boolean('notify-chat')) return;
        const now = GLib.get_monotonic_time();
        if (this._lastChatBanner && now - this._lastChatBanner < 3000000) return;
        this._lastChatBanner = now;
        if (!this._chatBannerSource) {
            this._chatBannerSource = new MessageTray.Source(
                'Cluster Chat',
                'user-available-symbolic'
            );
            this._chatBannerSource.connect('destroy', () => {
                this._chatBannerSource = null;
            });
            Main.messageTray.add(this._chatBannerSource);
        }
        const peer = this._chat.peer(key);
        const sender = peer?.login ? `${peer.login} (${peer.key || key})` : key;
        const banner = new MessageTray.Notification(
            this._chatBannerSource,
            `Cluster Chat · ${sender}`,
            text.slice(0, 200)
        );
        banner.pingooseBanner = true;
        banner.setTransient(true);
        banner.connect('activated', () => {
            if (!this._chat.peer(key)) return;
            this._expanded = true;
            this._indicator.bringPanelNearMain(this._chatUi.root);
            this._indicator.menu.open();
            this.sync();
            this._selectChat(key);
        });
        this._chatBannerSource.showNotification(banner);
    }

    _selectChat(key) {
        if (key !== this._chatActive)
            this._attachments?.cancel('The chat changed. The image was not sent.');
        this._chatActive = key;
        this._chat.markRead(key);
        this._renderChat();
        this._updatePanelLabel();
        global.stage.set_key_focus(this._chatUi.entry);
    }
};
