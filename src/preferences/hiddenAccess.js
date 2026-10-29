const { Gtk, GLib, Gdk } = imports.gi;
// Capture at the notebook so the sequence also works while its tab label has focus.
function attach(tabs, settings) {
    const flags = imports.misc.extensionUtils.getCurrentExtension().imports.models.featureFlags;
    const commands = ['pingoose-hidden-on', 'pingoose-hidden-off'];
    let buffer = '',
        lastKey = 0;
    const clear = () => {
        buffer = '';
        lastKey = 0;
    };
    const keys = new Gtk.EventControllerKey();
    keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    keys.connect('key-pressed', (_controller, keyval, _keycode, state) => {
        if (
            tabs.get_current_page() !== 3 ||
            state &
                (Gdk.ModifierType.CONTROL_MASK |
                    Gdk.ModifierType.ALT_MASK |
                    Gdk.ModifierType.SUPER_MASK)
        ) {
            clear();
            return false;
        }
        const now = GLib.get_monotonic_time();
        if (now - lastKey > 5000000) clear();
        if (keyval === Gdk.KEY_BackSpace && buffer) {
            buffer = buffer.slice(0, -1);
            lastKey = now;
            return true;
        }
        const unicode = Gdk.keyval_to_unicode(keyval);
        if (!unicode) {
            clear();
            return false;
        }
        const char = String.fromCodePoint(unicode).toLowerCase();
        buffer += char;
        while (buffer && !commands.some((command) => command.startsWith(buffer)))
            buffer = buffer.slice(1);
        lastKey = now;
        if (!commands.includes(buffer)) return !!buffer;
        const command = buffer;
        clear();
        flags.unlock(settings, command);
        const active = flags.unlocked(settings);
        const dialog = new Gtk.MessageDialog({
            transient_for: tabs.get_root(),
            modal: true,
            message_type: Gtk.MessageType.INFO,
            buttons: Gtk.ButtonsType.OK,
            text: active ? 'Hidden Options unlocked' : 'Hidden Options disabled',
            secondary_text: active
                ? 'Open the Hidden Options tab to enable advanced features.'
                : 'Hidden Options and advanced features are now disabled.',
        });
        dialog.connect('response', () => dialog.destroy());
        dialog.present();
        return true;
    });
    tabs.add_controller(keys);
    tabs.connect('switch-page', clear);
    tabs.connect('unmap', clear);
}
