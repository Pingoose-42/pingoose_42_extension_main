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

    // 도메인 매니저 상태 게터/세터 위임
    get _slots() { return this._slotManager?.slots || []; }
    set _slots(val) { if (this._slotManager) this._slotManager._slots = val; }
    get _slotsExpanded() { return this._slotManager?.slotsExpanded || false; }
    set _slotsExpanded(val) { if (this._slotManager) this._slotManager.slotsExpanded = val; }
    get _slotsBusy() { return this._slotManager?.slotsBusy || false; }
    set _slotsBusy(val) { if (this._slotManager) this._slotManager._slotsBusy = val; }
    get _slotsError() { return this._slotManager?._slotsError; }
    set _slotsError(val) { if (this._slotManager) this._slotManager._slotsError = val; }
    get _slotDraft() { return this._slotManager?._slotDraft; }
    set _slotDraft(val) { if (this._slotManager) this._slotManager._slotDraft = val; }
    get _slotCreateExpanded() { return this._slotManager?._slotCreateExpanded || false; }
    set _slotCreateExpanded(val) { if (this._slotManager) this._slotManager._slotCreateExpanded = val; }
    get _slotCreating() { return this._slotManager?._slotCreating || false; }
    set _slotCreating(val) { if (this._slotManager) this._slotManager._slotCreating = val; }
    get _slotPollingReady() { return this._slotManager?._slotPollingReady || false; }
    set _slotPollingReady(val) { if (this._slotManager) this._slotManager._slotPollingReady = val; }
    get _slotPollBucket() { return this._slotManager?._slotPollBucket; }
    set _slotPollBucket(val) { if (this._slotManager) this._slotManager._slotPollBucket = val; }

    get _evaluations() { return this._evalManager?.evaluations || []; }
    set _evaluations(val) { if (this._evalManager) this._evalManager._evaluations = val; }
    get _feedback() { return this._evalManager?.feedback || {}; }
    set _feedback(val) { if (this._evalManager) this._evalManager._feedback = val; }
    get _evaluationTimes() { return this._evalManager?._evaluationTimes; }
    set _evaluationTimes(val) { if (this._evalManager) this._evalManager._evaluationTimes = val; }
    get _evaluationActors() { return this._evalManager?._evaluationActors; }
    set _evaluationActors(val) { if (this._evalManager) this._evalManager._evaluationActors = val; }
    get _evaluationKey() { return this._evalManager?._evaluationKey; }
    set _evaluationKey(val) { if (this._evalManager) this._evalManager._evaluationKey = val; }

    get _agenda() { return this._agendaManager?.agenda || []; }
    set _agenda(val) { if (this._agendaManager) this._agendaManager._agenda = val; }
    get _agendaAll() { return this._agendaManager?.agendaAll || []; }
    set _agendaAll(val) { if (this._agendaManager) this._agendaManager._agendaAll = val; }
    get _dismissedAgendaIds() { return this._agendaManager?.dismissedAgendaIds; }
    set _dismissedAgendaIds(val) { if (this._agendaManager) this._agendaManager._dismissedAgendaIds = val; }
    get _agendaBusy() { return this._agendaManager?._agendaBusy; }
    set _agendaBusy(val) { if (this._agendaManager) this._agendaManager._agendaBusy = val; }
    get _agendaActionStatus() { return this._agendaManager?._agendaActionStatus; }
    set _agendaActionStatus(val) { if (this._agendaManager) this._agendaManager._agendaActionStatus = val; }
    get _agendaExpanded() { return this._agendaManager?._agendaExpanded; }
    set _agendaExpanded(val) { if (this._agendaManager) this._agendaManager._agendaExpanded = val; }
    get _agendaTimes() { return this._agendaManager?._agendaTimes; }
    set _agendaTimes(val) { if (this._agendaManager) this._agendaManager._agendaTimes = val; }

    get _notifications() { return this._notificationManager?.notifications || []; }
    set _notifications(val) { if (this._notificationManager) this._notificationManager._notifications = val; }
    get _unreadIds() { return this._notificationManager?.unreadIds || new Set(); }
    set _unreadIds(val) { if (this._notificationManager) this._notificationManager._unreadIds = val; }
    get _receivedNotificationIds() { return this._notificationManager?._receivedNotificationIds; }
    set _receivedNotificationIds(val) { if (this._notificationManager) this._notificationManager._receivedNotificationIds = val; }
    get _flashActors() { return this._notificationManager?._flashActors || []; }
    set _flashActors(val) { if (this._notificationManager) this._notificationManager._flashActors = val; }
    get _flashTimer() { return this._notificationManager?._flashTimer || 0; }
    set _flashTimer(val) { if (this._notificationManager) this._notificationManager._flashTimer = val; }
    get _lastFlash() { return this._notificationManager?._lastFlash ?? -Infinity; }
    set _lastFlash(val) { if (this._notificationManager) this._notificationManager._lastFlash = val; }
    get _bannerSource() { return this._notificationManager?._bannerSource; }
    set _bannerSource(val) { if (this._notificationManager) this._notificationManager._bannerSource = val; }

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
        if (this._bridge) return;
        if (this._writing || !this._process || !this._commands.length)
            return;
        const proc = this._process;
        const cancel = this._cancel;
        const bytes = ByteArray.fromString(`${this._commands.shift()}\n`);
        this._writing = true;
        proc.get_stdin_pipe().write_all_async(bytes, GLib.PRIORITY_DEFAULT, cancel, (stream, result) => {
            try { stream.write_all_finish(result); }
            catch (_) {
                if (this._process === proc && this._indicator)
                    this._indicator.status.label.text = 'Unable to send a command to the Intra helper.';
            }
            if (this._process === proc) {
                this._writing = false;
                this._writeNext();
            }
        });
    }

    _message(message) {
        if (!message || typeof message !== 'object')
            return;
        if (message.type === 'reset-ready') {
            this._resetReady = true;
            if (this._resetWorkerExited) {
                this._finishFullReset();
            }
            return;
        }
        if (message.type === 'reset-error') {
            this._resetting = false;
            this._settings?.set_string('reset-status', 'error');
            return;
        }
        if (this._resetting) return;
        if (message.type === 'refresh-state') {
            if (this._refreshPending) {
                this._refreshWorkerDone = message.state === 'complete';
                if (message.state === 'failed') this._finishRefresh(false);
                else this._checkRefreshDone();
            }
            return;
        }
        if (message.type === 'favorite-clusters') {
            this._chatPanel?._favorites?.completeClusters(message);
            return;
        }
        if (message.type === 'chat-lookup') {
            this._chatPanel?.completeLookup(message);
            return;
        }
        if (message.type === 'evaluation-check') {
            this._sessionEvaluationResult = message;
            this._finishSessionCheck();
            return;
        }
        if (message.type === 'slots') {
            if (this._slotManager) { this._slotManager.onSlotsMessage(message); return; }
            if (this._refreshPending) {
                this._refreshSlotsDone = Array.isArray(message.rows) && !message.error;
                if (message.error) this._finishRefresh(false);
                else this._checkRefreshDone();
            }
            this._slotsBusy = false;
            if (this._slotCreating && !message.error && message.created > 0) {
                this._slotCreateExpanded = false;
                this._slotDraft = null;
            }
            this._slotCreating = false;
            if (Array.isArray(message.rows) && message.rows.length <= 1000) this._slots = message.rows;
            this._slotsError = typeof message.error === 'string' ? message.error.slice(0, 200) : null;
            this._renderSlots();
            this._sessionSlotResult = message;
            this._finishSessionCheck();
            return;
        }
        if (message.type === 'evaluation-dismissed' && typeof message.id === 'string') {
            const id = message.id;
            delete this._feedback[id];
            this._renderCards();
            return;
        }
        if (message.type === 'agenda-action') {
            if (this._agendaManager) { this._agendaManager.onAgendaActionMessage(message); return; }
            this._agendaBusy = null;
            this._agendaActionStatus = {id: message.id, text: message.error || ''};
            this._renderAgenda();
            return;
        }
        if (message.type === 'agenda' && Array.isArray(message.rows) && message.rows.length <= 100) {
            this._agendaAll = [...message.rows, ...(this._agendaAll || this._agenda).filter(row => row.devTest)];
            this._agenda = this._agendaAll.filter(row => !this._dismissedAgendaIds?.has(String(row.id)));
            this._renderAgenda();
            return;
        }
        if (message.type === 'evaluations' && Array.isArray(message.rows) && message.rows.length <= 10000) {
            if (this._evalManager) { this._evalManager.onEvaluationsMessage(message); return; }
            this._evaluations = [...message.rows, ...this._evaluations.filter(row => row.devTest)];
            this._renderEvaluations();
            return;
        }
        if (message.type === 'study-time') {
            if (message.login !== GLib.get_user_name()) return;
            const format = minutes => Number.isInteger(minutes) && minutes >= 0 && minutes <= 44640
                ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : '—';
            this._indicator.refreshLogtimeTitle();
            this._indicator.monthTime.text = format(message.monthMinutes);
            this._indicator.todayTime.text = `Today: ${format(message.todayMinutes)}`;
            this._indicator.studyReady = Number.isInteger(message.monthMinutes) && Number.isInteger(message.todayMinutes);
            this._indicator.checkProfileReady();
            return;
        }
        if (message.type === 'signed-out') {
            this._clearProfile();
            return;
        }
        if (['profile', 'profile-avatar'].includes(message.type)) {
            if (message.login !== GLib.get_user_name()) return;
            if (message.type === 'profile') this._indicator.updateProfile(message);
            else {
                const image = Gio.File.new_for_path(GLib.build_filenamev([
                    GLib.get_user_state_dir(), 'pingoose', 'profile-avatar']));
                this._indicator.avatarReady = true;
                this._indicator.checkProfileReady();
                this._indicator.avatar.set_child(null);
                this._indicator.avatar.set_style(`background-image: url("${image.get_uri()}"); background-size: cover;`);
            }
            return;
        }
        if (message.type === 'status' && Object.prototype.hasOwnProperty.call(STATUS, message.state)) {
            this._workerStatus = message.state;
            if (message.state === 'account-error') {
                this._clearProfile();
                Main.notify('Pingoose', 'Your Intra ID must match the current PC username. Information from another account cannot be loaded.');
            }
            if (message.state === 'login-needed') {
                this._slotPollingReady = false;
                this._slotPollBucket = null;
                this._indicator.setLoginOnly(true);
            } else if (['authenticated', 'watching'].includes(message.state)) {
                const wasLoginOnly = this._indicator.loginOnly;
                this._indicator.setLoginOnly(false);
                this._slotPollingReady = true;
                this._pollSlotsIfDue();
                if (wasLoginOnly) {
                    this._restoreCardState?.();
                    this._renderCards();
                    this._renderEvaluations();
                }
            }
            this._indicator.status.label.text = message.state;
            return;
        }
        if (message.type !== 'notification' || typeof message.body !== 'string' ||
            !message.body.trim() || message.body.length > 1000 ||
            typeof message.id !== 'string' || message.id.length > 1200)
            return;
        const existing = this._notifications.find(item => item.id === message.id);
        if (message.update === true && existing) {
            if (existing.body !== message.body) {
                existing.body = message.body;
                this._saveCardState?.();
                this._renderCards();
            }
            return;
        }
        this._receivedNotificationIds ||= new Set();
        if (this._receivedNotificationIds.has(message.id) || this._notifications.some(item => item.id === message.id))
            return;
        this._receivedNotificationIds.add(message.id);
        if (this._receivedNotificationIds.size > 2000)
            this._receivedNotificationIds.delete(this._receivedNotificationIds.values().next().value);
        this._unreadIds ||= new Set();
        if (!this._indicator.menu.isOpen) this._unreadIds.add(message.id);
        this._notifications.unshift({
            id: message.id,
            body: message.body,
            test: message.test === true,
            category: message.category,
            unread: !this._indicator.menu.isOpen,
            time: GLib.DateTime.new_now_local().format('%H:%M')
        });
        this._saveCardState?.();
        this._renderCards();
        if (message.category !== 'update' && (message.test || this._settings.get_boolean(message.category === 'agenda' ? 'notify-agenda' : 'notify-evaluations'))) {
            this._showBanner(message);
            this._flashScreen();
        }
    }

    disable() {
        this._panelShortcut?.destroy();
        this._panelShortcut = null;
        this._autoHideScrollbars?.destroy();
        this._autoHideScrollbars = null;
        this._bannerDuration?.destroy();
        this._bannerDuration = null;
        this._updater?.destroy();
        this._updater = null;
        this._projectPanel?.destroy();
        this._projectPanel = null;
        this._servicePanel?.destroy();
        this._servicePanel = null;
        this._chatPanel?.destroy();
        this._chatPanel = null;

        this._sessionHook?.disable();
        this._sessionHook = null;

        this._notificationManager?.destroy();
        this._notificationManager = null;
        this._agendaManager?.destroy();
        this._agendaManager = null;
        this._evalManager?.destroy();
        this._evalManager = null;
        this._slotManager?.destroy();
        this._slotManager = null;

        this._optionsMenu?.destroy();
        this._optionsMenu = null;
        this._optionsManager = null;

        if (this._evaluationClock) GLib.source_remove(this._evaluationClock);
        this._evaluationClock = 0;
        if (this._themeChanged) this._settings.disconnect(this._themeChanged);
        this._themeChanged = 0;
        if (this._profileClock) GLib.source_remove(this._profileClock);
        this._profileClock = 0;

        this._bridge?.destroy();
        this._bridge = null;

        this._settings = null;
        this._notificationSettings = null;

        this._indicator?.destroy();
        this._indicator = null;
    }
}

// Feature controllers share this extension's lifecycle and state.
for (const name of ['settings', 'evaluations', 'slots', 'agenda', 'notifications', 'visibility', 'reset', 'layout']) {
    const descriptors = Object.getOwnPropertyDescriptors(Me.imports.ui[name].Controller.prototype);
    delete descriptors.constructor;
    Object.defineProperties(Pingoose.prototype, descriptors);
}

function init() {
    return new Pingoose();
}
