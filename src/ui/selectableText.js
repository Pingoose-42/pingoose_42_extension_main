const { Clutter, St } = imports.gi;
function attach(message) {
    message.reactive = true;
    message.can_focus = true;
    const text = message.clutter_text;
    text.reactive = true;
    text.set_selectable(true);
    text.set_editable(false);
    // St.Label does not apply St.Entry's selection CSS to its Clutter.Text.
    const selectionColors = () => {
        text.set_selection_color(
            new Clutter.Color({ red: 133, green: 214, blue: 203, alpha: 255 })
        );
        text.set_selected_text_color(
            new Clutter.Color({ red: 16, green: 35, blue: 32, alpha: 255 })
        );
    };
    message.connect('style-changed', selectionColors);
    selectionColors();
    text.connect('key-press-event', (_actor, event) => {
        if (
            event.get_state() & Clutter.ModifierType.CONTROL_MASK &&
            [Clutter.KEY_c, Clutter.KEY_C].includes(event.get_key_symbol())
        ) {
            const selection = text.get_selection();
            if (selection)
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, selection);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    });
}
