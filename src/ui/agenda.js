const { Clutter, GLib, Meta, Pango, St } = imports.gi;
const PopupMenu = imports.ui.popupMenu;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Agenda = Me.imports.models.agenda;

var Controller = class Controller {
    constructor(indicator, bridge, settings, options = {}) {
        this._indicator = indicator;
        this._bridge = bridge;
        this._settings = settings;
        this._optionsManager = options.optionsManager || null;
        this._syncOptionalSectionsCallback = options.onVisibilitySync || null;

        this._agenda = [];
        this._agendaAll = [];
        this._dismissedAgendaIds = new Set(this._settings?.get_strv('dismissed-agenda-ids') || []);
        this._agendaBusy = null;
        this._agendaActionStatus = null;
        this._agendaExpanded = new Set();
        this._agendaTimes = [];
        this._agendaScrollRestore = 0;
        this._agendaScrollPosition = null;

        this._onSnapshot = options.onSnapshot || (() => {});
        this._settingsSignals = [
            settings.connect('changed::dismissed-agenda-ids', () => this.reloadDismissed()),
            settings.connect('changed::agenda-reset-request', () => {
                this.restoreAgenda();
                this._bridge.send('agenda:refresh');
            }),
        ];
        if (this._bridge) {
            this._unsubAgenda = this._bridge.on('agenda', (msg) => this.onAgendaMessage(msg));
            this._unsubAction = this._bridge.on('agenda-action', (msg) =>
                this.onAgendaActionMessage(msg)
            );
        }
    }

    get agenda() {
        return this._agenda;
    }
    get agendaAll() {
        return this._agendaAll;
    }
    get dismissedAgendaIds() {
        return this._dismissedAgendaIds;
    }

    onAgendaMessage(message) {
        if (!Array.isArray(message.rows) || message.rows.length > 100) return;
        this._onSnapshot(message.rows, message.subject);
        this._agendaAll = [
            ...message.rows,
            ...(this._agendaAll || this._agenda).filter((row) => row.devTest),
        ];
        this._agenda = this._agendaAll.filter(
            (row) => !this._dismissedAgendaIds?.has(String(row.id))
        );
        this._renderAgenda();
    }

    onAgendaActionMessage(message) {
        this._agendaBusy = null;
        this._agendaActionStatus = { id: message.id, text: message.error || '' };
        this._renderAgenda();
    }

    reloadDismissed() {
        this._dismissedAgendaIds = new Set(this._settings.get_strv('dismissed-agenda-ids'));
        this._agenda = this._agendaAll.filter(
            (row) => !this._dismissedAgendaIds.has(String(row.id))
        );
        this._renderAgenda();
    }

    addTest(row) {
        this._agendaAll.push(row);
        this._agenda.push(row);
        this._renderAgenda();
    }

    closeDetails() {
        this._agendaExpanded.clear();
        this._renderAgenda();
    }

    clear() {
        this._agendaBusy = null;
        this._agendaActionStatus = null;
        this._agendaExpanded = new Set();
        this._agenda = [];
        this._agendaAll = [];
        this._dismissedAgendaIds = new Set(this._settings?.get_strv('dismissed-agenda-ids') || []);
        this._renderAgenda();
    }

    updateAgendaTimes() {
        this._updateAgendaTimes();
    }

    _updateAgendaTimes() {
        for (const { label, row } of this._agendaTimes || []) {
            label.text = Agenda.agendaSummary(row).slice(11);
        }
    }

    renderAgenda() {
        this._renderAgenda();
    }

    _renderAgenda() {
        this._agendaTimes = [];
        this._syncOptionalSectionsCallback?.();

        const scroll = this._indicator?.agendaScroll;
        const adjustment = scroll?.get_vscroll_bar().get_adjustment();
        const position = this._agendaScrollPosition ?? adjustment?.value ?? 0;
        if (this._agendaScrollRestore) Meta.later_remove(this._agendaScrollRestore);
        this._agendaScrollRestore = 0;
        if (adjustment) {
            this._agendaScrollPosition = position;
            this._agendaScrollRestore = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
                this._agendaScrollRestore = 0;
                adjustment.value = Math.max(
                    adjustment.lower,
                    Math.min(position, adjustment.upper - adjustment.page_size)
                );
                this._agendaScrollPosition = null;
                return GLib.SOURCE_REMOVE;
            });
        }

        const section = this._indicator?.agenda;
        if (!section) return;
        section.removeAll();
        if (!this._agenda?.length) return;

        for (const row of this._agenda) {
            this._renderAgendaCard(row, section, adjustment);
        }
    }

    _renderAgendaCard(row, section, adjustment) {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        item.remove_all_children();
        item.set_style('padding: 6px 0; spacing: 0;');

        const box = new St.BoxLayout({
            vertical: true,
            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
            x_expand: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
            style_class: 'pingoose-evaluation-card pingoose-agenda-card',
        });

        const heading = new St.BoxLayout({
            vertical: true,
            style_class: 'pingoose-agenda-heading-group',
        });
        box.add_child(heading);
        this._renderAgendaHeader(row, heading);

        const summaryRow = new St.BoxLayout({ style_class: 'pingoose-agenda-summary' });
        const summaryText = Agenda.agendaSummary(row);
        summaryRow.add_child(
            new St.Label({
                text: summaryText.slice(0, 10),
                style_class: 'pingoose-agenda-emphasis',
            })
        );
        const summary = new St.Label({
            text: summaryText.slice(11),
            style_class: 'pingoose-agenda-detail',
        });
        summaryRow.add_child(summary);
        heading.add_child(summaryRow);
        this._agendaTimes.push({ label: summary, row });

        const feedbackUrl = row.feedback ? Agenda.agendaFeedbackUrl(row.id) : null;
        if (feedbackUrl) {
            const feedback = new St.Button({
                label: 'Write Feedback',
                can_focus: true,
                x_expand: true,
                style_class: 'pingoose-feedback-button',
            });
            feedback.connect('clicked', () => {
                this._indicator.menu.close();
                const ext = imports.misc.extensionUtils.getCurrentExtension();
                const LinkOpener = ext.imports.services?.linkOpener;
                if (LinkOpener) {
                    LinkOpener.openLink(this._settings, this._bridge, {
                        name: row.name.slice(0, 80),
                        url: feedbackUrl,
                    });
                } else {
                    this._bridge.send(
                        'service:open:' +
                            JSON.stringify({
                                name: row.name.slice(0, 80),
                                url: feedbackUrl,
                            })
                    );
                }
            });
            box.add_child(feedback);
        }

        const expanded = this._agendaExpanded?.has(row.id);
        const more = new St.Button({
            label: 'Details',
            can_focus: true,
            style_class: 'pingoose-clear-button' + (expanded ? ' pingoose-toggle-active' : ''),
        });
        box.add_child(more);

        const details = new St.BoxLayout({
            vertical: true,
            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
            x_expand: true,
            y_expand: false,
            visible: !!expanded,
            style_class: 'pingoose-agenda-details',
        });
        const reveal = new Me.imports.ui.reveal.Reveal(details);
        box.add_child(reveal);
        reveal.setExpanded(!!expanded, false);

        more.connect('clicked', () => {
            this._agendaExpanded ||= new Set();
            if (this._agendaExpanded.has(row.id)) this._agendaExpanded.delete(row.id);
            else this._agendaExpanded.add(row.id);
            reveal.setExpanded(this._agendaExpanded.has(row.id));
            more.style_class =
                'pingoose-clear-button' + (reveal.expanded ? ' pingoose-toggle-active' : '');
        });

        this._renderAgendaDetails(row, details, adjustment);
        item.add_child(box);
        section.addMenuItem(item);
    }

    _renderAgendaHeader(row, heading) {
        const header = new St.BoxLayout({ x_expand: true });
        const title = new St.Label({
            text: row.name,
            x_expand: true,
            style_class: 'pingoose-evaluation-title',
        });
        title.clutter_text.line_wrap = true;
        title.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        header.add_child(title);

        if (row.feedback || row.subscribed) {
            header.add_child(
                new St.Label({
                    text: row.feedback ? 'Feedback required' : 'Registered',
                    style_class: row.feedback
                        ? 'pingoose-agenda-feedback-required'
                        : 'pingoose-agenda-subscribed',
                    y_align: Clutter.ActorAlign.CENTER,
                })
            );
        }

        const remove = new St.Button({
            label: '⋮',
            accessible_name: 'Agenda options',
            can_focus: true,
            style_class: 'pingoose-note-options',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const options = new PopupMenu.PopupMenu(remove, 1.0, St.Side.TOP);
        imports.ui.main.uiGroup.add_child(options.actor);
        options.actor.hide();
        this._optionsManager ||= new PopupMenu.PopupMenuManager(this._indicator);
        this._optionsManager.addMenu(options);
        options.addAction('Hide Agenda', () => {
            options.close();
            this._hideAgenda(row);
        });

        const parentSignal = this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (!open) options.close();
        });
        remove.connect('destroy', () => {
            this._indicator.menu.disconnect(parentSignal);
            this._optionsManager?.removeMenu(options);
            options.destroy();
        });
        remove.connect('clicked', () => options.toggle());
        header.add_child(remove);
        heading.add_child(header);
    }

    _renderAgendaDetails(row, details, adjustment) {
        const text = (value, emphasized = false) => {
            const label = new St.Label({
                text: value,
                width: 392,
                x_expand: true,
                y_expand: false,
                request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
                style_class:
                    'pingoose-agenda-detail' + (emphasized ? ' pingoose-agenda-emphasis' : ''),
            });
            label.clutter_text.line_wrap = true;
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            details.add_child(label);
            return label;
        };

        text(
            `${new Date(row.begin).toLocaleString('en-GB')} – ${new Date(row.end).toLocaleString('en-GB')}`,
            true
        );
        if (row.location) text(`Location: ${row.location}`, true);
        text(
            `Registered: ${row.subscribers ?? 'Unknown'} / ${row.capacity > 0 ? row.capacity : row.capacity === null || row.capacity === undefined ? 'Unknown' : 'Unlimited'}`,
            true
        );
        if (row.unsubscriptionDelay > 0) {
            text(
                `Cancellation deadline: ${new Date(Date.parse(row.begin) - row.unsubscriptionDelay * 3600000).toLocaleString('en-GB')}`
            );
        }
        if (row.description) text(row.description);
        if (row.kind === 'exam')
            text('Register for both the exam session and the exam project to attend.');
        if (this._agendaActionStatus?.id === row.id && this._agendaActionStatus.text)
            text(this._agendaActionStatus.text);

        const action = row.subscribed ? 'unsubscribe' : 'subscribe';
        if (Agenda.agendaAction(row, action)) {
            const busy = this._agendaBusy === row.id;
            const button = new St.Button({
                label: busy ? 'Updating…' : row.subscribed ? 'Unsubscribe' : 'Subscribe',
                reactive: !this._agendaBusy,
                can_focus: !this._agendaBusy,
                style_class:
                    'pingoose-clear-button ' +
                    (row.subscribed ? 'pingoose-agenda-unsubscribe' : 'pingoose-agenda-subscribe'),
            });
            button.connect('clicked', () => {
                if (this._agendaBusy) return;
                if (adjustment) this._agendaScrollPosition = adjustment.value;
                this._agendaBusy = row.id;
                this._agendaActionStatus = null;
                const cmd = `agenda:${action}:${row.id}`;
                this._bridge.send(cmd);
                button.label = 'Updating…';
                button.reactive = false;
            });
            const footer = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_expand: false,
                style_class: 'pingoose-agenda-actions',
            });
            footer.add_child(button);
            details.add_child(footer);
        }
    }

    _hideAgenda(row) {
        const adjustment = this._indicator?.agendaScroll?.get_vscroll_bar().get_adjustment();
        if (adjustment) this._agendaScrollPosition = adjustment.value;
        this._indicator?.agendaScroll?.grab_key_focus();
        this._dismissedAgendaIds ||= new Set();
        if (row.devTest) {
            this._agendaAll = (this._agendaAll || []).filter((item) => item.id !== row.id);
            this._dismissedAgendaIds.delete(String(row.id));
        } else {
            this._dismissedAgendaIds.add(String(row.id));
        }
        this._agenda = this._agenda.filter((item) => item.id !== row.id);
        this._settings?.set_strv('dismissed-agenda-ids', [...this._dismissedAgendaIds]);
        this._renderAgenda();
    }

    restoreAgenda() {
        this._restoreAgenda();
    }

    _restoreAgenda() {
        this._settings?.set_strv('dismissed-agenda-ids', []);
        this._dismissedAgendaIds = new Set();
        this._agenda = [...(this._agendaAll || [])];
        this._renderAgenda();
    }

    destroy() {
        if (this._agendaScrollRestore) Meta.later_remove(this._agendaScrollRestore);
        this._agendaScrollRestore = 0;
        this._agendaScrollPosition = null;
        this._unsubAgenda?.();
        this._unsubAction?.();
        for (const signal of this._settingsSignals || []) this._settings.disconnect(signal);
        this._agenda = [];
        this._agendaAll = [];
        this._agendaTimes = [];
    }
};

var AgendaManager = Controller;
