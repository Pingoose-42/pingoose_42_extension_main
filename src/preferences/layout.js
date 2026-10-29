const { Gtk, Gio } = imports.gi;
const Common = imports.misc.extensionUtils.getCurrentExtension().imports.preferences.common;
function build(settings) {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    Common.sectionHeading(box, 'Popup Position & Panel Spacing');
    for (const [key, label] of [
        ['popup-top-margin', 'Top margin (0–100 px)'],
        ['popup-left-margin', 'Left margin (0–100 px)'],
        ['main-panel-gap', 'Main page ↔ panel gap (0–100 px)'],
        ['panel-gap', 'Panel ↔ panel gap (0–100 px)'],
    ]) {
        const value = Gtk.SpinButton.new_with_range(0, 100, 1);
        settings.bind(key, value, 'value', Gio.SettingsBindFlags.DEFAULT);
        Common.row(box, label, value);
    }
    return box;
}
