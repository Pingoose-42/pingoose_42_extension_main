const {Gtk, Gio} = imports.gi;
const Common = imports.misc.extensionUtils.getCurrentExtension().imports.preferences.common;
function build(settings) {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18});
    box.append(new Gtk.Label({label: 'Choose which system notifications Pingoose shows. Cards and unread messages are still saved.', wrap: true, xalign: 0}));
    for (const [key, label] of [
        ['notify-evaluations', 'Evaluation matches, reminders and locations'],
        ['notify-agenda', 'New agenda events'],
        ['notify-chat', 'Cluster Chat messages'],
        ['warn-open-slots-on-logout', 'Warn about slots and evaluations before logout'],
    ]) {
        const toggle = new Gtk.Switch({valign: Gtk.Align.CENTER});
        settings.bind(key, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        Common.row(box, label, toggle);
    }
    box.append(new Gtk.Label({label: 'This warning checks open slots, scheduled evaluations and past evaluations awaiting feedback confirmation. Turning it off does not close slots or cancel evaluations.', wrap: true, xalign: 0}));
    for (const [category, title, max] of [['evaluation', 'Evaluation', 15], ['agenda', 'Agenda', 10080]]) {
        const reminder = new Gtk.Switch({valign: Gtk.Align.CENTER});
        settings.bind(`notify-${category}-reminder-enabled`, reminder, 'active', Gio.SettingsBindFlags.DEFAULT);
        Common.row(box, `${title} start reminder`, reminder);
        const minutes = Gtk.SpinButton.new_with_range(0, max, 1);
        settings.bind(`${category}-reminder-minutes`, minutes, 'value', Gio.SettingsBindFlags.DEFAULT);
        Common.row(box, `${title}: minutes before start (0 = at start)`, minutes);
        const immediate = new Gtk.Switch({valign: Gtk.Align.CENTER});
        settings.bind(`notify-${category}-immediate`, immediate, 'active', Gio.SettingsBindFlags.DEFAULT);
        Common.row(box, `${title}: notify immediately when added`, immediate);
    }
    const duration = Gtk.SpinButton.new_with_range(0, 120, 1);
    settings.bind('notification-duration', duration, 'value', Gio.SettingsBindFlags.DEFAULT);
    Common.row(box, 'Banner duration (seconds)', duration);
    box.append(new Gtk.Label({label: '0 = Keep until dismissed. Default: 4 seconds.', wrap: true, xalign: 0}));
    const flash = Gtk.SpinButton.new_with_range(0, 5, 1);
    settings.bind('flash-count', flash, 'value', Gio.SettingsBindFlags.DEFAULT);
    Common.row(box, 'Screen flash (0 = Off)', flash);
    return box;
}
