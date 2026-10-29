const {Gtk, Gio, GLib} = imports.gi;
const Common = imports.misc.extensionUtils.getCurrentExtension().imports.preferences.common;
function build(settings) {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18});
    let firstSection = true;
    const heading = title => {
        Common.sectionHeading(box, title, !firstSection);
        firstSection = false;
    };
    const toggleRow = (key, title) => {
        const toggle = new Gtk.Switch({valign: Gtk.Align.CENTER});
        settings.bind(key, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        Common.row(box, title, toggle);
    };
    for (const [category, title, max] of [['evaluation', 'Evaluation', 15], ['agenda', 'Agenda', 10080]]) {
        heading(title === 'Evaluation' ? 'Evaluations' : 'Agenda');
        toggleRow(category === 'evaluation' ? 'notify-evaluations' : 'notify-agenda', 'System notifications');
        const reminder = new Gtk.Switch({valign: Gtk.Align.CENTER});
        settings.bind(`notify-${category}-reminder-enabled`, reminder, 'active', Gio.SettingsBindFlags.DEFAULT);
        Common.row(box, `${title} start reminder`, reminder);
        const minutes = Gtk.SpinButton.new_with_range(0, max, 1);
        settings.bind(`${category}-reminder-minutes`, minutes, 'value', Gio.SettingsBindFlags.DEFAULT);
        Common.row(box, `${title}: before start (0–${max} min; 0 = at start)`, minutes);
        const immediate = new Gtk.Switch({valign: Gtk.Align.CENTER});
        settings.bind(`notify-${category}-immediate`, immediate, 'active', Gio.SettingsBindFlags.DEFAULT);
        Common.row(box, `${title}: notify immediately when added`, immediate);
    }
    heading('Cluster Chat');
    toggleRow('notify-chat', 'New message notifications');
    heading('Logout Warning');
    toggleRow('warn-open-slots-on-logout', 'Warn about slots and evaluations before logout');
    heading('Notification Banners');
    const duration = Gtk.SpinButton.new_with_range(0, 120, 1);
    settings.bind('notification-duration', duration, 'value', Gio.SettingsBindFlags.DEFAULT);
    Common.row(box, 'Banner duration (0–120 s; 0 = until dismissed)', duration);
    heading('Screen Flash');
    const flash = Gtk.SpinButton.new_with_range(0, 5, 1);
    settings.bind('flash-count', flash, 'value', Gio.SettingsBindFlags.DEFAULT);
    Common.row(box, 'Screen flash (0–5 pulses; 0 = Off)', flash);
    const interval = Gtk.SpinButton.new_with_range(0.5, 10, 0.1);
    interval.set_digits(1);
    settings.bind('flash-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
    Common.row(box, 'Flash interval (0.5–10 s)', interval);
    const brightness = Gtk.SpinButton.new_with_range(10, 200, 5);
    settings.bind('flash-brightness', brightness, 'value', Gio.SettingsBindFlags.DEFAULT);
    Common.row(box, 'Flash brightness (10–200%)', brightness);
    const thickness = Gtk.SpinButton.new_with_range(1, 40, 1);
    settings.bind('flash-thickness', thickness, 'value', Gio.SettingsBindFlags.DEFAULT);
    Common.row(box, 'Flash border thickness (1–40 px)', thickness);
    const preview = new Gtk.Button({label: 'Preview'});
    box.append(preview);
    preview.connect('clicked', () => {
        settings.set_string('flash-preview-request', GLib.uuid_string_random());
        Gio.Settings.sync();
    });
    const syncFlashControls = () => {
        const enabled = settings.get_int('flash-count') > 0;
        interval.get_parent().sensitive = enabled;
        brightness.get_parent().sensitive = enabled;
        thickness.get_parent().sensitive = enabled;
        preview.sensitive = enabled;
    };
    let flashSignal = 0;
    box.connect('map', () => {
        if (!flashSignal) flashSignal = settings.connect('changed::flash-count', syncFlashControls);
        syncFlashControls();
    });
    box.connect('unmap', () => {
        if (flashSignal) settings.disconnect(flashSignal);
        flashSignal = 0;
    });
    syncFlashControls();
    return box;
}
