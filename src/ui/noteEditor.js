const { Clutter, GLib, Meta, Pango, St } = imports.gi;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const TextLayout = Me.imports.ui.noteTextLayout;

// Owns the multiline input actors, keyboard handling and caret scroll lifecycle.
var Editor = class Editor {
    constructor({ onSave, onCancel }) {
        this.kind = 'todo';
        this.root = new St.BoxLayout({
            vertical: true,
            visible: false,
            style_class: 'pingoose-project-note-list',
        });
        this.name = new St.Entry({
            hint_text: 'Title',
            can_focus: true,
            x_align: Clutter.ActorAlign.START,
            style_class: 'pingoose-chat-entry',
        });
        this.name.clutter_text.max_length = 120;
        this.name.set_style('width: 278px;');
        this.body = new St.Entry({
            hint_text: 'Notes',
            can_focus: true,
            style_class: 'pingoose-chat-entry pingoose-note-editor',
        });
        const text = this.body.clutter_text;
        text.set_single_line_mode(false);
        text.set_line_wrap(true);
        text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        text.set_activatable(false);
        text.set_editable(true);
        text.reactive = true;
        text.y_expand = false;
        text.y_align = Clutter.ActorAlign.START;
        text.max_length = 12000;
        // Focus the editable Clutter.Text, including clicks in the entry's padding.
        this.body.connect('button-press-event', () => {
            global.stage.set_key_focus(text);
            return Clutter.EVENT_PROPAGATE;
        });
        text.connect('button-press-event', () => {
            global.stage.set_key_focus(text);
            return Clutter.EVENT_PROPAGATE;
        });
        // Consume Return here so the surrounding popup cannot activate a row.
        // Native insertion uses the current Unicode cursor/selection positions.
        text.connect('key-press-event', (_actor, event) => {
            if (![Clutter.KEY_Return, Clutter.KEY_KP_Enter].includes(event.get_key_symbol()))
                return Clutter.EVENT_PROPAGATE;
            if (
                event.get_state() &
                (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.SUPER_MASK)
            )
                return Clutter.EVENT_PROPAGATE;
            text.delete_selection();
            text.insert_unichar(10);
            return Clutter.EVENT_STOP;
        });
        this.bodyScroll = new St.ScrollView({
            overlay_scrollbars: false,
            x_expand: true,
            style_class: 'pingoose-note-editor-scroll',
        });
        this.bodyScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        const bodyContent = new St.BoxLayout({ x_expand: true });
        this.lineNumbers = new St.Widget({
            width: 24,
            y_align: Clutter.ActorAlign.START,
            style_class: 'pingoose-editor-lines',
        });
        bodyContent.add_child(this.lineNumbers);
        bodyContent.add_child(this.body);
        this.bodyScroll.add_actor(bodyContent);
        this.bodyScroll.set_clip_to_allocation(true);
        let revealRequested = false;
        const revealCursor = (reveal = true) => {
            revealRequested ||= reveal;
            if (this.cursorLater) return;
            this.cursorLater = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
                this.cursorLater = 0;
                if (!this.bodyScroll.mapped) return GLib.SOURCE_REMOVE;
                const box = this.body.get_theme_node().get_content_box(
                    new Clutter.ActorBox({
                        x1: 0,
                        y1: 0,
                        x2: this.body.width,
                        y2: this.body.height,
                    })
                );
                const naturalHeight = TextLayout.measure(
                    text,
                    box.x2 - box.x1,
                    this.body.get_theme_node().get_foreground_color()
                );
                this.body.height = Math.max(38, naturalHeight + 20);
                this.lineNumbers.height = this.body.height;
                if (this.kind === 'todo') {
                    // Use the same width-constrained layout as the editor height,
                    // rather than cursor coordinates from an unfinished allocation.
                    const positions = TextLayout.logicalLinePositions(
                        text,
                        box.x2 - box.x1,
                        this.body.text
                    );
                    const numbers = this.lineNumbers.get_children();
                    while (numbers.length > positions.length) numbers.pop().destroy();
                    positions.forEach((position, index) => {
                        let number = numbers[index];
                        if (!number) {
                            number = new St.Label({
                                text: String(index + 1),
                                style_class: 'pingoose-card-time',
                            });
                            this.lineNumbers.add_child(number);
                        }
                        number.set_position(0, box.y1 + position.y);
                    });
                }
                if (revealRequested && !this.cursorScrollLater) {
                    // Wait for the new actor height and adjustment range to be allocated.
                    this.cursorScrollLater = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
                        this.cursorScrollLater = 0;
                        revealRequested = false;
                        if (!this.bodyScroll.mapped) return GLib.SOURCE_REMOVE;
                        const bounds = TextLayout.cursorBounds(
                            text,
                            box.x2 - box.x1,
                            this.body.text
                        );
                        const adjustment = this.bodyScroll.get_vscroll_bar().get_adjustment();
                        const top = bounds.y + box.y1,
                            bottom = top + bounds.height + 10;
                        let value = adjustment.value;
                        if (top < value) value = top;
                        else if (bottom > value + adjustment.page_size)
                            value = bottom - adjustment.page_size;
                        adjustment.value = Math.max(
                            adjustment.lower,
                            Math.min(value, adjustment.upper - adjustment.page_size)
                        );
                        return GLib.SOURCE_REMOVE;
                    });
                }
                return GLib.SOURCE_REMOVE;
            });
        };
        this.adjustmentSignal = this.bodyScroll
            .get_vscroll_bar()
            .get_adjustment()
            .connect('changed', () => {
                if (global.stage.get_key_focus() === text) revealCursor();
            });
        this.revealCursor = revealCursor;
        this.body.connect('style-changed', () => {
            text._pingooseTextStyle = null;
            revealCursor();
        });
        text.connect('notify::allocation', () => revealCursor(false));
        text.connect('text-changed', () => revealCursor());
        text.connect('notify::cursor-position', () => revealCursor());
        this.root.add_child(this.name);
        this.root.add_child(this.bodyScroll);
        const actions = new St.BoxLayout({ style_class: 'pingoose-chat-input-row' });
        actions.add_child(this.button('Save', onSave));
        actions.add_child(
            this.button('Cancel', () => {
                onCancel();
            })
        );
        this.root.add_child(actions);
    }

    get value() {
        return { title: this.name.text, body: this.body.text };
    }

    clear() {
        this.name.text = '';
        this.body.text = '';
        this.root.hide();
    }

    update(kind, editing) {
        this.kind = kind;
        this.root.visible = !!editing;
        this.name.visible = this.kind !== 'todo';
        this.bodyScroll.style_class =
            this.kind === 'todo' ? 'pingoose-todo-editor-scroll' : 'pingoose-note-editor-scroll';
        this.lineNumbers.visible = this.kind === 'todo';
        this.body.set_style(this.kind === 'todo' ? 'width: 254px;' : 'width: 278px;');
        this.body.height = -1;
        if (editing) {
            this.name.text = editing.title === 'Untitled' ? '' : editing.title || '';
            this.body.text = editing.body || '';
            this.body.hint_text =
                this.kind === 'todo' ? 'Enter creates a new task' : 'Write your notes…';
            this.revealCursor();
        }
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
    destroy() {
        if (this.cursorLater) Meta.later_remove(this.cursorLater);
        if (this.cursorScrollLater) Meta.later_remove(this.cursorScrollLater);
        this.cursorLater = this.cursorScrollLater = 0;
        this.bodyScroll.get_vscroll_bar().get_adjustment().disconnect(this.adjustmentSignal);
        this.root.destroy();
    }
};
