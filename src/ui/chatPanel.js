const CountLabel = imports.misc.extensionUtils.getCurrentExtension().imports.ui.countLabel;
// Chat UI adapted from origin/deeeev-gangjeon; displayed beside the main menu.
const {Clutter, Gio, GLib, Pango, St} = imports.gi;
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
    constructor(indicator,send) {
        this._send=send;
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
        const blocked=this._settings.get_strv('blocked-chat-seats');
        if(JSON.stringify(blocked)!==JSON.stringify(this._blocked)){
            this._blocked=blocked;this._chat.setBlocked(blocked);
        }
        const active=!this._indicator.loginOnly;
        const general=Flags.enabled(this._settings,'hidden-cluster-chat');
        const selected=this._chat.peer(this._chatActive);
        if(selected?.scope && selected.scope!=='general')this._selectedEvaluation=selected.scope;
        if(!this._sessions?.some(session=>session.id===this._selectedEvaluation && session.expires>Date.now()))this._selectedEvaluation=null;
        this._chat.configure({active,general,login:GLib.get_user_name(),grants:this._grants || [],sessions:this._sessions || []});
        const moved=this._selectedEvaluation && this._chat.peers.find(peer=>peer.scope===this._selectedEvaluation);
        if(moved && moved.key!==this._chatActive){
            this._chatActive=moved.key;this._renderChat();
        }
        if(active && this._chat.state==='stopped')this._chat.start();
        this._chatUi.item.visible=active && general && this._settings.get_boolean('show-chat');
        this._chatUi.add.visible=general;
        if(!general)this._chatUi.peerRow.hide();
        if(this._chatActive && !this._chat.peer(this._chatActive)){
            this._chatActive=null;this._chatUi.entry.text='';this._renderChat();
            this._chatBannerSource?.destroy();this._chatBannerSource=null;
            this._updatePanelLabel();
            if(!general && !this._selectedEvaluation)this._expanded=false;
        }
        this._chatUi.root.visible=active && this._expanded && (general || !!this._chatActive);
        this._updatePanelLabel();
        this._chatUi.toggle.style_class='pingoose-visit-intra'+(this._chatUi.root.visible ? ' pingoose-toggle-active' : '');
        if(this._settings.get_boolean('expand-chat')!==this._expanded)this._settings.set_boolean('expand-chat',this._expanded);
        this._favorites?.sync();
        this._indicator.syncPanelLayout?.();
        if (this._expanded && this._indicator.menu.isOpen && !this._indicator.loginOnly && this._chatActive)
            this._chat.markRead(this._chatActive);
    }
    updateEvaluations(rows) {
        this._sessions=rows.filter(row=>!row.missing && (!row.devTest || Flags.enabled(this._settings,'hidden-dev-options')))
            .flatMap(row=>(row.users || []).map(login=>({id:String(row.id),login,expires:Date.parse(row.begin)})))
            .filter(session=>session.expires>Date.now());
        this._grants=Policy.grantsFrom(rows.filter(row=>!row.devTest || Flags.enabled(this._settings,'hidden-dev-options')),Date.now(),GLib.get_user_name());
        const expired=this._chat.peers.some(peer=>peer.scope && peer.scope!=='general' &&
            !this._grants.some(grant=>grant.id===peer.scope && grant.seat===peer.key));
        this.sync();
        for (const grant of this._grants) this._chat.probe(grant);
        if(expired){this._chatBannerSource?.destroy();this._chatBannerSource=null;}
    }
    canEvaluation(row,login) {
        return (this._grants || []).find(grant=>grant.id===String(row.id) && grant.login===login && grant.expires>Date.now() && this._chat.available(grant));
    }
    openEvaluation(row,login) {
        const grant=this.canEvaluation(row,login);
        if(!grant || this._indicator.loginOnly)return;
        const key=this._chat.open(grant.seat,grant.id,false,login);
        if(!key)return;
        this._chatUi.peerEntry.text=grant.seat;
        this._expanded=true;
        this._indicator.bringPanelNearMain(this._chatUi.root);
        this._selectChat(key);this.sync();
    }
    completeLookup(message){
        if (message.favorite) { this._favorites?.complete(message); return; }
        if(!this._lookup || message.request!==this._lookup.request || message.login!==this._lookup.login)return;
        this._lookup=null;
        const ui=this._chatUi;
        if(this._indicator.loginOnly || !Flags.enabled(this._settings,'hidden-cluster-chat')){this._setConnectBusy(false);return;}
        if (message.error) { this._connectionError(message.error); return; }
        if (!Chat.SEAT.test(message.seat || '')) {
            this._connectionError('Could not find this user’s seat. Check the Intra ID and whether they are logged in to a cluster.');
            return;
        }
        this._connectPeer(message.seat, message.login);
    }
    _resetPeerInput() {
        const ui = this._chatUi;
        ui.peerEntry.text = '';
        ui.peerEntry.remove_style_class_name('pingoose-chat-entry-error');
        ui.peerFeedback.text = '';
        ui.peerFeedback.hide();
        ui.peerRow.hide();
    }
    _setConnectBusy(busy) {
        if (!busy) this._favorites?.finishConnect();
        const ui = this._chatUi;
        ui.connectSpinner.visible = busy;
        ui.connectLabel.visible = !busy;
        ui.connect.reactive = ui.connect.can_focus = !busy;
        ui.add.reactive = !busy;
        ui.peerEntry.clutter_text.editable = !busy;
    }
    _connectionReady(key) {
        if (this._pendingConnection?.key !== key) return;
        this._pendingConnection = null;
        this._chat.showConnected(key);
        this._selectChat(key);
        this._setConnectBusy(false);
        this._chatUi.peerEntry.text = '';
        this._chatUi.peerFeedback.hide();
        this._chatUi.peerRow.hide();
    }
    _connectionError(text) {
        this._setConnectBusy(false);
        const ui = this._chatUi;
        ui.peerRow.show();
        ui.peerEntry.add_style_class_name('pingoose-chat-entry-error');
        ui.peerFeedback.text = text;
        ui.peerFeedback.show();
    }
    _connectPeer(seat, login = null) {
        if (this._chat.isBlocked(seat) || (login && this._blocked.includes('@' + login))) {
            this._connectionError('Connection blocked by your blacklist.');
            return;
        }
        const key = this._chat.open(seat, 'general', true, login);
        if (!key) {
            this._connectionError('Could not start a connection. Check your chat settings and connection limit.');
            return;
        }
        this._pendingConnection = {key, input: this._chatUi.peerEntry.text};
        this._chatUi.peerFeedback.hide();
        this._setConnectBusy(true);
        if (this._chat.isConnected(key)) this._connectionReady(key);
    }
    _updatePanelLabel() {
        const count = this._chat.unread;
        CountLabel.update(this._chatUi.toggle.get_child(), 'Cluster Chat', count > 5 ? '5+' : count, this._chatUi.root.visible);
    }
    reset() {
        this._favorites?.reset();
        this._chatBannerSource?.destroy();
        this._chatBannerSource = null;
        this._expanded = false;
        this._lookup=null;
        this._pendingConnection=null;
        this._setConnectBusy(false);
        this._chatUi.peerFeedback?.hide();
        this._grants=[];this._sessions=[];this._selectedEvaluation=null;
        this._chatUi.entry.text = '';
        this._chatUi.peerEntry.text = '';
        this._chatUi.peerEntry.remove_style_class_name('pingoose-chat-entry-error');
        this._chatUi.peerRow.hide();
        this._chat.destroy();
        this._chat = new Chat.ChatService(Chat.PORT, this._blocked);
        this._bindChatSignals();
        this._chatActive = null;
        this._renderChatStatus();
        this._renderChat();
        this._updatePanelLabel();
        this.sync();
    }
    destroy() {
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
        const ui = this._chatUi = {stick: true};
        const root = new St.BoxLayout({vertical: true, reactive: true, visible: false,
            y_expand: false, request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH, y_align: Clutter.ActorAlign.START, style_class: 'pingoose-chat pingoose-chat-panel'});
        ui.root = root;
        // Share the popup grab so interacting with chat does not close the main menu.
        const bin = indicator.menu._boxPointer.bin;
        const main = indicator.menu.box;
        // Painted panel gaps must retain pointer events inside the popup.
        main.reactive = true;
        // Each column keeps its natural height instead of stretching to the tallest panel.
        main.request_mode = Clutter.RequestMode.HEIGHT_FOR_WIDTH;
        main.x_expand = false;
        main.y_expand = false;
        main.y_align = Clutter.ActorAlign.START;
        bin.remove_child(main);
        indicator.menu.actor.add_style_class_name('pingoose-panel-host');
        main.add_style_class_name('pingoose-main-panel');
        const columns = new St.BoxLayout({request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
            style_class: 'pingoose-chat-columns'});
        columns.add_child(root);
        columns.add_child(main);
        bin.set_child(columns);
        indicator.sideColumns = columns;
        // Avoid the shared popup outline sliding past independently sized panels on close.
        const closeMenu = indicator.menu.close.bind(indicator.menu);
        indicator.menu.close = () => closeMenu(imports.ui.boxpointer.PopupAnimation.NONE);
        // Main stays last; moving a panel immediately before it preserves the others' order.
        indicator.bringPanelNearMain = panel => { columns.set_child_below_sibling(panel, main); indicator.syncPanelLayout?.(); };
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.remove_all_children();
        item.add_style_class_name('pingoose-overview-item');
        const toggle = new St.Button({label: 'Cluster Chat', can_focus: true, x_expand: true,
            style_class: 'pingoose-visit-intra'});
        ui.toggle = toggle;
        item.add_child(toggle);
        indicator.menu.addMenuItem(item);
        ui.item = item;
        toggle.connect('clicked', () => {
            this._expanded = !this._expanded;
            if (this._expanded) indicator.bringPanelNearMain(root);
            if (this._expanded && this._chat.state === 'stopped') this._chat.start();
            this.sync();
        });

        const header = new St.BoxLayout({style_class: 'pingoose-chat-header'});
        header.add_child(new St.Label({text: 'Cluster Chat', x_expand: true, y_align: center, style_class: 'pingoose-heading'}));
        // Clicking the status retries the listener when the port was taken.
        ui.status = new St.Button({can_focus: true, y_align: center, style_class: 'pingoose-chat-status'});
        ui.status.connect('clicked', () => { if (this._chat.state !== 'listening') this._chat.start(); });
        const dismiss = new St.Button({label: '×', can_focus: true,
            accessible_name: 'Close Cluster Chat', style_class: 'pingoose-dismiss'});
        dismiss.connect('clicked', () => { this._expanded = false; this.sync(); });
        header.add_child(dismiss);
        root.add_child(header);
        root.add_child(ui.status);

        const chipRow = new St.BoxLayout({style_class: 'pingoose-chat-chip-row'});
        const chipScroll = new St.ScrollView({x_expand: true, overlay_scrollbars: false, style_class: 'pingoose-chat-chip-scroll'});
        chipScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.NEVER);
        ui.chipScroll = chipScroll;
        ui.chipOverflow = false;
        chipScroll.connect('notify::allocation', () => this._syncChipOverflow());
        ui.chips = new St.BoxLayout({style_class: 'pingoose-chat-chips'});
        chipScroll.add_actor(ui.chips);
        chipRow.add_child(chipScroll);
        const add = ui.add = new St.Button({label: '+', can_focus: true, y_align: center,
            accessible_name: 'New chat', style_class: 'pingoose-chat-add'});
        chipRow.add_child(add);
        ui.favorites = new St.Button({label: '☆', accessible_name: 'Favorites', can_focus: true,
            y_align: center, visible: false, style_class: 'pingoose-chat-add'});
        ui.favorites.connect('clicked', () => this._favorites?.toggle());
        chipRow.add_child(ui.favorites);
        root.add_child(chipRow);

        ui.peerRow = new St.BoxLayout({visible: false, style_class: 'pingoose-chat-input-row'});
        ui.peerRow.connect('notify::visible', () => { ui.add.style_class = 'pingoose-chat-add' + (ui.peerRow.visible ? ' pingoose-toggle-active' : ''); });
        ui.peerEntry = new St.Entry({hint_text: 'Seat number or Intra ID', can_focus: true,
            x_expand: true, style_class: 'pingoose-chat-entry'});
        const connect = ui.connect = new St.Button({can_focus: true, accessible_name: 'Connect', style_class: 'pingoose-chat-send'});
        const connectContent = new St.BoxLayout({x_align: center, y_align: center});
        ui.connectLabel = new St.Label({text: 'Connect'});
        ui.connectSpinner = Me.imports.ui.spinner.create(16);
        ui.connectSpinner.hide();
        connectContent.add_child(ui.connectLabel);
        connectContent.add_child(ui.connectSpinner);
        connect.set_child(connectContent);
        ui.peerRow.add_child(ui.peerEntry);
        ui.peerRow.add_child(connect);
        root.add_child(ui.peerRow);
        ui.peerFeedback = wrapLabel(new St.Label({visible: false, x_expand: true, request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH, style_class: 'pingoose-chat-connect-error'}));
        root.add_child(ui.peerFeedback);
        const submitPeer = () => {
            if(!Flags.enabled(this._settings,'hidden-cluster-chat'))return;
            if (this._lookup || this._pendingConnection) return;
            this._pendingConnection = null;
            ui.peerFeedback.hide();
            ui.peerEntry.remove_style_class_name('pingoose-chat-entry-error');
            const seat = ui.peerEntry.text.trim().toLowerCase().replace(/^@/, '');
            if(!Chat.SEAT.test(seat) && /^[a-z0-9_-]{1,64}$/.test(seat)){
                const request=String(GLib.get_monotonic_time());
                this._lookup={request,login:seat};
                this._setConnectBusy(true);
                this._send?.('chat:lookup:'+JSON.stringify(this._lookup));
                return;
            }
            if (!Chat.SEAT.test(seat)) {
                this._connectionError('Enter a valid seat number or Intra ID.');
                return;
            }
            this._connectPeer(seat);
        };
        ui.peerEntry.clutter_text.connect('activate', submitPeer);
        ui.peerEntry.clutter_text.connect('text-changed', () => { ui.peerEntry.remove_style_class_name('pingoose-chat-entry-error'); ui.peerFeedback.hide(); });
        connect.connect('clicked', submitPeer);
        add.connect('clicked', () => {
            if (this._lookup || this._pendingConnection) return;
            const open = !ui.peerRow.visible;
            this._resetPeerInput();
            ui.peerRow.visible = open;
            if (ui.peerRow.visible) global.stage.set_key_focus(ui.peerEntry);
        });

        const scroll = new St.ScrollView({x_expand: true, overlay_scrollbars: false, style_class: 'pingoose-chat-scroll'});
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        ui.log = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'pingoose-chat-log'});
        scroll.add_actor(ui.log);
        root.add_child(scroll);
        // Follow new messages only while the view is already at the bottom.
        const adjustment = scroll.vscroll.adjustment;
        adjustment.connect('notify::value', () => {
            ui.stick = adjustment.value + adjustment.page_size >= adjustment.upper - 4;
        });
        adjustment.connect('changed', () => {
            if (ui.stick) adjustment.value = adjustment.upper - adjustment.page_size;
        });

        const inputRow = new St.BoxLayout({style_class: 'pingoose-chat-input-row'});
        ui.entry = new St.Entry({can_focus: true, x_expand: true, style_class: 'pingoose-chat-entry'});
        ui.entry.clutter_text.max_length = 1000;
        ui.entry.clutter_text.set_selectable(true);
        ui.entry.clutter_text.reactive = true;
        // Forward only padding clicks; glyph events already reach Clutter.Text.
        ui.entry.connect('button-press-event', (_actor, event) => {
            if (!ui.entry.reactive || event.get_button() !== 1 ||
                event.get_source() !== ui.entry)
                return Clutter.EVENT_PROPAGATE;
            ui.entry.clutter_text.grab_key_focus();
            ui.entry.clutter_text.event(event, false);
            return Clutter.EVENT_STOP;
        });
        ui.send = new St.Button({can_focus: true, accessible_name: 'Send', style_class: 'pingoose-chat-send'});
        ui.send.set_child(new St.Icon({
            gicon: new Gio.FileIcon({file: Gio.File.new_for_path(Me.path + '/assets/send-symbolic.svg')}),
            icon_size: 16,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        inputRow.add_child(ui.entry);
        inputRow.add_child(ui.send);
        root.add_child(inputRow);
        const submit = () => {
            if (!this._chatActive || !this._chat.send(this._chatActive, ui.entry.text)) return;
            ui.entry.text = '';
        };
        ui.entry.clutter_text.connect('activate', submit);
        ui.send.connect('clicked', submit);
        this._bindChatSignals();
        indicator.menu.connect('open-state-changed', (_menu, open) => {
            this._resetPeerInput();
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
        this._chat.connect('availability-changed', () => this.onAvailabilityChanged?.());
        this._chat.connect('connection-failed', (_chat, key, reason) => {
            if (this._pendingConnection?.key !== key) return;
            this._chatUi.peerEntry.text = this._pendingConnection.input;
            this._pendingConnection = null;
            if (this._chat.peer(key)?.background) this._chat.close(key);
            this._connectionError(reason);
        });
        this._chat.connect('connection-ready', (_chat, key) => this._connectionReady(key));
        this._chat.connect('server-state', () => this._renderChatStatus());
        this._chat.connect('peer-changed', () => { this._renderChatChips(); this._updatePanelLabel(); });
        this._chat.connect('message', (_chat, key, entry) => this._chatMessage(key, entry));
    }

    _renderChatStatus() {
        const ui = this._chatUi;
        if (!ui) return;
        const state = this._chat.state;
        const seat = GLib.get_host_name().split('.')[0];
        ui.status.label = state === 'listening' ? `● ${seat} · Ready`
            : state === 'port-busy' ? `● :${this._chat.port} in use · Retry` : 'Open a chat to connect';
        ui.status.style_class = `pingoose-chat-status pingoose-chat-status-${state === 'listening' ? 'ok' : 'err'}`;
    }

    _renderChatChips() {
        const ui = this._chatUi;
        if (!ui) return;
        const center = Clutter.ActorAlign.CENTER;
        ui.chips.destroy_all_children();
        for (const peer of this._chat.peers.filter(peer => !peer.background)) {
            const chip = new St.BoxLayout({style_class: peer.key === this._chatActive
                ? 'pingoose-chat-chip pingoose-chat-chip-active' : 'pingoose-chat-chip'});
            const pick = new St.Button({can_focus: true, style_class: 'pingoose-chat-chip-button'});
            const content = new St.BoxLayout({style_class: 'pingoose-chat-chip-content'});
            const dot = peer.connections.length ? 'on' : peer.connecting ? 'wait' : 'off';
            content.add_child(new St.Label({text: '●', y_align: center, style_class: `pingoose-chat-dot pingoose-chat-dot-${dot}`}));
            content.add_child(new St.Label({text: peer.login ? `${peer.login} (${peer.key})` : peer.key, y_align: center}));
            if (peer.unread) {
                content.add_child(new St.Label({text: peer.unread > 9 ? '9+' : String(peer.unread),
                    y_align: center, style_class: 'pingoose-chat-badge'}));
            }
            pick.set_child(content);
            pick.connect('clicked', () => this._selectChat(peer.key));
            const close = new St.Button({label: '×', can_focus: true, y_align: center,
                accessible_name: `Close chat with ${peer.key}`, style_class: 'pingoose-chat-chip-close'});
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
        const natural = children.reduce((sum, child) => sum + child.get_preferred_width(-1)[1], 0) +
            Math.max(0, children.length - 1) * spacing;
        const available = ui.chipScroll.get_theme_node().get_content_box(ui.chipScroll.get_allocation_box()).get_width();
        const overflow = natural > available + 1;
        if (overflow === ui.chipOverflow) return;
        ui.chipOverflow = overflow;
        ui.chipScroll.set_policy(overflow ? St.PolicyType.ALWAYS : St.PolicyType.NEVER, St.PolicyType.NEVER);
    }

    _renderChat() {
        const ui = this._chatUi;
        this._renderChatChips();
        ui.log.destroy_all_children();
        ui.placeholder = null;
        ui.stick = true;
        const peer = this._chatActive ? this._chat.peer(this._chatActive) : null;
        ui.entry.reactive = ui.send.reactive = !!peer;
        ui.entry.hint_text = peer ? `Message ${peer.key}…` : 'No connected chats.';
        if (!peer?.history.length) {
            ui.placeholder = wrapLabel(new St.Label({x_expand: true, style_class: 'pingoose-chat-empty',
                text: peer ? 'No messages yet.'
                    : 'No connected chats.'}));
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
            ui.log.add_child(wrapLabel(new St.Label({text: `${entry.text} · ${entry.time}`,
                x_align: Clutter.ActorAlign.CENTER, style_class: 'pingoose-chat-system'})));
            return;
        }
        const out = entry.dir === 'out';
        const align = out ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
        const bubble = new St.BoxLayout({vertical: true, x_expand: true, x_align: align,
            style_class: `pingoose-chat-bubble pingoose-chat-bubble-${out ? 'out' : 'in'}`});
        // Plain text only: peer input must never be parsed as Pango markup.
        const message = wrapLabel(new St.Label({text: entry.text, reactive: true,
            can_focus: true, style_class: 'pingoose-chat-text'}));
        Me.imports.ui.selectableText.attach(message);
        bubble.add_child(message);
        bubble.add_child(new St.Label({text: entry.time, x_align: align, style_class: 'pingoose-chat-time'}));
        ui.log.add_child(bubble);
    }

    _isViewingChat(key) {
        return this._indicator.menu.isOpen && !this._indicator.loginOnly &&
            this._expanded && this._chatUi.root.visible && this._chatUi.root.mapped &&
            this._chatActive === key;
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
            this._chatBannerSource = new MessageTray.Source('Cluster Chat', 'user-available-symbolic');
            this._chatBannerSource.connect('destroy', () => { this._chatBannerSource = null; });
            Main.messageTray.add(this._chatBannerSource);
        }
        const peer = this._chat.peer(key);
        const sender = peer?.login ? `${peer.login} (${peer.key || key})` : key;
        const banner = new MessageTray.Notification(this._chatBannerSource, `Cluster Chat · ${sender}`, text.slice(0, 200));
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
        this._chatActive = key;
        this._chat.markRead(key);
        this._renderChat();
        this._updatePanelLabel();
        global.stage.set_key_focus(this._chatUi.entry);
    }

};
