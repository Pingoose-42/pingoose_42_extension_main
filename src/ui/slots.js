const { Clutter, GLib, Pango, St } = imports.gi;
const PopupMenu = imports.ui.popupMenu;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const CountLabel = Me.imports.ui.countLabel;

var Controller = class Controller {
    constructor(indicator, bridge, settings, options = {}) {
        this._indicator = indicator;
        this._bridge = bridge;
        this._settings = settings;
        this._syncOptionalSectionsCallback = options.onVisibilitySync || (() => {});
        this._onRefreshStateCallback = options.onRefreshState || null;

        this._slotAction = null;
        this._createError = null;
        this._actionButtons = [];
        this._slots = [];
        this._slotsReady = false;
        this._renderedSlots = null;
        this._slotsExpanded = this._settings?.get_boolean('expand-slots') || false;
        this._slotsBusy = false;
        this._slotsError = null;
        this._slotDraft = null;
        this._slotCreateExpanded = false;
        this._slotCreating = false;
        this._slotPollingReady = false;
        this._slotPollBucket = null;

        this._sessionSlotsCallback = null;
        this._sessionSlotsTimer = 0;
        this._sessionSlotResult = null;
        this._sessionEvaluationResult = null;

        if (this._indicator?.visitIntra) {
            this._visitIntraSignal = this._indicator.visitIntra.connect('clicked', () => {
                this._slotsExpanded = !this._slotsExpanded;
                this._settings?.set_boolean('expand-slots', this._slotsExpanded);
                if (this._slotsExpanded) this._pollSlotsIfDue();
                this._renderSlots();
            });
        }

        if (this._bridge) {
            this._unsubSlots = this._bridge.on('slots', (msg) => this.onSlotsMessage(msg));
            this._unsubEvalCheck = this._bridge.on('evaluation-check', (msg) => {
                this._sessionEvaluationResult = msg;
                this._finishSessionCheck();
            });
            this._unsubStatus = this._bridge.on('status', (msg) => this.onStatusMessage(msg));
        }
    }

    get slots() {
        return this._slots;
    }
    get slotsExpanded() {
        return this._slotsExpanded;
    }
    set slotsExpanded(v) {
        this._slotsExpanded = v;
    }
    get slotsBusy() {
        return this._slotsBusy;
    }

    onSlotsMessage(message) {
        const creating = this._slotCreating;
        this._slotAction = null;
        this._slotsBusy = false;
        if (this._slotCreating && !message.error && message.created > 0) {
            this._setCreatorExpanded(false);
            this._slotDraft = null;
        }
        this._slotCreating = false;
        if (Array.isArray(message.rows) && message.rows.length <= 1000 && !message.error) {
            this._slots = message.rows;
            this._slotsReady = true;
        }
        const error = typeof message.error === 'string' ? message.error.slice(0, 1000) : null;
        if (creating) this._setCreateError(error);
        this._slotsError = creating ? null : error;
        this._renderSlots();
        this._sessionSlotResult = message;
        this._finishSessionCheck();
        this._onRefreshStateCallback?.(
            Array.isArray(message.rows) && !message.error,
            message.error
        );
    }

    onStatusMessage(message) {
        if (message.state === 'login-needed') {
            this._slotPollingReady = false;
            this._slotPollBucket = null;
        } else if (['authenticated', 'watching'].includes(message.state)) {
            this._slotPollingReady = true;
            this._pollSlotsIfDue();
        }
    }

    closeEditor() {
        this._setCreateError(null);
        this._setCreatorExpanded(false, false);
        this._slotDraft = null;
    }

    _setCreatorExpanded(expanded, animate = true) {
        this._slotCreateExpanded = expanded;
        if (expanded) this._syncCreator?.();
        if (this._creatorReveal) {
            if (expanded) this._creatorItem.show();
            this._creatorReveal.setExpanded(expanded, animate);
            this._creatorItem.visible = this._creatorReveal.visible;
        }
        if (this._creatorButton)
            this._creatorButton.style_class =
                'pingoose-clear-button' + (expanded ? ' pingoose-toggle-active' : '');
    }

    clear() {
        this._slotAction = null;
        this._createError = null;
        this._slots = [];
        this._slotsReady = false;
        this._renderedSlots = null;
        this._slotPollingReady = false;
        this._slotPollBucket = null;
        this._slotDraft = null;
        this._slotCreateExpanded = false;
        this._slotsExpanded = this._settings.get_boolean('expand-slots');
        this._slotsBusy = false;
        this._slotsError = null;
        this._renderSlots();
    }

    pollSlotsIfDue(time = Date.now()) {
        this._pollSlotsIfDue(time);
    }

    _pollSlotsIfDue(time = Date.now()) {
        if (!this._slotPollingReady || this._indicator?.loginOnly || this._slotsBusy) return;
        const bucket = Math.floor(time / 900000);
        if (this._slotPollBucket === bucket) return;
        this._slotPollBucket = bucket;
        this._requestSlots('slots:list');
    }

    finishSessionCheck() {
        this._finishSessionCheck();
    }

    _finishSessionCheck() {
        if (
            !this._sessionSlotsCallback ||
            !this._sessionSlotResult ||
            !this._sessionEvaluationResult
        )
            return;
        const callback = this._sessionSlotsCallback;
        this._sessionSlotsCallback = null;
        if (this._sessionSlotsTimer) GLib.source_remove(this._sessionSlotsTimer);
        this._sessionSlotsTimer = 0;
        callback({
            ...this._sessionSlotResult,
            evaluations: this._sessionEvaluationResult.rows,
            evaluationError: this._sessionEvaluationResult.error,
        });
    }

    sessionSlotRequest(command, callback) {
        this._sessionSlotRequest(command, callback);
    }

    _sessionSlotRequest(command, callback) {
        this._sessionSlotsCallback = callback;
        this._sessionSlotResult = null;
        this._sessionEvaluationResult = command === 'slots:list' ? null : {};
        if (command === 'slots:list') {
            this._bridge.send('evaluations:check');
        }
        if (this._sessionSlotsTimer) GLib.source_remove(this._sessionSlotsTimer);
        this._sessionSlotsTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 65, () => {
            this._sessionSlotsTimer = 0;
            const pending = this._sessionSlotsCallback;
            this._sessionSlotsCallback = null;
            pending?.({
                ...this._sessionSlotResult,
                error:
                    this._sessionSlotResult?.error ||
                    (!this._sessionSlotResult ? 'Slot request timed out.' : null),
                evaluationError: 'Evaluation check timed out.',
            });
            return GLib.SOURCE_REMOVE;
        });
        this._slotsBusy = false;
        this._requestSlots(command);
    }

    requestSlots(command) {
        this._requestSlots(command);
    }

    _requestSlots(command, action = null) {
        if (this._slotsBusy) return;
        const flags =
            Me?.imports?.models?.featureFlags ||
            imports.misc.extensionUtils.getCurrentExtension().imports.models.featureFlags;
        if (command.startsWith('slots:open') && !flags.enabled(this._settings, 'hidden-auto-slots'))
            return;
        this._slotAction = action;
        this._slotCreating = command.startsWith('slots:create:');
        if (this._slotCreating) this._setCreateError(null);
        this._slotsBusy = true;
        this._slotsError = null;
        this._bridge.send(command);
        this._renderSlots();
    }

    renderSlots() {
        this._renderedSlots = null;
        this._renderSlots();
    }

    _renderSlots() {
        this._syncActionButtons();
        this._syncOptionalSectionsCallback?.();
        const indicator = this._indicator;
        if (!indicator) return;

        if (indicator.visitIntra) {
            CountLabel.update(
                indicator.visitIntra.get_child(),
                'Evaluation Slots',
                this._slots?.length || 0,
                this._slotsExpanded
            );
            indicator.visitIntra.style_class =
                'pingoose-visit-intra' + (this._slotsExpanded ? ' pingoose-toggle-active' : '');
        }

        const section = indicator.slotItems;
        if (!section) return;
        // Tab toggles and background polls must not rebuild unchanged actors.
        // Include every field used by a row or its close action; ignore server order.
        const rows = (this._slots || [])
            .map((row) => [String(row.id), row.ids || '', row.start, row.end, !!row.matched])
            .sort((a, b) => a[0].localeCompare(b[0]));
        const loading = this._slotsBusy && !this._slotsReady;
        const key = JSON.stringify([rows, loading, this._slotsError]);
        if (key === this._renderedSlots) return;
        this._renderedSlots = key;
        section.removeAll();
        this._actionButtons = [];
        this._createErrorLabel = null;
        this._creatorReveal = this._creatorItem = this._creatorButton = null;
        this._syncCreator = null;

        if (loading) {
            const loading = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
            const spinner =
                Me?.imports?.ui?.spinner ||
                imports.misc.extensionUtils.getCurrentExtension().imports.ui.spinner;
            loading.add_child(spinner.create(20));
            section.addMenuItem(loading);
            return;
        }

        if (this._slotsError) this._renderTextRow(section, this._slotsError, true);
        for (const slot of this._slots || []) this._renderSlotItem(slot, section);
        if (!this._slots?.length && !this._slotsError)
            this._renderTextRow(section, 'No open slots.');

        this._renderSlotsFooter(section);
        this._renderSlotCreator(section);
        if (this._slots?.some((row) => !row.matched)) this._renderCloseAllRow(section);
    }

    _setCreateError(error) {
        this._createError = error || null;
        if (!this._createErrorLabel) return;
        this._createErrorLabel.text = this._createError || '';
        this._createErrorLabel.visible = !!this._createError;
    }

    _trackActionButton(button, text, action) {
        // Keep the label's allocation while replacing its paint with a spinner.
        const content = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        const label = new St.Label({ text, x_align: Clutter.ActorAlign.CENTER });
        const spinner = Me.imports.ui.spinner.create(16);
        spinner.x_align = spinner.y_align = Clutter.ActorAlign.CENTER;
        content.add_child(label);
        content.add_child(spinner);
        button.set_child(content);
        button.accessible_name = text;
        this._actionButtons.push({ button, label, spinner, action });
        this._syncActionButtons();
    }

    _syncActionButtons() {
        for (const { button, label, spinner, action } of this._actionButtons || []) {
            const busy = this._slotsBusy && this._slotAction === action;
            spinner.visible = !!busy;
            label.opacity = busy ? 0 : 255;
            button.reactive = button.can_focus = !this._slotsBusy;
        }
    }

    _renderTextRow(section, text, error = false) {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        item.remove_all_children();
        item.set_style('padding: 6px 24px 6px 0;');
        const label = new St.Label({
            text,
            style_class: error ? 'pingoose-slot-label pingoose-slot-error' : 'pingoose-slot-label',
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        item.add_child(label);
        section.addMenuItem(item);
    }

    _renderSlotItem(slot, section) {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        item.remove_all_children();
        item.set_style('padding: 6px 24px 6px 0; spacing: 8px;');
        const format = (value) =>
            new Date(value).toLocaleString('en-GB', {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
            });
        const label = new St.Label({
            text: `${format(slot.start)} – ${format(slot.end)}`,
            x_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: slot.matched
                ? 'pingoose-slot-label pingoose-slot-matched'
                : 'pingoose-slot-label pingoose-profile-level',
        });
        label.clutter_text.line_wrap = true;
        item.add_child(label);

        const minutes = Math.max(
            0,
            Math.round((Date.parse(slot.end) - Date.parse(slot.start)) / 60000)
        );
        const duration = [
            [Math.floor(minutes / 1440), 'd'],
            [Math.floor((minutes % 1440) / 60), 'h'],
            [minutes % 60, 'm'],
        ]
            .filter(([v]) => v > 0)
            .map(([v, u]) => `${v} ${u}`)
            .join(' ');

        if (duration)
            item.add_child(
                new St.Label({
                    text: `(${duration})`,
                    style_class: 'pingoose-slot-duration',
                    y_align: Clutter.ActorAlign.CENTER,
                })
            );
        item.add_child(new St.Widget({ x_expand: true }));
        if (slot.matched) {
            item.add_child(
                new St.Label({
                    text: 'Evaluation Matched',
                    style_class: 'pingoose-slot-matched',
                    y_align: Clutter.ActorAlign.CENTER,
                })
            );
            section.addMenuItem(item);
            return;
        }
        const close = new St.Button({
            label: '×',
            can_focus: true,
            accessible_name: 'Close slot',
            style_class: 'pingoose-dismiss',
        });
        const action = `close:${slot.id}`;
        this._trackActionButton(close, '×', action);
        close.accessible_name = 'Close slot';
        close.connect('clicked', () => this._requestSlots(`slots:close:${slot.id}`, action));
        item.add_child(close);
        section.addMenuItem(item);
    }

    _renderSlotsFooter(section) {
        const footer = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        footer.remove_all_children();
        footer.set_style('padding: 6px 24px 6px 0; spacing: 6px;');

        const refresh = new St.Button({
            label: 'Refresh',
            can_focus: true,
            style_class: 'pingoose-clear-button',
        });
        this._trackActionButton(refresh, 'Refresh', 'refresh');
        refresh.connect('clicked', () => this._requestSlots('slots:list', 'refresh'));
        footer.add_child(refresh);

        const create = new St.Button({
            label: 'Create Slot',
            can_focus: true,
            style_class:
                'pingoose-clear-button' +
                (this._slotCreateExpanded ? ' pingoose-toggle-active' : ''),
        });
        this._creatorButton = create;
        create.connect('clicked', () => {
            this._setCreatorExpanded(!this._slotCreateExpanded);
        });
        footer.add_child(create);

        const flags =
            Me?.imports?.models?.featureFlags ||
            imports.misc.extensionUtils.getCurrentExtension().imports.models.featureFlags;
        if (flags?.enabled(this._settings, 'hidden-auto-slots')) {
            const auto = new St.Button({
                label: 'Auto Open',
                can_focus: true,
                style_class: 'pingoose-clear-button',
            });
            this._trackActionButton(auto, 'Auto Open', 'auto');
            auto.connect('clicked', () => this._requestSlots('slots:open-auto', 'auto'));
            footer.add_child(auto);
        }
        section.addMenuItem(footer);
    }

    _renderSlotCreator(section) {
        const schedule =
            Me?.imports?.models?.slotSchedule ||
            imports.misc.extensionUtils.getCurrentExtension().imports.models.slotSchedule;
        const format = (value) => {
            const d = new Date(value),
                pad = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        };
        const earliest = () => Math.ceil((Date.now() + 1800000) / 900000) * 900000;
        const labels = [];
        const sync = () => {
            if (!Number.isFinite(this._slotDraft?.begin) || this._slotDraft.begin < earliest()) {
                const begin = earliest();
                this._slotDraft = { begin, end: begin + 1800000 };
            }
            for (const { key, date, hour, minute } of labels) {
                const value = new Date(this._slotDraft[key]);
                date.text = `${String(value.getMonth() + 1).padStart(2, '0')}/${String(value.getDate()).padStart(2, '0')}`;
                hour.text = String(value.getHours()).padStart(2, '0') + ' h';
                minute.text = String(value.getMinutes()).padStart(2, '0') + ' m';
            }
        };

        const adjust = (key, delta) => {
            if (this._slotsBusy) return;
            this._setCreateError(null);
            const draft = this._slotDraft;
            const latest = Math.floor((Date.now() + 7 * 86400000) / 900000) * 900000;
            if (key === 'begin') {
                const duration = draft.end - draft.begin;
                draft.begin = Math.max(
                    earliest(),
                    Math.min(draft.begin + delta, latest - duration)
                );
                draft.end = draft.begin + duration;
            } else {
                draft.end = Math.max(draft.begin + 900000, Math.min(draft.end + delta, latest));
            }
            sync();
        };

        const cardItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        cardItem.remove_all_children();
        cardItem.set_style('padding: 6px 24px 6px 0;');
        const card = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'pingoose-slot-create-card',
        });
        const range = new St.BoxLayout({ x_expand: true, style_class: 'pingoose-slot-editor' });
        card.add_child(range);
        const reveal = new Me.imports.ui.reveal.Reveal(card);
        this._creatorReveal = reveal;
        this._creatorItem = cardItem;
        reveal.connect('notify::visible', () => {
            cardItem.visible = reveal.visible;
        });
        cardItem.add_child(reveal);
        section.addMenuItem(cardItem);

        for (const [key, label] of [
            ['begin', 'From'],
            ['end', 'Until'],
        ]) {
            if (key === 'end')
                range.add_child(
                    new St.Label({
                        text: '–',
                        style_class: 'pingoose-slot-range-divider',
                        y_align: Clutter.ActorAlign.CENTER,
                    })
                );
            const item = new St.BoxLayout({
                style_class: 'pingoose-slot-time-group',
                x_expand: true,
            });
            const parts = { key };
            for (const [part, delta, name] of [
                ['date', 86400000, 'day'],
                ['hour', 3600000, 'hour'],
                ['minute', 900000, '15 minutes'],
            ]) {
                const column = new St.BoxLayout({
                    vertical: true,
                    style_class:
                        part === 'date'
                            ? 'pingoose-slot-stepper pingoose-slot-date-stepper'
                            : 'pingoose-slot-stepper',
                    x_expand: true,
                });
                const up = new St.Button({
                    label: '▴',
                    can_focus: true,
                    accessible_name: `Increase ${label} ${name}`,
                    style_class: 'pingoose-slot-step-button',
                });
                const value = new St.Label({
                    text: '',
                    style_class: 'pingoose-slot-step-value pingoose-profile-level',
                    x_align: Clutter.ActorAlign.CENTER,
                });
                const down = new St.Button({
                    label: '▾',
                    can_focus: true,
                    accessible_name: `Decrease ${label} ${name}`,
                    style_class: 'pingoose-slot-step-button',
                });
                up.connect('clicked', () => adjust(key, delta));
                down.connect('clicked', () => adjust(key, -delta));
                column.add_child(up);
                column.add_child(value);
                column.add_child(down);
                item.add_child(column);
                parts[part] = value;
            }
            labels.push(parts);
            range.add_child(item);
        }
        sync();

        const errorLabel = new St.Label({
            x_expand: true,
            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
            style_class: 'pingoose-slot-error',
            style: 'max-width: 390px;',
        });
        errorLabel.clutter_text.line_wrap = true;
        errorLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        errorLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._createErrorLabel = errorLabel;
        card.add_child(errorLabel);
        this._setCreateError(this._createError);
        const actions = new St.BoxLayout({ x_expand: true });
        const submit = new St.Button({
            label: 'Create',
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            style_class: 'pingoose-clear-button',
        });
        this._trackActionButton(submit, 'Create', 'create');
        submit.connect('clicked', () => {
            if (this._slotsBusy) return;
            try {
                const payload = schedule.manual(
                    format(this._slotDraft.begin),
                    format(this._slotDraft.end)
                );
                const conflict = (this._slots || []).find(
                    (row) =>
                        Date.parse(row.start) < Date.parse(payload.end) &&
                        Date.parse(row.end) > Date.parse(payload.begin)
                );
                if (conflict)
                    throw new Error(
                        `Could not create slot:\nOverlaps ${format(conflict.start)} – ${format(conflict.end)}.`
                    );
                this._requestSlots('slots:create:' + JSON.stringify(payload), 'create');
            } catch (error) {
                this._setCreateError(error.message);
            }
        });
        actions.add_child(submit);
        card.add_child(actions);
        this._syncCreator = sync;
        this._setCreatorExpanded(this._slotCreateExpanded, false);
    }

    _renderCloseAllRow(section) {
        const closeRow = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        closeRow.remove_all_children();
        closeRow.set_style('padding: 6px 24px 6px 0;');
        const all = new St.Button({
            label: 'Close All Slots',
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            style_class: 'pingoose-clear-button',
        });
        this._trackActionButton(all, 'Close All Slots', 'close-all');
        all.connect('clicked', () => this._requestSlots('slots:all', 'close-all'));
        closeRow.add_child(all);
        section.addMenuItem(closeRow);
    }

    destroy() {
        if (this._sessionSlotsTimer) GLib.source_remove(this._sessionSlotsTimer);
        this._sessionSlotsTimer = 0;
        this._sessionSlotsCallback = null;
        if (this._visitIntraSignal && this._indicator?.visitIntra) {
            this._indicator.visitIntra.disconnect(this._visitIntraSignal);
            this._visitIntraSignal = 0;
        }
        this._unsubSlots?.();
        this._unsubEvalCheck?.();
        this._unsubStatus?.();
        this._slots = [];
    }
};

var SlotManager = Controller;
