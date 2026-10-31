const Me = imports.misc.extensionUtils.getCurrentExtension();

var Controller = class Controller {
    constructor(indicator, settings, options = {}) {
        this._indicator = indicator;
        this._settings = settings;
        this._chatPanel = options.chatPanel || null;
        this._servicePanel = options.servicePanel || null;
        this._projectPanel = options.projectPanel || null;
        this._layoutManager = options.layoutManager || null;
        this._getEvaluationsCallback = options.getEvaluations || (() => []);
        this._getAgendaCallback = options.getAgenda || (() => []);
        this._getNotificationsCallback = options.getNotifications || (() => []);
        this._getUnreadIdsCallback = options.getUnreadIds || (() => null);
        this._isRefreshing = options.isRefreshing || (() => false);
        this._getSlotsExpandedCallback = options.getSlotsExpanded || (() => false);
    }

    sync() {
        this._syncOptionalSections();
    }

    updatePanelLabel() {
        this._updatePanelLabel();
    }

    _applySectionOrder() {
        const indicator = this._indicator;
        const groups = {
            profile: [indicator.profileItem, indicator.profileSeparator],
            overview: [indicator.overviewItem, indicator.overviewSeparator],
            slots: [indicator.slotsButtonItem, indicator.slotsItem],
            evaluations: [indicator.evaluationItem],
            agenda: [indicator.agendaItem],
            notifications: [indicator.notificationItem],
            chat: [this._chatPanel?._chatUi?.item],
            services: [this._servicePanel?.item],
        };
        const appearance = Me.imports.models.appearance;
        const order = appearance.read(this._settings);
        const box = indicator.menu.box;
        // Keep the options toolbar first and the signed-out welcome view last.
        let index = indicator.toolbarItem ? 1 : 0;
        for (const key of order) {
            for (const item of groups[key]) {
                const actor = item?.actor || item;
                if (!actor || actor.get_parent() !== box) continue;
                if (box.get_child_at_index(index) !== actor)
                    indicator.menu.moveMenuItem(item, index);
                index++;
            }
        }
        const visible = order.filter((key) => {
            const item = groups[key][0];
            return !!(item?.actor || item)?.visible;
        });
        for (const key of ['profile', 'overview']) {
            const separator = groups[key][1];
            if (separator)
                (separator.actor || separator).visible =
                    visible.includes(key) && key !== visible[visible.length - 1];
        }
    }

    _updatePanelLabel() {
        const indicator = this._indicator;
        if (!indicator) return;
        const loading = !indicator.loginOnly && (!indicator.profileReady || this._isRefreshing?.());
        if (indicator.loadingIcon) {
            indicator.loadingIcon.visible = loading;
            indicator.icon.visible = !loading;
            if (loading) {
                indicator.count.text = '';
                return;
            }
        }
        if (indicator.loginOnly) {
            indicator.count.text = 'Login Required';
            return;
        }
        const evals = this._getEvaluationsCallback();
        const agenda = this._getAgendaCallback();
        const notifications = this._getNotificationsCallback();
        const unreadIds = this._getUnreadIdsCallback();

        const feedback =
            evals.filter((row) => Date.parse(row.begin) <= Date.now()).length +
            agenda.filter((row) => row.feedback).length;
        const unread = unreadIds?.size ?? notifications.filter((row) => row.unread).length;
        const badge = (count) => (count > 5 ? '5+' : String(count));
        if (feedback) indicator.count.text = `Feedback ${badge(feedback)}`;
        else if (unread) indicator.count.text = `New ${badge(unread)}`;
        else if (indicator.profileReady) indicator.count.text = '42';
    }

    _syncOptionalSections() {
        this._chatPanel?.sync();
        this._servicePanel?.sync();
        this._projectPanel?.sync();
        this._updatePanelLabel();
        const indicator = this._indicator;
        const enabled = (key) =>
            this._settings ? this._settings.get_boolean(`show-${key}`) : true;

        const slotsExpanded = this._getSlotsExpandedCallback();
        const evals = this._getEvaluationsCallback();
        const agenda = this._getAgendaCallback();
        const notifications = this._getNotificationsCallback();

        if (indicator.slotsButtonItem)
            indicator.slotsButtonItem.visible = !indicator.loginOnly && enabled('slots');
        if (indicator.slotReveal) {
            const visible = slotsExpanded && !indicator.loginOnly && enabled('slots');
            if (visible) indicator.slotsItem.show();
            indicator.slotReveal.setExpanded(visible);
            indicator.slotsItem.visible = indicator.slotReveal.visible;
        }
        if (indicator.profileSeparator)
            indicator.profileSeparator.visible = !indicator.loginOnly && enabled('profile');
        if (indicator.profileItem)
            indicator.profileItem.visible = !indicator.loginOnly && enabled('profile');
        if (indicator.overviewItem) {
            indicator.projectsColumn.visible = enabled('projects');
            indicator.studyColumn.visible = enabled('logtime');
            indicator.overviewItem.visible =
                !indicator.loginOnly && (enabled('projects') || enabled('logtime'));
        }
        const pendingEvaluations = evals.filter(
            (row) => Date.parse(row.begin) <= Date.now()
        ).length;
        indicator.evaluationToggle?.updateCount(
            evals.length - pendingEvaluations,
            pendingEvaluations
        );
        const pendingAgenda = agenda.filter((row) => row.feedback).length;
        indicator.agendaToggle?.updateCount(agenda.length - pendingAgenda, pendingAgenda);
        indicator.notificationToggle?.updateCount(notifications.length);

        const evaluationsVisible = !indicator.loginOnly && !!evals.length && enabled('evaluations');
        const notificationsVisible =
            !indicator.loginOnly && !!notifications.length && enabled('notifications');
        const agendaVisible = !indicator.loginOnly && !!agenda.length && enabled('agenda');

        if (indicator.agendaItem?.actor) indicator.agendaItem.actor.visible = agendaVisible;
        else if (indicator.agendaItem) indicator.agendaItem.visible = agendaVisible;

        if (indicator.evaluationItem?.actor)
            indicator.evaluationItem.actor.visible = evaluationsVisible;
        else if (indicator.evaluationItem) indicator.evaluationItem.visible = evaluationsVisible;

        if (indicator.notificationItem?.actor)
            indicator.notificationItem.actor.visible = notificationsVisible;
        else if (indicator.notificationItem)
            indicator.notificationItem.visible = notificationsVisible;

        this._applySectionOrder();
        if (this._layoutManager) this._layoutManager.applyPanelLayout();
    }
};

var VisibilityManager = Controller;
