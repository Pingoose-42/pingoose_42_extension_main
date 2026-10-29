const { Gtk, Gdk } = imports.gi;
function append(parent, settings) {
    const row = new Gtk.Box({ spacing: 12 });
    row.append(
        new Gtk.Label({ label: 'Toggle Pingoose shortcut', hexpand: true, xalign: 0, wrap: true })
    );
    const capture = new Gtk.Button({ label: 'Not set' });
    const reset = new Gtk.Button({ label: 'Reset' });
    row.append(capture);
    row.append(reset);
    parent.append(row);
    let recording = false,
        inhibitedSurface = null;
    const release = () => {
        inhibitedSurface?.restore_system_shortcuts();
        inhibitedSurface = null;
        recording = false;
    };
    const update = () => {
        const accelerator = settings.get_strv('panel-shortcut')[0];
        const [ok, key, mods] = Gtk.accelerator_parse(accelerator || '');
        capture.label = accelerator && ok && key ? Gtk.accelerator_get_label(key, mods) : 'Not set';
    };
    capture.connect('clicked', () => {
        release();
        inhibitedSurface = capture.get_native()?.get_surface();
        inhibitedSurface?.inhibit_system_shortcuts(null);
        recording = true;
        capture.label = 'Press shortcut…';
        capture.grab_focus();
    });
    reset.connect('clicked', () => {
        release();
        settings.reset('panel-shortcut');
        update();
    });
    const keys = new Gtk.EventControllerKey();
    keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    keys.connect('key-pressed', (_controller, key, _code, state) => {
        if (!recording) return false;
        if (key === Gdk.KEY_Escape) {
            release();
            update();
            return true;
        }
        // Modifier presses begin a combination; they are not the shortcut itself.
        if (
            [
                Gdk.KEY_Control_L,
                Gdk.KEY_Control_R,
                Gdk.KEY_Shift_L,
                Gdk.KEY_Shift_R,
                Gdk.KEY_Alt_L,
                Gdk.KEY_Alt_R,
                Gdk.KEY_Super_L,
                Gdk.KEY_Super_R,
                Gdk.KEY_Meta_L,
                Gdk.KEY_Meta_R,
                Gdk.KEY_Hyper_L,
                Gdk.KEY_Hyper_R,
                Gdk.KEY_ISO_Level3_Shift,
            ].includes(key)
        )
            return true;
        const mods = state & Gtk.accelerator_get_default_mod_mask();
        key = Gdk.keyval_to_lower(key);
        if (key === Gdk.KEY_ISO_Left_Tab) key = Gdk.KEY_Tab;
        if (!Gtk.accelerator_valid(key, mods)) return true;
        settings.set_strv('panel-shortcut', [Gtk.accelerator_name(key, mods)]);
        release();
        update();
        return true;
    });
    capture.add_controller(keys);
    capture.connect('notify::has-focus', () => {
        if (recording && !capture.has_focus) {
            release();
            update();
        }
    });
    capture.connect('unmap', () => {
        release();
        update();
    });
    update();
}
