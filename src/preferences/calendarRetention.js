const { Gtk, Gio } = imports.gi;
const Common = imports.misc.extensionUtils.getCurrentExtension().imports.preferences.common;

function append(parent, settings) {
    const key = 'auto-delete-past-agenda-calendar';
    const toggle = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    // Read settings into the switch, but never write an unconfirmed click back.
    settings.bind(key, toggle, 'active', Gio.SettingsBindFlags.GET);
    let pending = null;
    toggle.connect('state-set', (_toggle, requested) => {
        if (requested === settings.get_boolean(key)) return false;
        if (!requested) {
            settings.set_boolean(key, false);
            return false;
        }
        toggle.set_active(false);
        if (pending) return true;
        const dialog = new Gtk.MessageDialog({
            transient_for: parent.get_root(),
            destroy_with_parent: true,
            modal: true,
            message_type: Gtk.MessageType.WARNING,
            buttons: Gtk.ButtonsType.NONE,
            text: 'Enable automatic deletion?',
            secondary_text:
                'All past calendar events synced by Pingoose will be deleted during sync. Do you want to continue?',
        });
        pending = dialog;
        dialog.add_button('No', Gtk.ResponseType.NO);
        dialog.add_button('Yes', Gtk.ResponseType.YES);
        dialog.set_default_response(Gtk.ResponseType.NO);
        dialog.connect('response', (_dialog, response) => {
            if (pending !== dialog) return;
            pending = null;
            dialog.destroy();
            if (response === Gtk.ResponseType.YES) settings.set_boolean(key, true);
        });
        dialog.present();
        return true;
    });
    parent.connect('unmap', () => {
        const dialog = pending;
        pending = null;
        dialog?.destroy();
    });
    Common.row(parent, 'Automatically delete past calendar events', toggle);
    return toggle;
}
