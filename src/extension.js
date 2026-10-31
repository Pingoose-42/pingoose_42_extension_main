const { Gio, GLib } = imports.gi;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

class Pingoose {
    enable() {
        this._components = [];
        this._listeners = [];
        this._timers = [];
        this._sessionHook = null;
        try {
            this._enable();
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    _enable() {
        // Until assembly completes, unwind already-created components in reverse
        // order if a later constructor fails. Normal teardown keeps its explicit order.
        const own = (component) => {
            this._components.unshift(component);
            return component;
        };
        const settings = ExtensionUtils.getSettings();
        const indicator = own(new Me.imports.ui.indicator.Indicator());
        const bridge = own(
            new Me.imports.services.workerBridge.WorkerBridge({
                acceptMessage: (message) =>
                    !reset?.active || ['reset-ready', 'reset-error'].includes(message.type),
            })
        );
        const optionsManager = new PopupMenu.PopupMenuManager(indicator);
        let visibility, settingsMenu, reset;
        const sync = () => visibility?.sync();
        const send = (command) => bridge.send(command);
        const visitProject = (project) => {
            indicator.menu.close();
            const LinkOpener = Me.imports.services?.linkOpener;
            if (LinkOpener) LinkOpener.openProject(settings, bridge, project);
            else send('project:open:' + JSON.stringify(project));
        };
        const notificationsSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.notifications',
        });
        const bannerDuration = own(new Me.imports.services.bannerDuration.Controller(settings));
        const scrollbars = own(
            new Me.imports.ui.autoHideScrollbars.Controller(indicator.menu.actor, settings)
        );
        const layout = own(new Me.imports.ui.layout.LayoutManager(indicator, settings));
        const chat = own(new Me.imports.ui.chatPanel.ChatPanel(indicator, send));
        const services = own(new Me.imports.ui.servicePanel.ServicePanel(indicator, send));
        const projects = own(new Me.imports.ui.projectPanel.ProjectPanel(indicator, visitProject));
        const slots = own(
            new Me.imports.ui.slots.SlotManager(indicator, bridge, settings, {
                onVisibilitySync: sync,
                onRefreshState: (success, error) => settingsMenu?.slotsRefreshed(success, error),
            })
        );
        const evaluations = own(
            new Me.imports.ui.evaluations.EvaluationManager(indicator, bridge, settings, {
                optionsManager,
                chatPanel: chat,
                onVisibilitySync: sync,
                onSaveCardState: () => notifications.saveCardState(),
            })
        );
        const calendarPrompt = own(new Me.imports.services.calendarPrompt.Controller());
        const calendar = own(
            new Me.imports.services.agendaCalendar.Controller(
                settings,
                () => send('agenda:refresh'),
                (done) => calendarPrompt.ask(done)
            )
        );
        const agenda = own(
            new Me.imports.ui.agenda.AgendaManager(indicator, bridge, settings, {
                optionsManager,
                onVisibilitySync: sync,
                onSnapshot: (rows, subject) => calendar.observe(rows, subject),
            })
        );
        const notifications = own(
            new Me.imports.ui.notifications.NotificationManager(indicator, bridge, settings, {
                notificationSettings: notificationsSettings,
                onVisibilitySync: sync,
                onUpdatePanelLabel: () => visibility?.updatePanelLabel(),
                getEvaluations: () => evaluations.evaluations,
                restoreTests: (rows) => evaluations.restoreTests(rows),
                isResetting: () => !!reset?.active,
            })
        );
        const reminders = new Me.imports.services.startReminders.Controller(settings, (message) =>
            notifications.onNotificationMessage(message)
        );
        visibility = new Me.imports.ui.visibility.VisibilityManager(indicator, settings, {
            chatPanel: chat,
            servicePanel: services,
            projectPanel: projects,
            layoutManager: layout,
            getEvaluations: () => evaluations.evaluations,
            getAgenda: () => agenda.agenda,
            getNotifications: () => notifications.notifications,
            getUnreadIds: () => notifications.unreadIds,
            getSlotsExpanded: () => slots.slotsExpanded,
            isRefreshing: () => !!settingsMenu?.pending,
        });
        const maintenance = own(
            new Me.imports.ui.maintenance.Controller(indicator, sync, () => send('refresh'))
        );
        const clear = () => {
            projects.reset();
            chat.reset();
            slots.clear();
            calendar.clear();
            agenda.clear();
            evaluations.clear();
            notifications.clear();
            indicator.resetProfile();
        };
        const updater = own(
            new Me.imports.services.updater.Updater(settings, (commit) => {
                Me.imports.models.updateCards.bodies(commit).forEach((body, index) =>
                    notifications.onNotificationMessage({
                        type: 'notification',
                        category: 'update',
                        id: `update:${commit.sha}:${index}`,
                        body,
                    })
                );
            })
        );
        reset = own(
            new Me.imports.services.reset.Controller(bridge, settings, {
                updater,
                clear,
                prepare: () => {
                    indicator.menu.close();
                    services.close();
                    for (const process of services.previews || []) process.force_exit();
                    notifications.resetPresentation();
                },
                refresh: () => {
                    services.render();
                    settingsMenu.refreshAppearance();
                },
            })
        );
        settingsMenu = own(
            new Me.imports.ui.settings.Controller(indicator, bridge, settings, {
                slots,
                agenda,
                evaluations,
                notifications,
                chat,
                services,
                projects,
                visibility,
                layout,
                reset,
                maintenance,
                optionsManager,
            })
        );
        const tickReminders = () => {
            if (!indicator.loginOnly && !maintenance.active && !reset.active)
                reminders.tick(evaluations.evaluations, agenda.agendaAll);
        };
        const session = own(
            new Me.imports.services.session.Controller(bridge, indicator, {
                maintenance,
                onClear: clear,
                isResetting: () => reset.active,
                onAuthenticated: (changed) => {
                    if (changed) {
                        notifications.restoreCardState();
                        notifications.renderCards();
                        evaluations.renderEvaluations();
                    }
                    slots.pollSlotsIfDue();
                    tickReminders();
                },
            })
        );
        this._listeners.push(
            bridge.on('favorite-clusters', (message) => chat.completeClusters(message))
        );
        this._listeners.push(bridge.on('chat-lookup', (message) => chat.completeLookup(message)));
        indicator.onLogin = () => send('login');
        indicator.onProjectOpen = (project) => {
            if (project.slug !== '__my_projects__' && settings.get_boolean('project-open-direct'))
                visitProject(project);
            else projects.open(project);
        };
        indicator.onCountChanged = () => visibility.updatePanelLabel();
        chat.onAvailabilityChanged = () => evaluations.renderEvaluations();
        Main.panel.addToStatusArea(Me.uuid, indicator);
        const shortcut = own(
            new Me.imports.services.panelShortcut.Binding(settings, () => indicator.menu.toggle())
        );
        const sessionHook = new Me.imports.services.systemSessionHook.SystemSessionHook(
            (command, callback) => slots.sessionSlotRequest(command, callback),
            () => bridge.isRunning && !indicator.loginOnly,
            () => settings.get_boolean('warn-open-slots-on-logout'),
            () => evaluations.evaluations
        );
        this._sessionHook = sessionHook;
        sessionHook.enable();
        this._timers.push(
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
                indicator.refreshLogtimeTitle();
                if (indicator.lastProfile) indicator.updateProfile(indicator.lastProfile);
                return GLib.SOURCE_CONTINUE;
            })
        );
        this._timers.push(
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                evaluations.renderEvaluations();
                agenda.updateAgendaTimes();
                slots.pollSlotsIfDue();
                tickReminders();
                return GLib.SOURCE_CONTINUE;
            })
        );
        // Stop producers first; dispose views before the actors they reference.
        this._components = [
            session,
            reset,
            updater,
            settingsMenu,
            calendarPrompt,
            calendar,
            maintenance,
            shortcut,
            scrollbars,
            bannerDuration,
            projects,
            services,
            chat,
            notifications,
            agenda,
            evaluations,
            slots,
            layout,
            bridge,
            indicator,
        ];
        notifications.restoreCardState();
        notifications.renderCards();
        evaluations.renderEvaluations();
        bridge.start();
        reset.request();
    }

    disable() {
        // Drain ownership before invoking callbacks: a cleanup error or a second
        // disable must not leave later resources alive or dispose anything twice.
        const timers = this._timers || [];
        const sessionHook = this._sessionHook;
        const listeners = this._listeners || [];
        const components = this._components || [];
        this._timers = [];
        this._sessionHook = null;
        this._listeners = [];
        this._components = [];
        const cleanup = (action) => {
            try {
                action();
            } catch (error) {
                // Logging must not mask the original enable failure or interrupt
                // cleanup of the remaining Shell actors, signals and subprocesses.
                try {
                    logError(error, 'Pingoose cleanup failed');
                } catch (_) {}
            }
        };
        for (const timer of timers) cleanup(() => GLib.source_remove(timer));
        if (sessionHook) cleanup(() => sessionHook.disable());
        for (const unsubscribe of listeners) cleanup(unsubscribe);
        for (const component of components) cleanup(() => component.destroy());
    }
}

function init() {
    return new Pingoose();
}
