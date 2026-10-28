const {Gio, GLib, Meta, St} = imports.gi;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const ByteArray = imports.byteArray;
const Indicator = Me.imports.ui.indicator.Indicator;
const WorkerBridge = Me.imports.services.workerBridge.WorkerBridge;
const SlotManager = Me.imports.ui.slots.SlotManager;
const AgendaManager = Me.imports.ui.agenda.AgendaManager;
const EvaluationManager = Me.imports.ui.evaluations.EvaluationManager;
const NotificationManager = Me.imports.ui.notifications.NotificationManager;

const STATUS = Object.fromEntries([
    'authenticated', 'loading', 'watching', 'login-needed', 'auth-error',
    'permission-error', 'account-error', 'rate-limit', 'retry-wait', 'network-error',
    'api-error', 'response-error', 'storage-error', 'worker-error', 'worker-busy',
].map(state => [state, state]));

class Pingoose {
    enable() {
        this._settings = imports.misc.extensionUtils.getSettings();
        this._notificationSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._bridge = new WorkerBridge();
        this._indicator = new Indicator();

        this._resetting = false;
        this._resetReady = false;
        this._resetWorkerExited = false;
        this._workerStatus = null;
        this._refreshPending = false;
        this._refreshWorkerDone = false;
        this._refreshSlotsDone = false;

        this._bannerDuration = new Me.imports.services.bannerDuration.Controller(this._settings);
        this._autoHideScrollbars = new Me.imports.ui.autoHideScrollbars.Controller(this._indicator.menu.actor, this._settings);

        this._indicator.onLogin = () => this._send('login');
        this._indicator.onProjectOpen = project => {
            if (project.slug !== '__my_projects__' && this._settings.get_boolean('project-open-direct')) {
                this._visitProject(project);
            } else {
                this._projectPanel.open(project);
            }
        };
        this._indicator.onCountChanged = () => this._updatePanelLabel();

        // 수직 도메인 매니저 독립 인스턴스화
        this._slotManager = new SlotManager(this._indicator, this._bridge, this._settings, {
            onVisibilitySync: () => this._syncOptionalSections(),
            onRefreshState: (success, error) => {
                if (this._refreshPending) {
                    this._refreshSlotsDone = success;
                    if (error) this._finishRefresh(false);
                    else this._checkRefreshDone();
                }
            }
        });

        this._evalManager = new EvaluationManager(this._indicator, this._bridge, this._settings, {
            optionsManager: this._optionsManager,
            onVisibilitySync: () => this._syncOptionalSections(),
            onSaveCardState: () => this._notificationManager?.saveCardState()
        });

        this._agendaManager = new AgendaManager(this._indicator, this._bridge, this._settings, {
            optionsManager: this._optionsManager,
            onVisibilitySync: () => this._syncOptionalSections()
        });

        this._notificationManager = new NotificationManager(this._indicator, this._bridge, this._settings, {
            notificationSettings: this._notificationSettings,
            onVisibilitySync: () => this._syncOptionalSections(),
            onUpdatePanelLabel: () => this._updatePanelLabel(),
            getEvaluations: () => this._evalManager?.evaluations || []
        });

        Main.panel.addToStatusArea(Me.uuid, this._indicator);
        this._panelShortcut = new Me.imports.services.panelShortcut.Binding(this._settings, () => this._indicator.menu.toggle());

        this._profileClock = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._indicator?.refreshLogtimeTitle();
            if (this._indicator?.lastProfile) this._indicator.updateProfile(this._indicator.lastProfile);
            return GLib.SOURCE_CONTINUE;
        });

        this._restoreCardState();
        this._renderEvaluations();

        this._evaluationClock = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._renderEvaluations();
            this._updateAgendaTimes();
            this._pollSlotsIfDue();
            return GLib.SOURCE_CONTINUE;
        });

        this._renderCards();

        this._chatPanel = new Me.imports.ui.chatPanel.ChatPanel(this._indicator, command => this._send(command));
        this._chatPanel.onAvailabilityChanged = () => this._renderEvaluations();
        this._evalManager._chatPanel = this._chatPanel;

        this._servicePanel = new Me.imports.ui.servicePanel.ServicePanel(this._indicator, command => this._send(command));
        this._projectPanel = new Me.imports.ui.projectPanel.ProjectPanel(this._indicator, project => this._visitProject(project));

        this._buildSettings();

        this._sessionHook = new Me.imports.services.systemSessionHook.SystemSessionHook(
            (command, callback) => this._sessionSlotRequest(command, callback),
            () => !!this._bridge.process && !this._indicator.loginOnly,
            () => this._settings.get_boolean('warn-open-slots-on-logout'),
            () => this._evalManager?.evaluations || []
        );
        this._sessionHook.enable();

        this._bindBridgeEvents();
        this._messageHandlers = this._initMessageHandlers();
        this._startWorker();
        this._requestFullReset();

        if (!this._resetting) {
            this._updater = new Me.imports.services.updater.Updater(this._settings, commit => {
                Me.imports.models.updateCards.bodies(commit).forEach((body, index) => this._message({
                    type: 'notification',
                    category: 'update',
                    id: `update:${commit.sha}:${index}`,
                    body,
                }));
            });
        }
    }

    _bindBridgeEvents() {
        this._bridge.on('error', error => {
            if (this._indicator) this._indicator.status.label.text = error;
        });

        this._bridge.on('process-exited', () => {
            if (this._resetting) {
                this._resetWorkerExited = true;
                if (this._resetReady) {
                    this._finishFullReset();
                }
                return;
            }
            if (this._indicator && !['worker-busy', 'worker-error'].includes(this._workerStatus)) {
                this._indicator.status.label.text = 'Intra monitoring stopped. Restart the extension.';
            }
        });

        this._bridge.on('message', msg => {
            this._message(msg);
        });
    }

    _startWorker() {
        this._bridge.start();
    }

    get _process() {
        return this._bridge?.process;
    }

    set _process(val) {
        if (!val && this._bridge) {
            this._bridge._process = null;
        }
    }

    // 도메인 매니저 상태 접근자 (Visibility/Layout 동기화용)
    get _slots() { return this._slotManager?.slots || []; }
    get _slotsExpanded() { return this._slotManager?.slotsExpanded || false; }
    get _evaluations() { return this._evalManager?.evaluations || []; }
    set _evaluations(val) { if (this._evalManager) this._evalManager._evaluations = val; }
    get _feedback() { return this._evalManager?.feedback || {}; }
    get _agenda() { return this._agendaManager?.agenda || []; }
    set _agenda(val) { if (this._agendaManager) this._agendaManager._agenda = val; }
    get _agendaAll() { return this._agendaManager?.agendaAll || []; }
    set _agendaAll(val) { if (this._agendaManager) this._agendaManager._agendaAll = val; }
    get _dismissedAgendaIds() { return this._agendaManager?.dismissedAgendaIds; }
    set _dismissedAgendaIds(val) { if (this._agendaManager) this._agendaManager._dismissedAgendaIds = val; }
    get _notifications() { return this._notificationManager?.notifications || []; }
    set _notifications(val) { if (this._notificationManager) this._notificationManager._notifications = val; }
    get _unreadIds() { return this._notificationManager?.unreadIds || new Set(); }

    _visitProject(project) {
        this._indicator.menu.close();
        this._send('project:open:' + JSON.stringify(project));
    }

    _clearProfile() {
        this._projectPanel?.reset();
        this._chatPanel?.reset();
        this._slotManager?.clear();
        this._agendaManager?.clear();
        this._evalManager?.clear();
        this._notificationManager?.clear();
        this._indicator?.resetProfile();
        this._renderCards();
    }

    _send(command) {
        if (this._bridge) {
            this._bridge.send(command);
            return;
        }
        if (!this._process) {
            if (this._indicator) this._indicator.status.label.text = 'Intra monitoring is stopped. Restart the extension.';
            return;
        }
        // Carry the Shell input event time across the asynchronous worker pipe.
        if (command === 'show' || command === 'login' || /^(project|service):open:/.test(command))
            command = `present:${global.get_current_time() >>> 0}:${command}`;
        this._commands.push(command);
        this._writeNext();
    }

    _writeNext() {
        // Stream writing is handled by WorkerBridge.
    }

    _message(message) {
        if (!message || typeof message !== 'object' || this._resetting) return;

        // Agenda snapshot compatibility block
        if (message.type === 'agenda' && Array.isArray(message.rows) && message.rows.length <= 100) {
            this._agendaAll = [...message.rows, ...(this._agendaAll || this._agenda).filter(row => row.devTest)];
            this._agenda = this._agendaAll.filter(row => !this._dismissedAgendaIds?.has(String(row.id)));
            this._renderAgenda();
            return;
        }
        if (message.type === 'agenda-action') {
            this._agendaManager?.onAgendaActionMessage(message);
            return;
        }

        (this._messageHandlers ||= this._initMessageHandlers())[message.type]?.(message);
    }

    _initMessageHandlers() {
        return {
            'reset-ready': () => {
                this._resetReady = true;
                if (this._resetWorkerExited) this._finishFullReset();
            },
            'reset-error': () => {
                this._resetting = false;
                this._settings?.set_string('reset-status', 'error');
            },
            'refresh-state': msg => {
                if (!this._refreshPending) return;
                this._refreshWorkerDone = msg.state === 'complete';
                if (msg.state === 'failed') this._finishRefresh(false);
                else this._checkRefreshDone();
            },
            'favorite-clusters': msg => this._chatPanel?._favorites?.completeClusters(msg),
            'chat-lookup': msg => this._chatPanel?.completeLookup(msg),
            'evaluation-check': msg => {
                this._sessionEvaluationResult = msg;
                this._finishSessionCheck();
            },
            'slots': msg => this._slotManager?.onSlotsMessage(msg),
            'evaluation-dismissed': msg => this._evalManager?.onEvaluationDismissedMessage(msg),
            'evaluations': msg => this._evalManager?.onEvaluationsMessage(msg),
            'study-time': msg => this._indicator?.updateStudyTime(msg),
            'signed-out': () => this._clearProfile(),
            'profile': msg => {
                if (msg.login === GLib.get_user_name()) this._indicator?.updateProfile(msg);
            },
            'profile-avatar': msg => this._indicator?.updateAvatar(msg.login),
            'status': msg => this._handleStatus(msg),
            'notification': msg => this._handleNotification(msg),
        };
    }

    _handleStatus(msg) {
        if (!Object.prototype.hasOwnProperty.call(STATUS, msg.state)) return;
        this._workerStatus = msg.state;
        if (msg.state === 'account-error') {
            this._clearProfile();
            Main.notify('Pingoose', 'Your Intra ID must match the current PC username. Information from another account cannot be loaded.');
            return;
        }
        if (msg.state === 'login-needed') {
            this._slotManager && (this._slotManager._slotPollingReady = false);
            this._indicator?.setLoginOnly(true);
            return;
        }
        if (['authenticated', 'watching'].includes(msg.state)) {
            const wasLoginOnly = this._indicator?.loginOnly;
            this._indicator?.setLoginOnly(false);
            this._slotManager && (this._slotManager._slotPollingReady = true);
            this._slotManager?.pollSlotsIfDue();
            if (wasLoginOnly) {
                this._restoreCardState?.();
                this._renderCards();
                this._renderEvaluations();
            }
        }
        if (this._indicator?.status?.label) this._indicator.status.label.text = msg.state;
    }

    _handleNotification(message) {
        if (this._notificationManager) {
            this._notificationManager.onNotificationMessage(message);
            return;
        }
        const existing = this._notifications?.find(item => item.id === message.id);
        if (message.update === true && existing) {
            if (existing.body !== message.body) {
                existing.body = message.body;
                this._saveCardState?.();
                this._renderCards();
            }
            return;
        }
        this._receivedNotificationIds ||= new Set();
        if (this._receivedNotificationIds.has(message.id) || this._notifications?.some(item => item.id === message.id))
            return;
        this._receivedNotificationIds.add(message.id);
        if (this._receivedNotificationIds.size > 2000)
            this._receivedNotificationIds.delete(this._receivedNotificationIds.values().next().value);
        this._unreadIds ||= new Set();
        if (!this._indicator?.menu?.isOpen) this._unreadIds.add(message.id);
        this._notifications?.unshift({
            id: message.id, body: message.body,
            test: message.test === true, category: message.category,
            unread: !this._indicator?.menu?.isOpen, time: GLib.DateTime.new_now_local().format('%H:%M')
        });
        this._saveCardState?.();
        this._renderCards();
        if (message.category !== 'update' && (message.test || this._settings?.get_boolean(message.category === 'agenda' ? 'notify-agenda' : 'notify-evaluations'))) {
            this._showBanner(message);
            this._flashScreen();
        }
    }

    disable() {
        for (const comp of [
            this._panelShortcut, this._autoHideScrollbars, this._bannerDuration,
            this._updater, this._projectPanel, this._servicePanel, this._chatPanel,
            this._notificationManager, this._agendaManager, this._evalManager, this._slotManager,
            this._optionsMenu, this._bridge, this._indicator,
        ]) {
            comp?.destroy();
        }
        this._sessionHook?.disable();
        this._sessionHook = null;
        if (this._evaluationClock) GLib.source_remove(this._evaluationClock);
        this._evaluationClock = 0;
        if (this._themeChanged) this._settings.disconnect(this._themeChanged);
        this._themeChanged = 0;
        if (this._profileClock) GLib.source_remove(this._profileClock);
        this._profileClock = 0;
        this._settings = null;
        this._notificationSettings = null;
        this._optionsManager = null;
    }
}

// Shell view, settings, and reset controllers
for (const name of ['settings', 'visibility', 'reset', 'layout']) {
    const descriptors = Object.getOwnPropertyDescriptors(Me.imports.ui[name].Controller.prototype);
    delete descriptors.constructor;
    Object.defineProperties(Pingoose.prototype, descriptors);
}

function init() {
    return new Pingoose();
}
