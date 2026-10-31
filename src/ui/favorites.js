const { Clutter, Gio, GLib, Meta, Pango, St } = imports.gi;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Flags = Me.imports.models.featureFlags;

var Panel = class Panel {
    constructor(chat) {
        this.chat = chat;
        this.settings = chat._settings;
        this.availableOnly = this.settings.get_boolean('chat-favorites-available-only');
        this.rows = [];
        try {
            this.rows = JSON.parse(this.settings.get_string('chat-favorites'))
                .filter(
                    (row) => /^[a-z0-9_-]{1,64}$/.test(row.login) && typeof row.name === 'string'
                )
                .slice(0, 50);
        } catch (_) {}
        this.seats = new Map(
            Me.imports.services.favoriteCache
                .read()
                .filter(([login]) => this.rows.some((row) => row.login === login))
        );
        this.removed = new Set();
        this.queue = [];
        this.expanded = false;
        this.root = new Me.imports.ui.panelContent.Panel({
            vertical: true,
            visible: false,
            reactive: true,
            style_class: 'pingoose-chat pingoose-chat-panel pingoose-favorites-panel',
        });
        const header = new St.BoxLayout({ style_class: 'pingoose-chat-header' });
        header.add_child(
            new St.Label({
                text: 'Favorites',
                x_expand: false,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'pingoose-heading',
            })
        );
        const add = (this.addToggle = this.button('+', () => {
            const open = !this.entryReveal.expanded;
            this.resetInput(false);
            this._setInputOpen(open);
            if (open) this.entry.grab_key_focus();
        }));
        add.accessible_name = 'Add favorite';
        const refresh = (this.refreshButton = new St.Button({
            can_focus: true,
            accessible_name: 'Refresh favorites',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'pingoose-chat-add',
        }));
        this.refreshIcon = new St.Icon({
            gicon: new Gio.FileIcon({
                file: Gio.File.new_for_path(Me.path + '/assets/refresh-symbolic.svg'),
            }),
            icon_size: 16,
        });
        this.refreshSpinner = Me.imports.ui.spinner.create(16);
        this.refreshSpinner.hide();
        const refreshContent = new St.BoxLayout({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        refreshContent.add_child(this.refreshIcon);
        refreshContent.add_child(this.refreshSpinner);
        refresh.set_child(refreshContent);
        refresh.connect('clicked', () => {
            this.feedback.text = '';
            this.refresh(true);
        });
        this.filterButton = this.button(
            this.availableOnly ? 'Filter: Available' : 'Filter: All',
            () => this.toggleFilter()
        );
        header.add_child(this.filterButton);
        header.add_child(refresh);
        header.add_child(new St.Widget({ x_expand: true }));
        header.add_child(add);
        header.add_child(
            this.button('×', () => {
                this.expanded = false;
                this.sync();
            })
        );
        this.root.add_child(header);
        this.entryRow = new St.BoxLayout({
            visible: false,
            style_class: 'pingoose-chat-input-row',
        });
        this.entry = new St.Entry({
            hint_text: 'Intra ID',
            can_focus: true,
            x_expand: true,
            style_class: 'pingoose-chat-entry',
        });
        this.entryRow.add_child(this.entry);
        this.addButton = this.button('Add', () => this.add());
        this.addButton.y_align = Clutter.ActorAlign.FILL;
        this.addButton.y_expand = true;
        const addContent = new St.BoxLayout({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.addLabel = new St.Label({ text: 'Add' });
        this.addSpinner = Me.imports.ui.spinner.create(16);
        this.addSpinner.hide();
        addContent.add_child(this.addLabel);
        addContent.add_child(this.addSpinner);
        this.addButton.set_child(addContent);
        this.entryRow.add_child(this.addButton);
        this.entry.clutter_text.connect('activate', () => this.add());
        this.entryReveal = new Me.imports.ui.reveal.Reveal(this.entryRow);
        this.root.add_child(this.entryReveal);
        this.feedback = new St.Label({ text: '', style_class: 'pingoose-chat-connect-error' });
        this.feedback.clutter_text.line_wrap = true;
        this.feedback.hide();
        this.feedback.connect('notify::text', () => {
            this.feedback.visible = !!this.feedback.text;
        });
        this.entry.clutter_text.connect('text-changed', () => {
            this.feedback.text = '';
        });
        this.root.add_child(this.feedback);
        const scroll = (this.scroll = new St.ScrollView({
            can_focus: true,
            y_expand: true,
            overlay_scrollbars: false,
            style_class: 'pingoose-favorites-scroll',
        }));
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this.list = new St.BoxLayout({ vertical: true, style_class: 'pingoose-favorites-list' });
        scroll.add_actor(this.list);
        this.root.add_child(scroll);
        chat._indicator.addPanel(this.root, { key: 'favorites-panel-height', scroll });
        this.render();
    }
    toggleFilter() {
        this.availableOnly = !this.availableOnly;
        this.settings.set_boolean('chat-favorites-available-only', this.availableOnly);
        this.filterButton.label = this.availableOnly ? 'Filter: Available' : 'Filter: All';
        this.scrollPosition = 0;
        this.render();
    }
    _setInputOpen(open) {
        this.entryReveal.setExpanded(open);
        this.addToggle.style_class = 'pingoose-chat-add' + (open ? ' pingoose-toggle-active' : '');
    }
    resetInput(close = true) {
        this.entry.text = '';
        this.feedback.text = '';
        if (close) this._setInputOpen(false);
    }
    allowed() {
        return (
            !this.chat._indicator.loginOnly && Flags.enabled(this.settings, 'hidden-cluster-chat')
        );
    }
    button(label, action) {
        const button = new St.Button({
            label,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: ['+', '×', '⋮'].includes(label)
                ? 'pingoose-chat-add'
                : 'pingoose-favorite-action',
        });
        button.connect('clicked', action);
        return button;
    }
    toggle() {
        if (!this.allowed()) return;
        this.expanded = !this.expanded;
        this.sync();
        if (this.expanded) this.refresh();
    }
    sync() {
        const allowed = this.allowed();
        if (!allowed) {
            this.clearClusterRequest();
            this.expanded = false;
            this.queue = [];
            this.pending = null;
            this.connectAfter = null;
            this.adding = null;
            this.setAddBusy(false);
            if (this.timeout) GLib.source_remove(this.timeout);
            this.timeout = 0;
        }
        this.syncRefresh();
        this.visible = allowed && this.expanded && this.chat._chatUi.visible;
        this.chat._indicator.setPanelVisible(this.root, this.visible);
        this.chat._chatUi.favorites.visible = allowed;
        this.chat._chatUi.favorites.style_class =
            'pingoose-chat-add' + (this.visible ? ' pingoose-toggle-active' : '');
        if (this.visible) this.chat._indicator.placePanelBefore(this.root, this.chat._chatUi.root);
        this.chat._indicator.syncPanelLayout?.();
    }
    setAddBusy(busy) {
        this.addButton.reactive = this.addButton.can_focus = !busy;
        this.addLabel.visible = !busy;
        this.addSpinner.visible = busy;
    }
    saveSeats() {
        try {
            Me.imports.services.favoriteCache.write(this.seats);
        } catch (error) {
            logError(error, 'Could not save favorite seat cache');
        }
    }
    save() {
        const adjustment = this.scroll?.get_vscroll_bar().get_adjustment();
        if (adjustment && this.scrollPosition == null) this.scrollPosition = adjustment.value;
        this.settings.set_string('chat-favorites', JSON.stringify(this.rows));
    }
    add() {
        if (!this.allowed() || this.adding) return;
        const login = this.entry.text.trim().toLowerCase().replace(/^@/, '');
        if (!/^[a-z0-9_-]{1,64}$/.test(login)) {
            this.feedback.text = 'Enter a valid Intra ID.';
            return;
        }
        if (this.rows.some((row) => row.login === login)) {
            this.feedback.text = 'This user is already in Favorites.';
            return;
        }
        if (this.rows.length >= 50) {
            this.feedback.text = 'You can save up to 50 favorites.';
            return;
        }
        this.removed.delete(login);
        this.adding = login;
        this.setAddBusy(true);
        this.feedback.text = '';
        this.queue.unshift({ login, add: true });
        this.next();
    }
    refresh(force = false) {
        if (!this.allowed() || this.clusterRequest || !this.rows.length) return;
        if (!force && Date.now() - (this.clusterUpdatedAt || 0) < 30000) return;
        this.clusterRequest = String(GLib.get_monotonic_time());
        this.clusterTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 25, () => {
            this.clusterTimeout = 0;
            this.completeClusters({
                request: this.clusterRequest,
                error: 'Could not refresh seats. Please try again.',
            });
            return GLib.SOURCE_REMOVE;
        });
        this.chat._send('favorites:clusters:' + JSON.stringify({ request: this.clusterRequest }));
        this.syncRefresh();
    }
    completeClusters(message) {
        if (!this.clusterRequest || message.request !== this.clusterRequest) return;
        this.clusterRequest = null;
        if (this.clusterTimeout) GLib.source_remove(this.clusterTimeout);
        this.clusterTimeout = 0;
        if (this.allowed()) {
            if (message.error) this.feedback.text = message.error;
            else {
                this.clusterUpdatedAt = Date.now();
                for (const row of this.rows) {
                    const seat = message.seats?.[row.login];
                    // Meta scopes the complete snapshot to the signed-in user’s campus.
                    this.seats.set(row.login, {
                        seat: seat || null,
                        campus: message.campus,
                        at: Date.now(),
                    });
                }
                this.saveSeats();
                this.render();
            }
        }
        this.syncRefresh();
    }
    syncRefresh() {
        if (!this.refreshButton) return;
        const busy = !!this.clusterRequest || !!this.pending || this.queue.length > 0;
        this.refreshIcon.visible = !busy;
        this.refreshSpinner.visible = busy;
        this.refreshButton.reactive = this.refreshButton.can_focus = !busy;
        this.refreshButton.accessible_name = busy ? 'Refreshing favorites' : 'Refresh favorites';
    }
    next() {
        this.syncRefresh();
        if (!this.allowed() || this.pending || !this.queue.length) return;
        if (this.chat.connecting) {
            if (!this.retry)
                this.retry = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                    this.retry = 0;
                    this.next();
                    return GLib.SOURCE_REMOVE;
                });
            return;
        }
        const delay = (this.queue[0].notBefore || 0) - Date.now();
        if (delay > 0) {
            if (!this.retry)
                this.retry = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT,
                    Math.max(1, Math.ceil(delay / 1000)),
                    () => {
                        this.retry = 0;
                        this.next();
                        return GLib.SOURCE_REMOVE;
                    }
                );
            return;
        }
        const item = this.queue.shift();
        this.pending = { ...item, request: String(GLib.get_monotonic_time()) };
        this.timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
            this.timeout = 0;
            this.complete({ ...this.pending, error: 'Profile lookup timed out.' });
            return GLib.SOURCE_REMOVE;
        });
        const image = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_state_dir(), 'pingoose', 'favorite-' + item.login])
        );
        this.pending.avatarCached = !item.photoAttempt && image.query_exists(null);
        this.pending.stateOnly = !item.add && this.pending.avatarCached;
        this.chat._send('chat:lookup:' + JSON.stringify({ ...this.pending, favorite: true }));
    }
    complete(message) {
        if (
            !this.pending ||
            message.request !== this.pending.request ||
            message.login !== this.pending.login
        )
            return;
        const item = this.pending;
        this.pending = null;
        if (this.timeout) GLib.source_remove(this.timeout);
        this.timeout = 0;
        if (item.add) {
            this.adding = null;
            this.setAddBusy(false);
        }
        if (!this.allowed()) {
            this.queue = [];
            this.syncRefresh();
            return;
        }
        if (this.removed.has(item.login)) {
            this.next();
            return;
        }
        let photoSaved = !!item.avatarCached;
        if (!message.error && (message.profile?.name || (item.stateOnly && message.seatKnown))) {
            if (!item.stateOnly) {
                const row = { login: item.login, name: message.profile.name.slice(0, 100) };
                const index = this.rows.findIndex((value) => value.login === item.login);
                if (index >= 0) this.rows[index] = row;
                else if (item.add) this.rows.push(row);
            }
            if (message.seatKnown !== false) {
                this.seats.set(item.login, {
                    seat: message.seat || null,
                    campus: message.campus,
                    at: Date.now(),
                });
                this.saveSeats();
            }
            if (
                message.avatar &&
                message.avatar.length <= 2700000 &&
                this.rows.some((value) => value.login === item.login)
            ) {
                try {
                    const path = GLib.build_filenamev([GLib.get_user_state_dir(), 'pingoose']);
                    GLib.mkdir_with_parents(path, 0o700);
                    Gio.File.new_for_path(path + '/favorite-' + item.login).replace_contents(
                        GLib.base64_decode(message.avatar),
                        null,
                        false,
                        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
                        null
                    );
                    photoSaved = true;
                } catch (_) {
                    this.feedback.text = 'Could not save the profile photo.';
                }
            }
            this.save();
            if (item.add) {
                this.entry.text = '';
                this._setInputOpen(false);
                this.feedback.text = '';
            }
        } else {
            if (item.add)
                this.feedback.text =
                    message.error || 'User not found. Check the Intra ID and try again.';
        }
        // Missing/failed image reads get two fresh authenticated page loads.
        // Keep saved identity, seat and older photo while retrying; never revive a removed friend.
        if (!photoSaved && this.rows.some((row) => row.login === item.login)) {
            const attempt = item.photoAttempt || 0;
            if (attempt < 2) {
                this.queue.push({
                    login: item.login,
                    photoAttempt: attempt + 1,
                    notBefore: Date.now() + (attempt + 1) * 2000,
                });
            } else {
                this.feedback.text = `Could not refresh @${item.login}’s photo. Reopen Favorites to try again.`;
            }
        }
        this.render();
        if (this.connectAfter) {
            const row = this.connectAfter;
            this.connectAfter = null;
            this.connect(row);
        }
        this.next();
    }
    connect(row) {
        if (!this.allowed() || this.chat.connecting) return;
        this.connectingLogin = row.login;
        this.render();
        if (this.pending) {
            this.connectAfter = row;
            return;
        }
        // Re-resolve the seat before connecting, even if the cached status is available.
        if (!this.chat.connectUser(row.login)) this.finishConnect();
    }
    finishConnect() {
        if (!this.connectingLogin) return;
        this.connectingLogin = null;
        this.render();
    }
    render() {
        const adjustment = this.scroll?.get_vscroll_bar().get_adjustment();
        const position = this.scrollPosition ?? adjustment?.value ?? 0;
        if (this.scrollRestore) Meta.later_remove(this.scrollRestore);
        if (adjustment) {
            this.scrollPosition = position;
            let frames = 0;
            this.scrollRestore = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
                if (++frames < 2) return GLib.SOURCE_CONTINUE;
                this.scrollRestore = 0;
                adjustment.value = Math.max(
                    adjustment.lower,
                    Math.min(position, adjustment.upper - adjustment.page_size)
                );
                this.scrollPosition = null;
                return GLib.SOURCE_REMOVE;
            });
        }
        const focus = global.stage.get_key_focus();
        if (focus && this.list.contains(focus)) global.stage.set_key_focus(this.scroll);
        this.list.destroy_all_children();
        const visibleRows = this.rows.filter(
            (row) => !this.availableOnly || !!this.seats.get(row.login)?.seat
        );
        if (!visibleRows.length)
            this.list.add_child(
                new St.Label({
                    text: this.rows.length ? 'No available favorites.' : 'No favorites yet.',
                    style_class: 'pingoose-profile-login',
                })
            );
        this.rows.forEach((row, index) => {
            if (this.availableOnly && !this.seats.get(row.login)?.seat) return;
            const card = new St.BoxLayout({
                vertical: true,
                style_class: 'pingoose-profile pingoose-favorite-card',
            });
            const identity = new St.BoxLayout({ style_class: 'pingoose-identity' });
            const avatar = new St.Bin({
                width: 52,
                height: 52,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'pingoose-avatar pingoose-favorite-avatar',
            });
            const file = Gio.File.new_for_path(
                GLib.build_filenamev([
                    GLib.get_user_state_dir(),
                    'pingoose',
                    'favorite-' + row.login,
                ])
            );
            if (file.query_exists(null)) {
                avatar.set_child(null);
                avatar.set_style(
                    `background-image: url("${file.get_uri()}"); background-size: cover;`
                );
            } else
                avatar.set_child(
                    new St.Icon({ icon_name: 'avatar-default-symbolic', icon_size: 32 })
                );
            identity.add_child(avatar);
            const names = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'pingoose-favorite-names',
            });
            const top = new St.BoxLayout({
                x_expand: true,
                style_class: 'pingoose-favorite-name-row',
            });
            const name = new St.Label({
                text: row.name,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'pingoose-profile-name',
            });
            name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            top.add_child(name);
            names.add_child(top);
            identity.add_child(names);
            const actions = new St.BoxLayout({
                visible: false,
                style_class: 'pingoose-chat-input-row',
            });
            const actionsReveal = new Me.imports.ui.reveal.Reveal(actions);
            actionsReveal.connect('notify::progress', () => {
                if (actionsReveal.progress === 1 && index === this.rows.length - 1)
                    this.revealBottom();
            });
            const options = this.button('⋮', () => {
                actionsReveal.setExpanded(!actionsReveal.expanded);
            });
            options.visible = options.reactive = options.can_focus = !this.availableOnly;
            options.accessible_name = 'Favorite options';
            options.style_class = 'pingoose-note-options';
            options.y_align = Clutter.ActorAlign.CENTER;
            identity.add_child(options);
            card.add_child(identity);
            const stats = new St.BoxLayout({ style_class: 'pingoose-favorite-status-row' });
            stats.add_child(
                new St.Label({
                    text: '@' + row.login,
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: 'pingoose-profile-login',
                })
            );
            const state = this.seats.get(row.login);
            const available = !!state?.seat;
            stats.add_child(
                new St.Label({
                    text: available ? `Available (${state.seat})` : 'Unavailable',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: available
                        ? 'pingoose-profile-level'
                        : 'pingoose-favorite-unavailable',
                })
            );
            names.add_child(stats);
            const connect = this.button('Connect', () => this.connect(row));
            const busy = this.connectingLogin === row.login;
            // Keep the label's allocation while the spinner replaces it visually.
            const connectContent = new St.Widget({ layout_manager: new Clutter.BinLayout() });
            const connectLabel = new St.Label({
                text: 'Connect',
                opacity: busy ? 0 : 255,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            connectContent.add_child(connectLabel);
            if (busy) {
                const spinner = Me.imports.ui.spinner.create(14);
                spinner.x_align = spinner.y_align = Clutter.ActorAlign.CENTER;
                connectContent.add_child(spinner);
            }
            connect.set_child(connectContent);
            if (available) connect.add_style_class_name('pingoose-toggle-active');
            connect.reactive = connect.can_focus = available && !busy;
            connect.opacity = available ? 255 : 100;
            connect.y_align = Clutter.ActorAlign.CENTER;
            top.add_child(connect);
            for (const [label, offset] of [
                ['Move up', -1],
                ['Move down', 1],
            ]) {
                const move = this.button(label, () => {
                    const target = index + offset;
                    if (target < 0 || target >= this.rows.length) return;
                    [this.rows[index], this.rows[target]] = [this.rows[target], this.rows[index]];
                    this.save();
                    this.render();
                });
                move.reactive = move.can_focus =
                    index + offset >= 0 && index + offset < this.rows.length;
                actions.add_child(move);
            }
            actions.add_child(this.button('Remove', () => this.confirmRemove(actions, row.login)));
            card.add_child(actionsReveal);
            this.list.add_child(card);
        });
    }
    revealBottom() {
        if (this.scrollRestore) Meta.later_remove(this.scrollRestore);
        this.scrollPosition = null;
        let frames = 0;
        this.scrollRestore = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
            if (++frames < 2) return GLib.SOURCE_CONTINUE;
            this.scrollRestore = 0;
            const adjustment = this.scroll.get_vscroll_bar().get_adjustment();
            adjustment.value = Math.max(adjustment.lower, adjustment.upper - adjustment.page_size);
            return GLib.SOURCE_REMOVE;
        });
    }
    confirmRemove(actions, login) {
        actions.destroy_all_children();
        actions.add_child(
            new St.Label({
                text: 'Remove favorite?',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            })
        );
        actions.add_child(this.button('Yes', () => this.remove(login)));
        actions.add_child(this.button('No', () => this.render()));
    }
    remove(login) {
        const file = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_state_dir(), 'pingoose', 'favorite-' + login])
        );
        try {
            if (file.query_exists(null)) file.delete(null);
        } catch (_) {
            this.feedback.text = 'Could not delete the cached photo. Please try again.';
            return;
        }
        this.removed.add(login);
        if (this.connectAfter?.login === login) this.connectAfter = null;
        if (this.connectingLogin === login) this.connectingLogin = null;
        this.rows = this.rows.filter((row) => row.login !== login);
        this.queue = this.queue.filter((row) => row.login !== login || row.add);
        this.seats.delete(login);
        this.saveSeats();
        this.save();
        this.render();
    }
    clearClusterRequest() {
        if (this.clusterTimeout) GLib.source_remove(this.clusterTimeout);
        this.clusterTimeout = 0;
        this.clusterRequest = null;
        this.clusterUpdatedAt = 0;
    }
    reset() {
        this.clearClusterRequest();
        this.connectingLogin = null;
        this.expanded = false;
        this.pending = null;
        this.queue = [];
        this.seats.clear();
        this.saveSeats();
        this.connectAfter = null;
        this.adding = null;
        if (this.timeout) GLib.source_remove(this.timeout);
        this.timeout = 0;
        this.setAddBusy(false);
        this.entry.text = '';
        this._setInputOpen(false);
        this.feedback.text = '';
        this.syncRefresh();
        this.visible = false;
        this.chat._indicator.setPanelVisible(this.root, false);
        this.render();
    }
    destroy() {
        this.clearClusterRequest();
        if (this.scrollRestore) Meta.later_remove(this.scrollRestore);
        if (this.retry) GLib.source_remove(this.retry);
        if (this.timeout) GLib.source_remove(this.timeout);
        this.pending = null;
        this.root.destroy();
    }
};
