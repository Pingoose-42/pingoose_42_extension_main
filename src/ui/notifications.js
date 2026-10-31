const { Clutter, Gio, GLib, Pango, St } = imports.gi;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const PopupMenu = imports.ui.popupMenu;

var Controller = class Controller {
    constructor(indicator, bridge, settings, options = {}) {
        this._indicator = indicator;
        this._bridge = bridge;
        this._settings = settings;
        this._notificationSettings =
            options.notificationSettings ||
            new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });
        this._syncOptionalSectionsCallback = options.onVisibilitySync || null;
        this._updatePanelLabelCallback = options.onUpdatePanelLabel || null;
        this._restoreTests = options.restoreTests || (() => {});
        this._isResetting = options.isResetting || (() => false);
        this._getEvaluationsCallback = options.getEvaluations || (() => []);

        this._notifications = [];
        this._unreadIds = new Set();
        this._receivedNotificationIds = new Set();
        this._bannerSource = null;
        this._cardArchiveFailed = false;

        const ScreenFlash =
            imports.misc.extensionUtils.getCurrentExtension().imports.ui.screenFlash.Controller;
        this._flash = new ScreenFlash(indicator, settings, this._notificationSettings);

        if (this._bridge) {
            this._unsubNotification = this._bridge.on('notification', (msg) =>
                this.onNotificationMessage(msg)
            );
        }
    }

    get notifications() {
        return this._notifications;
    }
    get unreadIds() {
        return this._unreadIds;
    }

    markRead() {
        this._unreadIds.clear();
        for (const notification of this._notifications) notification.unread = false;
        this._saveCardState();
        this._updatePanelLabelCallback?.();
    }

    resetPresentation() {
        this._bannerSource?.destroy();
        this._bannerSource = null;
        this._clearFlash();
        this._cardArchiveFailed = false;
    }

    clear() {
        this._notifications = [];
        this._unreadIds = new Set();
        this._receivedNotificationIds = new Set();
        this._renderCards();
    }

    onNotificationMessage(message) {
        if (
            !message ||
            message.type !== 'notification' ||
            typeof message.body !== 'string' ||
            !message.body.trim() ||
            message.body.length > 1000 ||
            typeof message.id !== 'string' ||
            message.id.length > 1200
        )
            return;
        const existing = this._notifications.find((item) => item.id === message.id);
        if (message.update === true && existing) {
            if (existing.body !== message.body) {
                existing.body = message.body;
                this._saveCardState();
                this._renderCards();
            }
            return;
        }
        this._receivedNotificationIds ||= new Set();
        if (
            this._receivedNotificationIds.has(message.id) ||
            this._notifications.some((item) => item.id === message.id)
        )
            return;
        this._receivedNotificationIds.add(message.id);
        if (this._receivedNotificationIds.size > 2000) {
            this._receivedNotificationIds.delete(
                this._receivedNotificationIds.values().next().value
            );
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
            time: GLib.DateTime.new_now_local().format('%H:%M'),
        });
        this._saveCardState();
        this._renderCards();
        if (
            imports.misc.extensionUtils
                .getCurrentExtension()
                .imports.models.startReminders.immediateAllowed(message, this._settings) &&
            message.category !== 'update' &&
            (message.test ||
                this._settings?.get_boolean(
                    message.category === 'agenda' ? 'notify-agenda' : 'notify-evaluations'
                ))
        ) {
            this._showBanner(message);
            this._flashScreen();
        }
    }

    saveCardState() {
        this._saveCardState();
    }

    _saveCardState() {
        if (this._isResetting?.() || this._cardArchiveFailed) return;
        try {
            const store =
                imports.misc.extensionUtils.getCurrentExtension().imports.services.cardStore;
            if (this._indicator?.loginOnly) {
                const updates = this._notifications.filter((row) => row.category === 'update');
                if (!updates.length) return;
                const old = store.read() || { notifications: [], received: [], tests: [] };
                const ids = new Set(updates.map((row) => row.id));
                store.write({
                    ...old,
                    notifications: [
                        ...updates,
                        ...old.notifications.filter((row) => !ids.has(row.id)),
                    ],
                    received: [...new Set([...old.received, ...ids])],
                });
                return;
            }
            const evals = this._getEvaluationsCallback();
            store.write({
                notifications: this._notifications,
                received: [...(this._receivedNotificationIds || [])],
                tests: evals.filter((row) => row.devTest),
            });
        } catch (error) {
            logError(error, 'Unable to save Pingoose cards');
        }
    }

    restoreCardState() {
        this._restoreCardState();
    }

    _restoreCardState() {
        try {
            const data = imports.misc.extensionUtils
                .getCurrentExtension()
                .imports.services.cardStore.read();
            if (!data) return;
            this._notifications = data.notifications;
            this._receivedNotificationIds = new Set(data.received);
            this._unreadIds = new Set(
                data.notifications.filter((row) => row.unread).map((row) => row.id)
            );
            this._restoreTests(data.tests);
        } catch (error) {
            this._cardArchiveFailed = true;
            logError(error, 'Unable to restore Pingoose cards');
        }
    }

    _agendaFeedbackAction(message) {
        const match = /^agenda-feedback:(.+)$/.exec(message.id || '');
        if (message.category !== 'agenda' || !match) return null;
        const url = imports.misc.extensionUtils
            .getCurrentExtension()
            .imports.models.agenda.agendaFeedbackUrl(match[1]);
        if (!url) return null;
        return () => {
            this._indicator?.menu.close();
            const ext = imports.misc.extensionUtils.getCurrentExtension();
            const LinkOpener = ext.imports.services?.linkOpener;
            if (LinkOpener) {
                LinkOpener.openLink(this._settings, this._bridge, {
                    name: 'Agenda feedback',
                    url,
                });
            } else {
                this._bridge.send(
                    'service:open:' +
                        JSON.stringify({
                            name: 'Agenda feedback',
                            url,
                        })
                );
            }
        };
    }

    _showBanner(message) {
        if (!this._bannerSource) {
            this._bannerSource = new MessageTray.Source(
                'Pingoose',
                'preferences-system-notifications-symbolic'
            );
            this._bannerSource.connect('destroy', () => {
                this._bannerSource = null;
            });
            Main.messageTray.add(this._bannerSource);
        }
        const title =
            message.title ||
            (message.test
                ? 'Test notification'
                : message.category === 'agenda'
                  ? 'New Agenda Event'
                  : message.id.startsWith('missing:')
                    ? 'Evaluation missing'
                    : message.id.startsWith('reminder:')
                      ? 'Evaluation reminder'
                      : message.id.startsWith('seat:')
                        ? 'Evaluation location'
                        : message.id.startsWith('rescheduled:')
                          ? 'Evaluation rescheduled'
                          : 'New Evaluation Matched');
        const body = message.body
            .replace(/^You have been matched with someone\.\s*/i, '')
            .replace(/^New agenda event\s*·\s*/i, '')
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
            .trim()
            .slice(0, 350);
        const banner = new MessageTray.Notification(this._bannerSource, title, body);
        banner.pingooseBanner = true;
        banner.setTransient(true);
        const feedback = this._agendaFeedbackAction(message);
        if (feedback) banner.addAction('Write Feedback', feedback);
        banner.connect('activated', feedback || (() => this._indicator?.menu.open()));
        this._bannerSource.showNotification(banner);
    }

    previewFlash() {
        this._flash.previewFlash();
    }

    _flashScreen() {
        this._flash.show();
    }

    _clearFlash() {
        this._flash.clearFlash();
    }

    renderCards() {
        this._renderCards();
    }

    _renderCards() {
        this._syncOptionalSectionsCallback?.();

        const indicator = this._indicator;
        if (!indicator) return;

        indicator.cards.removeAll();
        indicator.count.text = indicator.loginOnly
            ? 'Login Required'
            : indicator.profileReady
              ? '42'
              : '◌';

        this._updatePanelLabelCallback?.();

        if (!this._notifications.length) return;
        for (const notification of this._notifications) {
            this._renderNotificationCard(notification, indicator);
        }
        const footer = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        footer.remove_all_children();
        footer.set_style('padding: 6px 16px 6px 0; spacing: 0;');
        const clear = new St.Button({
            label: 'Clear All',
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            style_class: 'pingoose-clear-button',
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
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        item.remove_all_children();
        item.add_style_class_name('pingoose-card-row');
        const card = new St.BoxLayout({
            vertical: true,
            reactive: true,
            x_expand: false,
            x_align: Clutter.ActorAlign.CENTER,
            style_class: 'pingoose-card',
        });
        const dismiss = new St.Button({
            label: '×',
            accessible_name: 'Dismiss notification',
            can_focus: true,
            style_class: 'pingoose-dismiss',
            y_align: Clutter.ActorAlign.CENTER,
        });
        dismiss.connect('clicked', () => {
            this._unreadIds?.delete(notification.id);
            this._notifications = this._notifications.filter(
                (entry) => entry.id !== notification.id
            );
            this._saveCardState?.();
            this._renderCards();
        });
        item.add_child(dismiss);
        card.add_child(
            new St.Label({
                text: notification.id?.startsWith('start:')
                    ? `42 · ${notification.id.startsWith('start:agenda:') ? 'Agenda starting soon' : 'Evaluation starting soon'}`
                    : notification.test
                      ? 'Test Notification'
                      : notification.category === 'update'
                        ? 'A new update was installed'
                        : notification.title
                          ? `42 · ${notification.title}`
                          : notification.category === 'agenda'
                            ? '42 · New Agenda Event'
                            : '42 · New Evaluation',
                style_class: 'pingoose-card-title',
            })
        );
        const body = new St.Label({ text: notification.body, style_class: 'pingoose-card-body' });
        body.clutter_text.line_wrap = true;
        body.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        body.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        card.add_child(body);
        const feedback = this._agendaFeedbackAction(notification);
        if (feedback) {
            const button = new St.Button({
                label: 'Write Feedback',
                can_focus: true,
                x_expand: true,
                style_class: 'pingoose-visit-intra',
            });
            button.connect('clicked', feedback);
            card.add_child(button);
        }
        card.add_child(
            new St.Label({
                text: `Received at ${notification.time}`,
                style_class: 'pingoose-card-time',
            })
        );
        item.add_child(card);
        indicator.cards.addMenuItem(item);
    }

    destroy() {
        this._flash.destroy();
        this._bannerSource?.destroy();
        this._bannerSource = null;
        this._unsubNotification?.();
        this._notifications = [];
        this._unreadIds?.clear();
    }
};

var NotificationManager = Controller;
