const { Clutter, Gio, GLib, Meta, Pango, St } = imports.gi;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;

var Controller = class Controller {
    constructor(indicator, bridge, settings, options = {}) {
        this._indicator = indicator;
        this._bridge = bridge;
        this._settings = settings;
        this._chatPanel = options.chatPanel || null;
        this._optionsManager = options.optionsManager || null;
        this._syncOptionalSectionsCallback = options.onVisibilitySync || null;
        this._saveCardStateCallback = options.onSaveCardState || null;

        this._evaluations = [];
        this._feedback = {};
        this._evaluationTimes = new Map();
        this._evaluationActors = new Map();
        this._evaluationKey = null;
        this._evaluationScrollRestore = 0;
        this._evaluationScrollPosition = null;

        if (this._bridge) {
            this._unsubEvals = this._bridge.on('evaluations', (msg) =>
                this.onEvaluationsMessage(msg)
            );
            this._unsubDismissed = this._bridge.on('evaluation-dismissed', (msg) =>
                this.onEvaluationDismissedMessage(msg)
            );
        }
    }

    get evaluations() {
        return this._evaluations;
    }
    get feedback() {
        return this._feedback;
    }

    onEvaluationsMessage(message) {
        if (!Array.isArray(message.rows) || message.rows.length > 10000) return;
        this._evaluations = [...message.rows, ...this._evaluations.filter((row) => row.devTest)];
        this._renderEvaluations();
        this._chatPanel?.updateEvaluations(this._evaluations);
    }

    onEvaluationDismissedMessage(message) {
        if (typeof message.id === 'string') {
            delete this._feedback[message.id];
            this._renderEvaluations();
        }
    }

    restoreTests(rows) {
        this._evaluations = [...this._evaluations.filter((row) => !row.devTest), ...rows];
    }

    addTest(row) {
        this._evaluations.push(row);
        this._saveCardStateCallback?.();
        this._renderEvaluations();
    }

    clear() {
        this._evaluations = [];
        this._feedback = {};
        this._evaluationTimes = new Map();
        this._evaluationActors = new Map();
        this._evaluationKey = null;
        this._renderEvaluations();
    }

    renderEvaluations(changedId = null) {
        this._renderEvaluations(changedId);
    }

    _evaluationRelativeTime(begin, now = Date.now()) {
        const delta = Date.parse(begin) - now;
        if (!Number.isFinite(delta)) return '';
        const minutes = delta > 0 ? Math.ceil(delta / 60000) : Math.floor(-delta / 60000);
        const days = Math.floor(minutes / 1440);
        const hours = Math.floor((minutes % 1440) / 60);
        const remainder = minutes % 60;
        const parts = [];
        if (days) parts.push(`${days} d`);
        if (hours) parts.push(`${hours} h`);
        if (remainder || !parts.length) parts.push(`${remainder} m`);
        return `(${parts.join(' ')} ${delta > 0 ? 'remain' : 'ago'})`;
    }

    _renderEvaluations(changedId = null) {
        const rows = this._evaluations || [];
        this._chatPanel?.updateEvaluations(rows);
        const now = Date.now();
        for (const { actor, begin } of this._evaluationTimes?.values() || []) {
            const text = this._evaluationRelativeTime(begin, now);
            if (actor.text !== text) actor.text = text;
        }
        this._syncOptionalSectionsCallback?.();

        const key = JSON.stringify([
            rows,
            this._indicator?.lastProfile?.name,
            this._feedback,
            rows.map((row) =>
                (row.users || []).map((login) => !!this._chatPanel?.canEvaluation(row, login))
            ),
            rows.map((row) => [
                Date.parse(row.begin) <= Date.now(),
                Date.parse(row.begin) - Date.now() <= 899000,
            ]),
        ]);
        if (key === this._evaluationKey) return;
        this._evaluationKey = key;

        const section = this._indicator?.evaluations;
        if (!section) return;

        const existing = changedId && this._evaluationActors?.get(changedId);
        if (existing) this._indicator?.evaluationScroll?.grab_key_focus();
        const adjustment = this._indicator?.evaluationScroll?.get_vscroll_bar().get_adjustment();
        const scrollPosition = this._evaluationScrollPosition ?? adjustment?.value ?? 0;
        if (this._evaluationScrollRestore) Meta.later_remove(this._evaluationScrollRestore);
        this._evaluationScrollRestore = 0;
        if (adjustment && !existing) {
            this._evaluationScrollPosition = scrollPosition;
            this._evaluationScrollRestore = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
                this._evaluationScrollRestore = 0;
                adjustment.value = Math.max(
                    adjustment.lower,
                    Math.min(scrollPosition, adjustment.upper - adjustment.page_size)
                );
                this._evaluationScrollPosition = null;
                return GLib.SOURCE_REMOVE;
            });
        }
        if (!existing) {
            section.removeAll();
            this._evaluationActors = new Map();
            this._evaluationTimes = new Map();
        }
        if (!rows.length) return;

        for (const row of rows) {
            if (existing && row.id !== changedId) continue;
            this._renderEvaluationCard(row, existing, section, now);
        }
    }

    _renderEvaluationCard(row, existing, section, now) {
        const item =
            existing || new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        item.remove_all_children();
        item.set_style('padding: 6px 0; spacing: 0;');
        const box = new St.BoxLayout({
            vertical: true,
            x_expand: false,
            x_align: Clutter.ActorAlign.START,
            style_class: 'pingoose-evaluation-card',
        });

        const addLabel = (text, style_class = '') => {
            const actor = new St.Label({ text, style_class });
            actor.clutter_text.line_wrap = true;
            actor.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            box.add_child(actor);
            return actor;
        };
        addLabel(
            `${row.project || 'Evaluation'}: ${['evaluator', 'corrector'].includes(row.kind) ? 'Evaluator' : 'Evaluatee'}`,
            'pingoose-evaluation-title'
        );
        if (row.missing)
            addLabel(
                'Evaluation Missing · This match is no longer listed.',
                'pingoose-evaluation-title'
            );

        for (const login of row.users?.length ? row.users : [null]) {
            this._renderCounterpart(login, row, box);
        }
        this._renderFeedbackControls(row, box, now, addLabel);

        item.add_child(box);
        if (!existing) section.addMenuItem(item);
        this._evaluationActors.set(row.id, item);
    }

    _renderCounterpart(login, row, box) {
        const person = new St.BoxLayout({ style_class: 'pingoose-evaluation-person' });
        const avatar = new St.Bin({
            width: 52,
            height: 52,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'pingoose-avatar pingoose-counterpart-avatar',
        });
        let image = new St.Icon({ icon_name: 'avatar-default-symbolic', icon_size: 34 });
        if (login && row.avatars?.includes(login) && /^[a-zA-Z0-9_-]{1,64}$/.test(login)) {
            const file = Gio.File.new_for_path(
                GLib.build_filenamev([
                    GLib.get_user_state_dir(),
                    'pingoose',
                    row.devTest && row.devSelf && login === GLib.get_user_name()
                        ? 'profile-avatar'
                        : `counterpart-${login}`,
                ])
            );
            if (file.query_exists(null)) {
                avatar.set_style(
                    `background-image: url("${file.get_uri()}"); background-size: cover;`
                );
                image = null;
            }
        }
        avatar.set_child(image);
        person.add_child(avatar);

        const details = new St.BoxLayout({
            vertical: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'pingoose-person-details',
        });
        if (login) {
            const profileLink = (caption, style) => {
                const button = new St.Button({
                    label: caption,
                    can_focus: true,
                    x_align: Clutter.ActorAlign.START,
                    style_class: style,
                });
                const menu = new PopupMenu.PopupMenu(button, 1.0, St.Side.TOP);
                imports.ui.main.uiGroup.add_child(menu.actor);
                menu.actor.hide();
                this._optionsManager ||= new PopupMenu.PopupMenuManager(this._indicator);
                this._optionsManager.addMenu(menu);
                menu.addAction('Visit Profile Page', () => {
                    this._indicator?.menu.close();
                    const payload = JSON.stringify({
                        name: login,
                        url: 'https://profile.intra.42.fr/users/' + encodeURIComponent(login),
                    });
                    this._bridge.send('service:open:' + payload);
                });
                const parentSignal = this._indicator?.menu.connect(
                    'open-state-changed',
                    (_menu, open) => {
                        if (!open) menu.close();
                    }
                );
                button.connect('destroy', () => {
                    this._indicator?.menu.disconnect(parentSignal);
                    this._optionsManager?.removeMenu(menu);
                    menu.destroy();
                });
                button.connect('clicked', () => menu.toggle());
                return button;
            };
            const fullName =
                row.names?.[login] ||
                (this._indicator?.lastProfile?.login === login
                    ? this._indicator?.lastProfile.name
                    : null);
            details.add_child(
                profileLink(
                    fullName || 'Loading name…',
                    'pingoose-counterpart-link pingoose-counterpart-name'
                )
            );
            const identityLine = new St.BoxLayout({
                style_class: 'pingoose-counterpart-identity',
                y_align: Clutter.ActorAlign.CENTER,
            });
            identityLine.add_child(
                profileLink('@' + login, 'pingoose-counterpart-link pingoose-counterpart-nick')
            );
            identityLine.add_child(
                new St.Label({
                    text: row.seats?.[login] || 'Unavailable',
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: 'pingoose-person-seat',
                })
            );
            details.add_child(identityLine);
        } else {
            details.add_child(
                new St.Label({ text: 'Awaiting match', style_class: 'pingoose-person-login' })
            );
            details.add_child(
                new St.Label({ text: 'Unavailable', style_class: 'pingoose-person-seat' })
            );
        }
        person.add_child(details);
        box.add_child(person);

        if (login && this._chatPanel?.canEvaluation(row, login)) {
            const available = !!this._chatPanel.canEvaluation(row, login);
            const chat = new St.Button({
                label: available ? 'Cluster Chat' : 'Cluster Chat · Unavailable',
                reactive: available,
                can_focus: available,
                opacity: available ? 255 : 110,
                x_expand: true,
                style_class: 'pingoose-visit-intra',
            });
            chat.connect('clicked', () => this._chatPanel.openEvaluation(row, login));
            box.add_child(chat);
        }
    }

    _renderFeedbackControls(row, box, now, addLabel) {
        const timeRow = new St.BoxLayout({ style: 'spacing: 6px;' });
        timeRow.add_child(
            new St.Label({
                text: `Starts · ${new Date(row.begin).toLocaleString('en-GB')}`,
                style_class: 'pingoose-evaluation-time pingoose-agenda-emphasis',
            })
        );
        const timeLabel = new St.Label({
            text: this._evaluationRelativeTime(row.begin, now),
            style_class: 'pingoose-evaluation-time',
        });
        timeRow.add_child(timeLabel);
        box.add_child(timeRow);
        this._evaluationTimes.set(row.id, { actor: timeLabel, begin: row.begin });

        let actionRow = box;
        const paired =
            (row.missing && this._feedback[row.id] === 'missing-confirm') ||
            (Date.parse(row.begin) <= Date.now() &&
                ['confirm', 'later'].includes(this._feedback[row.id]));
        const addButton = (text, action) => {
            const control = new St.Button({
                can_focus: true,
                x_expand: true,
                style_class: paired
                    ? 'pingoose-feedback-button pingoose-feedback-half'
                    : 'pingoose-feedback-button',
            });
            const caption = new St.Label({
                text,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            caption.clutter_text.line_wrap = true;
            caption.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            caption.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            control.set_child(caption);
            control.connect('clicked', action);
            actionRow.add_child(control);
        };

        const evaluator = ['evaluator', 'corrector'].includes(row.kind);
        const question = evaluator
            ? 'Has the evaluation ended?'
            : 'Have you submitted your evaluation feedback?';
        const step = (value) => {
            this._feedback[row.id] = value;
            this._renderEvaluations(row.id);
        };

        if (row.missing) {
            if (this._feedback[row.id] === 'missing-confirm') {
                addLabel('Is this evaluation really missing?', 'pingoose-feedback-question');
                actionRow = new St.BoxLayout({
                    style_class: 'pingoose-feedback-actions',
                    x_expand: true,
                });
                box.add_child(actionRow);
                addButton('Yes', () => {
                    const cmd = `feedback:${row.id}`;
                    this._bridge.send(cmd);
                });
                addButton('Later', () => step(null));
            } else {
                addButton('Remove Evaluation', () => step('missing-confirm'));
            }
        } else if (Date.parse(row.begin) <= Date.now()) {
            if (this._feedback[row.id] === 'confirm') {
                addLabel(question, 'pingoose-feedback-question');
                actionRow = new St.BoxLayout({
                    style_class: 'pingoose-feedback-actions',
                    x_expand: true,
                });
                box.add_child(actionRow);
                addButton('Yes', () => {
                    if (!row.devTest) {
                        const cmd = `feedback:${row.id}`;
                        this._bridge.send(cmd);
                        return;
                    }
                    this._evaluations = this._evaluations.filter((item) => item.id !== row.id);
                    delete this._feedback[row.id];
                    if (this._saveCardStateCallback) this._saveCardStateCallback();
                    else if (this._saveCardState) this._saveCardState();
                    this._renderEvaluations();
                });
                addButton('Not yet', () => step(evaluator ? null : 'later'));
            } else if (this._feedback[row.id] === 'later') {
                actionRow = new St.BoxLayout({
                    style_class: 'pingoose-feedback-actions',
                    x_expand: true,
                });
                box.add_child(actionRow);
                addButton('Open Project', () => {
                    const profile = this._indicator?.lastProfile;
                    const slug =
                        row.slug ||
                        profile?.projects?.find(
                            (p) => p.name.toLowerCase() === row.project.toLowerCase()
                        )?.slug;
                    if (!slug || !profile?.login) {
                        Main.notify(
                            'Pingoose',
                            'Project link unavailable. Open Intra to submit your feedback.'
                        );
                        return;
                    }
                    try {
                        Gio.AppInfo.launch_default_for_uri(
                            `https://projects.intra.42.fr/${encodeURIComponent(slug)}/${encodeURIComponent(profile.login)}`,
                            global.create_app_launch_context(0, -1)
                        );
                    } catch (_) {
                        Main.notify('Pingoose', 'Unable to open the project.');
                    }
                });
                addButton('Later', () => step(null));
            } else {
                addButton(question, () => step('confirm'));
            }
        }
    }

    destroy() {
        if (this._evaluationScrollRestore) Meta.later_remove(this._evaluationScrollRestore);
        this._evaluationScrollRestore = 0;
        this._evaluationScrollPosition = null;
        this._unsubEvals?.();
        this._unsubDismissed?.();
        this._evaluations = [];
        this._feedback = {};
        this._evaluationTimes?.clear();
        this._evaluationActors?.clear();
    }
};

var EvaluationManager = Controller;
