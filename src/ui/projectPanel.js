const { Clutter, Gio, GLib, Meta, Pango, St } = imports.gi;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Notes = Me.imports.services.projectNotes;
const TextLayout = Me.imports.ui.noteTextLayout;
var ProjectPanel = class ProjectPanel {
    constructor(indicator, visit) {
        this.indicator = indicator;
        this.visit = visit;
        this.kind = 'todo';
        this.drafts = new Map();
        this.root = new St.BoxLayout({
            vertical: true,
            reactive: true,
            visible: false,
            y_expand: false,
            y_align: Clutter.ActorAlign.START,
            style_class: 'pingoose-chat-panel pingoose-project-panel',
        });
        indicator.sideColumns.insert_child_at_index(this.root, 0);
        const header = new St.BoxLayout({ style_class: 'pingoose-chat-header' });
        this.title = new St.Label({
            text: 'Project',
            x_expand: true,
            style_class: 'pingoose-heading',
        });
        this.title.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.title.clutter_text.line_wrap = true;
        this.title.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        header.add_child(this.title);
        const close = this.dismiss('Close project notes', () => {
            this.capture();
            this.expanded = false;
            this.sync();
        });
        close.accessible_name = 'Close project notes';
        header.add_child(close);
        this.root.add_child(header);
        this.root.add_child(new St.Widget({ style_class: 'pingoose-project-divider' }));
        const tabs = (this.tabs = new St.BoxLayout({ style_class: 'pingoose-chat-input-row' }));
        this.todoTab = this.button('TODO List', () => this.switchTab('todo'));
        this.noteTab = this.button('Note', () => this.switchTab('note'));
        tabs.add_child(this.todoTab);
        tabs.add_child(this.noteTab);
        this.root.add_child(tabs);
        const scroll = (this.listScroll = new St.ScrollView({
            overlay_scrollbars: false,
            y_expand: false,
            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
            style_class: 'pingoose-project-notes-scroll',
        }));
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this.list = new St.BoxLayout({
            vertical: true,
            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
            style_class: 'pingoose-project-note-list',
        });
        scroll.add_actor(this.list);
        this.root.add_child(scroll);
        this.list.connect('notify::allocation', () => this.syncListHeight());
        scroll.connect('notify::mapped', () => this.syncListHeight());
        scroll.connect('notify::width', () => this.syncListHeight());
        this.confirmation = new St.BoxLayout({
            vertical: true,
            visible: false,
            style_class: 'pingoose-project-note',
        });
        this.root.add_child(this.confirmation);
        this.add = this.button('Add Note', () => {
            this.editing = {};
            this.renderEditor();
        });
        this.root.add_child(this.add);
        this.input = new Me.imports.ui.noteEditor.Editor({
            onSave: () => this.save(),
            onCancel: () => {
                this.editing = null;
                this.drafts.delete(this.key());
                this.renderEditor();
            },
        });
        this.root.add_child(this.input.root);
        this.status = new St.Label({ text: '', style_class: 'pingoose-card-time' });
        this.status.clutter_text.line_wrap = true;
        this.status.hide();
        this.status.connect('notify::text', () => {
            this.status.visible = !!this.status.text;
        });
        this.root.add_child(this.status);
        this.visitButton = this.button('Visit Project Page', () => this.visit(this.project));
        this.root.add_child(this.visitButton);
        this.monitor = Notes.file().get_parent().monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this.monitor.connect('changed', (_monitor, file, other, event) => {
            if (![file?.get_basename(), other?.get_basename()].includes('projects.json')) return;
            if (
                ![
                    Gio.FileMonitorEvent.CHANGED,
                    Gio.FileMonitorEvent.CHANGES_DONE_HINT,
                    Gio.FileMonitorEvent.CREATED,
                    Gio.FileMonitorEvent.DELETED,
                    Gio.FileMonitorEvent.RENAMED,
                    Gio.FileMonitorEvent.MOVED_IN,
                    Gio.FileMonitorEvent.MOVED_OUT,
                ].includes(event)
            )
                return;
            if (this.refreshTimer) GLib.source_remove(this.refreshTimer);
            this.refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                this.refreshTimer = 0;
                if (this.project && this.root.visible) this.renderList();
                return GLib.SOURCE_REMOVE;
            });
        });
    }
    syncListHeight() {
        if (this.listHeightLater) return;
        this.listHeightLater = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
            this.listHeightLater = 0;
            if (!this.listScroll.mapped || this.list.width <= 0) return GLib.SOURCE_REMOVE;
            // ScrollView's unconstrained natural height misses soft wrapping.
            // Measure the cards at their allocated width after labels have grown.
            const [, contentHeight] = this.list.get_preferred_height(this.list.width);
            const height = Math.min(260, Math.ceil(contentHeight));
            if (Math.abs(this.listScroll.height - height) > 0.5) {
                this.listScroll.height = height;
                this.indicator.syncPanelLayout?.();
            }
            return GLib.SOURCE_REMOVE;
        });
    }
    fitWrappedLabel(label) {
        Me.imports.ui.selectableText.attach(label);
        label.request_mode = Clutter.RequestMode.HEIGHT_FOR_WIDTH;
        label.y_expand = false;
        let pending = 0;
        const fit = () => {
            if (pending) return;
            pending = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
                pending = 0;
                if (!label.mapped || label.width <= 0) return GLib.SOURCE_REMOVE;
                const node = label.get_theme_node();
                const box = node.get_content_box(
                    new Clutter.ActorBox({ x1: 0, y1: 0, x2: label.width, y2: label.height })
                );
                const height = TextLayout.measure(
                    label.clutter_text,
                    box.x2 - box.x1,
                    node.get_foreground_color()
                );
                const wanted = node.adjust_preferred_height(height, height)[1];
                if (Math.abs(label.height - wanted) > 0.5) label.height = wanted;
                this.syncListHeight();
                return GLib.SOURCE_REMOVE;
            });
        };
        label.connect('style-changed', () => {
            label.clutter_text._pingooseTextStyle = null;
            fit();
        });
        label.connect('notify::allocation', fit);
        label.connect('notify::mapped', fit);
        label.connect('destroy', () => {
            if (pending) Meta.later_remove(pending);
            pending = 0;
        });
        fit();
    }
    confirmDelete(title, action) {
        this.confirmation.destroy_all_children();
        this.confirmation.add_child(new St.Label({ text: title, style_class: 'pingoose-heading' }));
        this.confirmation.add_child(new St.Label({ text: 'This action cannot be undone.' }));
        const buttons = new St.BoxLayout({ style_class: 'pingoose-chat-input-row' });
        buttons.add_child(
            this.button('Cancel', () => {
                this.confirmation.hide();
            })
        );
        buttons.add_child(
            this.button('Delete', () => {
                this.confirmation.hide();
                action();
            })
        );
        this.confirmation.add_child(buttons);
        this.confirmation.show();
    }
    itemMenu(container, edit, remove) {
        const actions = new St.BoxLayout({
            visible: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            style_class: 'pingoose-chat-input-row',
        });
        actions.add_child(
            this.button('Edit', () => {
                actions.hide();
                edit();
            })
        );
        actions.add_child(
            this.button('Delete', () => {
                actions.hide();
                remove();
            })
        );
        container.add_child(actions);
        const toggle = new St.Button({
            label: '⋮',
            accessible_name: 'Item options',
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'pingoose-note-options',
        });
        toggle.connect('clicked', () => {
            actions.visible = !actions.visible;
        });
        return toggle;
    }
    dismiss(name, action) {
        const b = new St.Button({
            label: '×',
            accessible_name: name,
            can_focus: true,
            x_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'pingoose-dismiss',
        });
        b.connect('clicked', action);
        return b;
    }
    button(label, action) {
        const b = new St.Button({
            label,
            can_focus: true,
            x_expand: true,
            style_class: 'pingoose-visit-intra',
        });
        b.connect('clicked', action);
        return b;
    }
    key() {
        return this.project ? `${this.project.login}:${this.project.slug}:${this.kind}` : '';
    }
    capture() {
        if (this.project && this.editing)
            this.drafts.set(this.key(), {
                ...this.editing,
                ...this.input.value,
            });
    }
    open(project) {
        this.confirmation.hide();
        this.capture();
        if (
            this.expanded &&
            this.project?.slug === project.slug &&
            this.project?.login === project.login
        ) {
            this.expanded = false;
            this.sync();
            return;
        }
        this.kind = imports.misc.extensionUtils.getSettings().get_string('project-default-tab');
        this.tabs.set_child_at_index(this.kind === 'note' ? this.noteTab : this.todoTab, 0);
        this.project = project;
        this.visitButton.visible = project.slug !== '__my_projects__';
        this.expanded = true;
        this.indicator.bringPanelNearMain(this.root);
        this.title.text = project.slug === '__my_projects__' ? 'My Notes' : project.name;
        this.editing = this.drafts.get(this.key()) || null;
        this.renderList();
        this.renderEditor();
        this.sync();
    }
    switchTab(kind) {
        this.confirmation.hide();
        this.capture();
        this.kind = kind;
        this.editing = this.drafts.get(this.key()) || null;
        this.renderList();
        this.renderEditor();
    }
    sync() {
        this.root.visible = !!this.project && this.expanded && !this.indicator.loginOnly;
        this.indicator.syncProjectButtons?.(this.root.visible ? this.project?.slug : null);
        this.indicator.syncPanelLayout?.();
    }
    reset() {
        this.confirmation.hide();
        this.drafts.clear();
        this.project = null;
        this.editing = null;
        this.expanded = false;
        this.input.clear();
        this.list.destroy_all_children();
        this.renderKey = null;
        this.sync();
    }
    renderEditor() {
        this.input.update(this.kind, this.editing);
        this.add.visible = !this.editing;
        this.add.label = this.kind === 'todo' ? 'Add TODO List' : 'Add Note';
        this.status.text = '';
    }
    renderList() {
        this.todoTab.opacity = this.kind === 'todo' ? 255 : 150;
        this.noteTab.opacity = this.kind === 'note' ? 255 : 150;
        try {
            const rows = Notes.list().filter(
                (n) =>
                    n.project === this.project.slug &&
                    n.login === this.project.login &&
                    n.kind === this.kind
            );
            const key = JSON.stringify([this.key(), rows]);
            if (key === this.renderKey) return;
            this.renderKey = key;
            this.list.destroy_all_children();
            if (!rows.length)
                this.list.add_child(
                    new St.Label({
                        text:
                            this.kind === 'todo'
                                ? 'No tasks. Choose Add TODO List.'
                                : 'No saved notes. Choose Add Note.',
                    })
                );
            for (const note of rows) {
                if (note.kind === 'todo') {
                    note.body.split('\n').forEach((line, index) => {
                        if (!line.trim()) return;
                        const group = new St.BoxLayout({
                            vertical: true,
                            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
                            y_expand: false,
                            y_align: Clutter.ActorAlign.START,
                            style_class: 'pingoose-project-note pingoose-todo-card',
                        });
                        const row = new St.BoxLayout({
                            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
                            x_expand: true,
                            style_class: 'pingoose-todo-row',
                        });
                        group.add_child(row);
                        const done = /^\s*\[x\]/i.test(line);
                        const content = line.replace(/^\s*\[[ x]\]\s*/i, '');
                        const check = new St.Button({
                            label: done ? '☑' : '☐',
                            can_focus: true,
                            y_align: Clutter.ActorAlign.CENTER,
                            accessible_name: done ? 'Mark incomplete' : 'Mark complete',
                            style_class: 'pingoose-todo-check',
                        });
                        check.connect('clicked', () => {
                            const lines = note.body.split('\n');
                            lines[index] = `${done ? '[ ]' : '[x]'} ${content}`;
                            try {
                                Notes.save({ ...note, body: lines.join('\n') });
                                this.renderList();
                            } catch (_) {
                                this.status.text = 'Unable to save. Please retry.';
                            }
                        });
                        row.add_child(check);
                        const label = new St.Label({
                            text: content,
                            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
                            y_align: Clutter.ActorAlign.CENTER,
                            x_expand: true,
                        });
                        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                        label.clutter_text.line_wrap = true;
                        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
                        label.style_class = 'pingoose-todo-text';
                        this.fitWrappedLabel(label);
                        row.add_child(label);
                        row.add_child(
                            this.itemMenu(
                                group,
                                () => {
                                    this.editing = {
                                        ...note,
                                        body: content,
                                        taskIndex: index,
                                        taskDone: done,
                                    };
                                    this.renderEditor();
                                },
                                () =>
                                    this.confirmDelete('Delete this task?', () => {
                                        try {
                                            const lines = note.body
                                                .split('\n')
                                                .filter((_line, i) => i !== index);
                                            if (lines.some((value) => value.trim()))
                                                Notes.save({ ...note, body: lines.join('\n') });
                                            else Notes.remove(note.id);
                                            this.renderList();
                                        } catch (_) {
                                            this.status.text = 'Unable to delete. Please retry.';
                                        }
                                    })
                            )
                        );
                        this.list.add_child(group);
                    });
                    continue;
                }
                const card = new St.BoxLayout({
                    vertical: true,
                    request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
                    y_expand: false,
                    y_align: Clutter.ActorAlign.START,
                    style_class: 'pingoose-project-note',
                });
                const heading = new St.BoxLayout({ style_class: 'pingoose-chat-header' });
                const title = new St.Label({
                    text: note.title,
                    x_expand: true,
                    style_class: 'pingoose-profile-level',
                });
                title.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                title.clutter_text.line_wrap = true;
                title.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
                this.fitWrappedLabel(title);
                heading.add_child(title);
                card.add_child(heading);
                heading.add_child(
                    this.itemMenu(
                        card,
                        () => {
                            this.editing = { ...note };
                            this.renderEditor();
                        },
                        () =>
                            this.confirmDelete('Delete this note?', () => {
                                try {
                                    Notes.remove(note.id);
                                    if (this.editing?.id === note.id) {
                                        this.editing = null;
                                        this.renderEditor();
                                    }
                                    for (const [key, draft] of this.drafts)
                                        if (draft.id === note.id) this.drafts.delete(key);
                                    this.renderList();
                                    this.status.text = 'Note deleted.';
                                } catch (_) {
                                    this.status.text = 'Unable to delete. Please retry.';
                                }
                            })
                    )
                );
                const text = new St.Label({ text: note.body, style_class: 'pingoose-note-body' });
                text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                text.clutter_text.line_wrap = true;
                text.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
                this.fitWrappedLabel(text);
                card.add_child(text);
                this.list.add_child(card);
            }
            this.syncListHeight();
        } catch (_) {
            this.status.text = 'Unable to read saved notes.';
        }
    }
    save() {
        try {
            let body = this.input.value.body;
            if (Number.isInteger(this.editing?.taskIndex)) {
                const current = Notes.list().find((note) => note.id === this.editing.id);
                if (!current || !body.trim()) throw new Error('Task unavailable');
                const lines = current.body.split('\n');
                lines.splice(
                    this.editing.taskIndex,
                    1,
                    ...body
                        .split('\n')
                        .map((line) => `${this.editing.taskDone ? '[x]' : '[ ]'} ${line}`)
                );
                body = lines.join('\n');
            }
            Notes.save({
                ...this.editing,
                project: this.project.slug,
                projectName: this.project.name,
                login: this.project.login,
                kind: this.kind,
                title: this.kind === 'todo' ? '' : this.input.value.title.trim() || 'Untitled',
                body,
            });
            this.editing = null;
            this.drafts.delete(this.key());
            this.renderList();
            this.renderEditor();
            this.status.text = 'Saved locally.';
        } catch (_) {
            this.status.text =
                this.kind === 'todo'
                    ? 'Enter at least one task and retry.'
                    : 'Enter some content and retry.';
        }
    }
    close() {
        this.capture();
        this.expanded = false;
        this.sync();
    }

    destroy() {
        this.input.destroy();
        if (this.listHeightLater) Meta.later_remove(this.listHeightLater);
        this.listHeightLater = 0;
        if (this.refreshTimer) GLib.source_remove(this.refreshTimer);
        this.refreshTimer = 0;
        this.monitor.cancel();
        this.drafts.clear();
    }
};
