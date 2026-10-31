const { Clutter, Gio, GLib, St } = imports.gi;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Me = imports.misc.extensionUtils.getCurrentExtension();

var Controller = class Controller {
    constructor(indicator, bridge, settings, components) {
        this._indicator = indicator;
        this._bridge = bridge;
        this._settings = settings;
        this._slots = components.slots;
        this._agenda = components.agenda;
        this._evaluations = components.evaluations;
        this._notifications = components.notifications;
        this._chatPanel = components.chat;
        this._servicePanel = components.services;
        this._projectPanel = components.projects;
        this._visibility = components.visibility;
        this._layout = components.layout;
        this._reset = components.reset;
        this._maintenance = components.maintenance;
        this._optionsManager = components.optionsManager;
        this._unsubRefresh = bridge.on('refresh-state', (message) => {
            if (!this._refreshPending) return;
            this._refreshWorkerDone = message.state === 'complete';
            if (message.state === 'failed') this._finishRefresh(false);
            else this._checkRefreshDone();
        });
        this._buildSettings();
    }

    get pending() {
        return !!this._refreshPending;
    }

    slotsRefreshed(success, error) {
        if (!this._refreshPending) return;
        this._refreshSlotsDone = success;
        if (error) this._finishRefresh(false);
        else this._checkRefreshDone();
    }

    destroy() {
        this._settings.disconnect(this._themeChanged);
        this._indicator.menu.disconnect(this._openSignal);
        this._indicator.menu.disconnect(this._closedSignal);
        this._indicator.onLoginStateChanged = null;
        this._unsubRefresh();
        if (this._refreshTimer) GLib.source_remove(this._refreshTimer);
        this._refreshTimer = 0;
        this._optionsManager.removeMenu(this._optionsMenu);
        this._optionsMenu.destroy();
    }

    refreshAppearance() {
        this._applyTheme();
        this._layout.applyPanelLayout();
        this._visibility.sync();
    }

    _buildSettings() {
        const indicator = this._indicator;
        const toolbar = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        toolbar.remove_all_children();
        toolbar.add_style_class_name('pingoose-toolbar');
        indicator.menu.addMenuItem(toolbar, 0);
        indicator.toolbarItem = toolbar;

        const gear = new St.Button({
            style_class: 'pingoose-settings-button',
            can_focus: true,
            x_expand: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            accessible_name: 'More options',
        });
        gear.set_child(new St.Label({ text: '⋮', style_class: 'pingoose-more-icon' }));
        const toolbarSpace = new St.Widget({ x_expand: true });
        toolbar.add_child(toolbarSpace);
        const refreshStatus = new St.BoxLayout({
            style: 'spacing: 4px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._refreshSpinner = Me.imports.ui.spinner.create(18);
        this._refreshResult = new St.Icon({ icon_name: 'emblem-ok-symbolic', icon_size: 18 });
        refreshStatus.add_child(this._refreshSpinner);
        refreshStatus.add_child(this._refreshResult);
        this._refreshSpinner.hide();
        this._refreshResult.hide();
        toolbar.add_child(refreshStatus);
        toolbar.add_child(gear);
        toolbar.connect('destroy', () => {
            if (this._refreshTimer) GLib.source_remove(this._refreshTimer);
            this._refreshTimer = 0;
            this._refreshPending = false;
        });
        const welcome = new PopupMenu.PopupMenuSection();
        indicator.menu.addMenuItem(welcome);
        // A plain full-width container avoids menu-item ornament/indent columns.
        const welcomeContent = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'pingoose-welcome-content',
        });
        welcomeContent.add_child(
            new St.Label({
                text: 'Pingoose 42 Info',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                style_class: 'pingoose-welcome-title',
            })
        );
        const loginButton = new St.Button({
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            style_class: 'pingoose-login-button',
        });
        loginButton.set_child(
            new St.Label({
                text: 'Log in to 42 Intra',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            })
        );
        loginButton.connect('clicked', () => {
            indicator.menu.close();
            this._bridge.send('login');
        });
        welcomeContent.add_child(loginButton);
        welcome.actor.add_child(welcomeContent);
        const settings = new PopupMenu.PopupMenu(gear, 1.0, St.Side.TOP);
        Main.uiGroup.add_child(settings.actor);
        settings.actor.hide();
        this._optionsMenu = settings;
        this._optionsManager ||= new PopupMenu.PopupMenuManager(indicator);
        this._optionsManager.addMenu(settings);
        settings.addAction('Visit 42 Intra', () => {
            indicator.menu.close();
            const ext = imports.misc.extensionUtils.getCurrentExtension();
            const LinkOpener = ext.imports.services?.linkOpener;
            if (LinkOpener) {
                LinkOpener.openLink(this._settings, this._bridge, {
                    name: '42 Intra',
                    url: 'https://profile.intra.42.fr/',
                });
            } else {
                this._bridge.send('show');
            }
        });
        settings.addAction('Refresh', () => {
            settings.close();
            if (indicator.loginOnly || this._refreshPending) return;
            this._refreshPending = true;
            this._refreshWorkerDone = false;
            this._refreshSlotsDone = false;
            if (this._refreshTimer) GLib.source_remove(this._refreshTimer);
            this._refreshResult.hide();
            this._refreshSpinner.show();
            this._visibility.updatePanelLabel();
            this._refreshTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 90, () => {
                this._refreshTimer = 0;
                this._finishRefresh(false);
                return GLib.SOURCE_REMOVE;
            });
            this._bridge.send('refresh');
            this._slots.requestSlots('slots:list');
        });
        settings.addAction('Settings', () => {
            indicator.menu.close();
            imports.misc.extensionUtils.openPrefs();
        });
        this._dev = new Me.imports.dev.menu.Controller(settings, this._settings, indicator, {
            evaluations: this._evaluations,
            agenda: this._agenda,
            notifications: this._notifications,
            maintenance: this._maintenance,
        });
        const showMain = () => {
            // Each component owns its visibility; bulk-showing menu items also
            // reveals the inactive maintenance card until its next timer tick.
            toolbar.visible = !indicator.loginOnly;
            welcome.actor.visible = indicator.loginOnly;
            this._visibility.sync();
            this._maintenance.sync();
        };
        const sync = () => this._applyTheme();
        this._themeChanged = this._settings.connect('changed', (_settings, key) => {
            if (
                [
                    'update-check-request',
                    'agenda-calendar-status',
                    'sync-agenda-calendar',
                    'deleted-calendar-events',
                    'start-reminders-sent',
                    'agenda-calendar-scope',
                    'auto-delete-past-agenda-calendar',
                    'panel-animations',
                    'panel-animation-duration',
                ].includes(key)
            )
                return;
            if (key === 'flash-preview-request') {
                if (!this._reset.active) this._notifications.previewFlash();
                return;
            }
            if (key === 'logout-request') {
                if (!this._reset.active) {
                    this._chatPanel?.reset();
                    this._bridge.send('logout');
                }
                return;
            }
            if (['agenda-reset-request', 'dismissed-agenda-ids', 'reset-request'].includes(key))
                return;
            if (key === 'reset-status' || this._reset.active) return;
            this._dev.sync();
            sync();
            this._layout.applyPanelLayout();
            showMain();
            if (['hidden-auto-slots', 'hidden-options-unlocked'].includes(key))
                this._slots.renderSlots();
        });
        sync();
        this._layout.applyPanelLayout();
        const closePanels = () => {
            if (this._settings.get_boolean('auto-close-panels')) {
                this._servicePanel.close();
                this._projectPanel.close();
                this._chatPanel.close();
            }
        };
        this._openSignal = indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (!open) {
                settings.close();
                if (!indicator.menu.actor.visible) closePanels();
            }
            if (open) {
                settings.close();
                this._slots.closeEditor();

                this._agenda.closeDetails();
                showMain();
                this._notifications.markRead();
            }
        });
        this._closedSignal = indicator.menu.connect('menu-closed', () => {
            if (!indicator.menu.isOpen) closePanels();
        });
        indicator.onLoginStateChanged = () => {
            settings.close();
            showMain();
        };
        gear.connect('clicked', () => settings.toggle());
        showMain();
    }

    _checkRefreshDone() {
        if (this._refreshPending && this._refreshWorkerDone && this._refreshSlotsDone)
            this._finishRefresh(true);
    }

    _finishRefresh(success) {
        this._refreshPending = false;
        this._visibility.updatePanelLabel();
        if (this._refreshTimer) GLib.source_remove(this._refreshTimer);
        this._refreshSpinner.hide();
        this._refreshResult.gicon = new Gio.FileIcon({
            file: Gio.File.new_for_path(
                Me.path +
                    '/assets/spinner/' +
                    (success ? 'complete.svg' : 'incomplete-symbolic.svg')
            ),
        });
        this._refreshResult.accessible_name = success
            ? 'Refresh complete'
            : 'Refresh incomplete. Try again.';
        this._refreshResult.show();
        this._refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, success ? 2000 : 4000, () => {
            this._refreshTimer = 0;
            this._refreshResult.hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyTheme() {
        const themes = Me.imports.models.themes;
        const theme = this._settings.get_string('theme');
        themes.applyClasses(this._indicator.menu.actor, theme);
        this._layout.applyPanelAppearance(
            themes.backgroundStyle(theme, this._settings.get_int('panel-transparency'))
        );
    }
};
