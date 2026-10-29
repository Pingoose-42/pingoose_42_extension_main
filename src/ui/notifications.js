const {Clutter, Gio, GLib, Pango, St} = imports.gi;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const PopupMenu = imports.ui.popupMenu;

var Controller = class Controller {
    initManager(indicator, bridge, settings, options = {}) {
        this._indicator = indicator;
        this._bridge = bridge;
        this._settings = settings;
        this._notificationSettings = options.notificationSettings || new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._syncOptionalSectionsCallback = options.onVisibilitySync || null;
        this._updatePanelLabelCallback = options.onUpdatePanelLabel || null;
        this._getEvaluationsCallback = options.getEvaluations || (() => []);

        this._notifications = [];
        this._unreadIds = new Set();
        this._receivedNotificationIds = new Set();
        this._flashActors = [];
        this._flashTimer = 0;
        this._lastFlash = -Infinity;
        this._bannerSource = null;
        this._cardArchiveFailed = false;

        if (this._settings) {
            this._settingsFlashSignal = this._settings.connect('changed::flash-count', () => this._clearFlash());
        }

        if (this._bridge) {
            this._unsubNotification = this._bridge.on('notification', msg => this.onNotificationMessage(msg));
            this._unsubSignOut = this._bridge.on('signed-out', () => this.clear());
        }
    }

    get notifications() { return this._notifications; }
    get unreadIds() { return this._unreadIds; }

    clear() {
        this._notifications = [];
        this._unreadIds = new Set();
        this._receivedNotificationIds = new Set();
        this._renderCards();
    }

    onNotificationMessage(message) {
        if (!message || message.type !== 'notification' || typeof message.body !== 'string' ||
            !message.body.trim() || message.body.length > 1000 ||
            typeof message.id !== 'string' || message.id.length > 1200)
            return;
        const existing = this._notifications.find(item => item.id === message.id);
        if (message.update === true && existing) {
            if (existing.body !== message.body) {
                existing.body = message.body;
                this._saveCardState();
                this._renderCards();
            }
            return;
        }
        this._receivedNotificationIds ||= new Set();
        if (this._receivedNotificationIds.has(message.id) || this._notifications.some(item => item.id === message.id))
            return;
        this._receivedNotificationIds.add(message.id);
        if (this._receivedNotificationIds.size > 2000) {
            this._receivedNotificationIds.delete(this._receivedNotificationIds.values().next().value);
        }
        this._unreadIds ||= new Set();
        if (!this._indicator?.menu.isOpen) this._unreadIds.add(message.id);
        this._notifications.unshift({
            id: message.id,
            title: typeof message.title === 'string' ? message.title : null,
            body: message.body,
            test: message.test === true,
            category: message.category,
            unread: !this._indicator?.menu.isOpen,
            time: GLib.DateTime.new_now_local().format('%H:%M')
        });
        this._saveCardState();
        this._renderCards();
        if (imports.misc.extensionUtils.getCurrentExtension().imports.models.startReminders.immediateAllowed(message, this._settings) && message.category !== 'update' && (message.test || this._settings?.get_boolean(message.category === 'agenda' ? 'notify-agenda' : 'notify-evaluations'))) {
            this._showBanner(message);
            this._flashScreen();
        }
    }

    saveCardState() { this._saveCardState(); }

    _saveCardState() {
        if (this._resetting || this._cardArchiveFailed) return;
        try {
            const store = imports.misc.extensionUtils.getCurrentExtension().imports.services.cardStore;
            if (this._indicator?.loginOnly) {
                const updates = this._notifications.filter(row => row.category === 'update');
                if (!updates.length) return;
                const old = store.read() || {notifications: [], received: [], tests: []};
                const ids = new Set(updates.map(row => row.id));
                store.write({
                    ...old,
                    notifications: [...updates, ...old.notifications.filter(row => !ids.has(row.id))],
                    received: [...new Set([...old.received, ...ids])]
                });
                return;
            }
            const evals = this._getEvaluationsCallback ? this._getEvaluationsCallback() : (this._evaluations || []);
            store.write({
                notifications: this._notifications,
                received: [...(this._receivedNotificationIds || [])],
                tests: evals.filter(row => row.devTest),
            });
        } catch (error) {
            logError(error, 'Unable to save Pingoose cards');
        }
    }

    restoreCardState() { this._restoreCardState(); }

    _restoreCardState() {
        try {
            const data = imports.misc.extensionUtils.getCurrentExtension().imports.services.cardStore.read();
            if (!data) return;
            this._notifications = data.notifications;
            this._receivedNotificationIds = new Set(data.received);
            this._unreadIds = new Set(data.notifications.filter(row => row.unread).map(row => row.id));
            if (this._evaluations) {
                this._evaluations = [...(this._evaluations || []).filter(row => !row.devTest), ...data.tests];
            }
        } catch (error) {
            this._cardArchiveFailed = true;
            logError(error, 'Unable to restore Pingoose cards');
        }
    }

    _showBanner(message) {
        if (!this._bannerSource) {
            this._bannerSource = new MessageTray.Source('Pingoose', 'preferences-system-notifications-symbolic');
            this._bannerSource.connect('destroy', () => { this._bannerSource = null; });
            Main.messageTray.add(this._bannerSource);
        }
        const title = message.title || (message.test ? 'Test notification' : message.category === 'agenda' ? 'New Agenda Event' :
            message.id.startsWith('missing:') ? 'Evaluation missing' :
            message.id.startsWith('reminder:') ? 'Evaluation reminder' :
            message.id.startsWith('seat:') ? 'Evaluation location' :
            message.id.startsWith('rescheduled:') ? 'Evaluation rescheduled' : 'New Evaluation Matched');
        const body = message.body
            .replace(/^You have been matched with someone\.\s*/i, '')
            .replace(/^New agenda event\s*·\s*/i, '')
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
            .trim().slice(0, 350);
        const banner = new MessageTray.Notification(this._bannerSource, title, body);
        banner.pingooseBanner = true;
        banner.setTransient(true);
        banner.connect('activated', () => this._indicator?.menu.open());
        this._bannerSource.showNotification(banner);
    }

    _flashScreen(remaining = null) {
        if (!this._indicator || this._flashActors.length || this._flashTimer || Main.sessionMode.isLocked ||
            !St.Settings.get().enable_animations ||
            !(this._notificationSettings?.get_boolean('show-banners') ?? true))
            return;
        const count = remaining === null ? (this._settings?.get_int('flash-count') || 0) : remaining;
        if (count === 0) return;
        const now = GLib.get_monotonic_time();
        if (now - this._lastFlash < 1_000_000) return;
        this._lastFlash = now;
        this._flashActors = Main.layoutManager.monitors.map(monitor => new St.Widget({
            style_class: 'pingoose-flash', reactive: false, can_focus: false,
            visible: true, opacity: 0,
            x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
        }));
        for (const frame of this._flashActors) {
            Main.uiGroup.add_child(frame);
            frame.ease({
                opacity: 160, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => frame.ease({
                    opacity: 0, duration: 380, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        this._flashActors = this._flashActors.filter(actor => actor !== frame);
                        frame.destroy();
                        if (!this._flashActors.length && count > 1) {
                            const delay = Math.max(1, Math.ceil(
                                (1_000_000 - (GLib.get_monotonic_time() - this._lastFlash)) / 1000));
                            this._flashTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                                this._flashTimer = 0;
                                this._flashScreen(count - 1);
                                return GLib.SOURCE_REMOVE;
                            });
                        }
                    },
                }),
            });
        }
    }

    clearFlash() { this._clearFlash(); }

    _clearFlash() {
        if (this._flashTimer) {
            GLib.source_remove(this._flashTimer);
            this._flashTimer = 0;
        }
        const actors = this._flashActors || [];
        this._flashActors = [];
        for (const actor of actors) {
            actor.remove_all_transitions();
            actor.destroy();
        }
    }

    renderCards() { this._renderCards(); }

    _renderCards() {
        if (this._syncOptionalSectionsCallback) this._syncOptionalSectionsCallback();
        else if (typeof this._syncOptionalSections === 'function') this._syncOptionalSections();

        const indicator = this._indicator;
        if (!indicator) return;

        indicator.cards.removeAll();
        indicator.count.text = indicator.loginOnly ? 'Login Required' :
            (indicator.profileReady ? '42' : '◌');

        if (this._updatePanelLabelCallback) this._updatePanelLabelCallback();
        else if (typeof this._updatePanelLabel === 'function') this._updatePanelLabel();

        if (!this._notifications.length) return;
        for (const notification of this._notifications) {
            this._renderNotificationCard(notification, indicator);
        }
        const footer = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        footer.remove_all_children();
        footer.set_style('padding: 6px 16px 6px 0; spacing: 0;');
        const clear = new St.Button({
            label: 'Clear All', can_focus: true,
            x_expand: true, x_align: Clutter.ActorAlign.END, style_class: 'pingoose-clear-button'
        });
        clear.connect('clicked', () => {
            this._notifications = [];
            this._unreadIds = new Set();
            this._saveCardState?.();
            this._renderCards();
        });
        footer.add_child(clear);
        indicator.cards.addMenuItem(footer);
    }

    _renderNotificationCard(notification, indicator) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.remove_all_children();
        item.add_style_class_name('pingoose-card-row');
        const card = new St.BoxLayout({
            vertical: true, reactive: true, x_expand: false, x_align: Clutter.ActorAlign.CENTER,
            style_class: 'pingoose-card'
        });
        const dismiss = new St.Button({
            label: '×', accessible_name: 'Dismiss notification',
            can_focus: true, style_class: 'pingoose-dismiss', y_align: Clutter.ActorAlign.CENTER
        });
        dismiss.connect('clicked', () => {
            this._unreadIds?.delete(notification.id);
            this._notifications = this._notifications.filter(entry => entry.id !== notification.id);
            this._saveCardState?.();
            this._renderCards();
        });
        item.add_child(dismiss);
        card.add_child(new St.Label({
            text: notification.id?.startsWith('start:')
                ? `42 · ${notification.id.startsWith('start:agenda:') ? 'Agenda starting soon' : 'Evaluation starting soon'}`
                : notification.test ? 'Test Notification'
                : notification.category === 'update' ? 'A new update was installed'
                : notification.title ? `42 · ${notification.title}`
                : notification.category === 'agenda' ? '42 · New Agenda Event' : '42 · New Evaluation',
            style_class: 'pingoose-card-title'
        }));
        const body = new St.Label({text: notification.body, style_class: 'pingoose-card-body'});
        body.clutter_text.line_wrap = true;
        body.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        body.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        card.add_child(body);
        card.add_child(new St.Label({text: `Received at ${notification.time}`, style_class: 'pingoose-card-time'}));
        item.add_child(card);
        indicator.cards.addMenuItem(item);
    }

    destroy() {
        if (this._settingsFlashSignal && this._settings) {
            this._settings.disconnect(this._settingsFlashSignal);
            this._settingsFlashSignal = 0;
        }
        this._clearFlash();
        this._bannerSource?.destroy();
        this._bannerSource = null;
        this._unsubNotification?.();
        this._unsubSignOut?.();
        this._notifications = [];
        this._unreadIds?.clear();
    }
};

function NotificationManager(indicator, bridge, settings, options = {}) {
    this.initManager(indicator, bridge, settings, options);
}
NotificationManager.prototype = Object.create(Controller.prototype);
NotificationManager.prototype.constructor = NotificationManager;
