const { Gtk, Gio } = imports.gi;
const Common = imports.misc.extensionUtils.getCurrentExtension().imports.preferences.common;
const HEIGHTS = [
    ['main-panel-height', '_Main panel (px)'],
    ['chat-panel-height', '_Cluster Chat (px)'],
    ['project-panel-height', '_Project notes (px)'],
    ['service-panel-height', '42 _Services (px)'],
];
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
    Common.sectionHeading(box, 'Panel Heights');
    box.append(
        new Gtk.Label({
            label:
                'Heights are saved separately for each panel. Set a height to 0 for automatic sizing. ' +
                'Drag the bottom edge or its corners when Pingoose is in the top bar; ' +
                'use the top edge or its corners when it is in the bottom bar.',
            xalign: 0,
            wrap: true,
        })
    );
    for (const [key, label] of HEIGHTS) {
        const value = Gtk.SpinButton.new_with_range(0, 4096, 1);
        value.numeric = true;
        value.tooltip_text = '0 = Automatic. The panel stays within the available screen height.';
        settings.bind(key, value, 'value', Gio.SettingsBindFlags.DEFAULT);
        const row = new Gtk.Box({ spacing: 24 });
        row.append(
            new Gtk.Label({
                label,
                use_underline: true,
                mnemonic_widget: value,
                xalign: 0,
                hexpand: true,
                wrap: true,
            })
        );
        row.append(value);
        box.append(row);
    }
    const reset = new Gtk.Button({ label: 'Reset panel heights' });
    reset.connect('clicked', () => {
        for (const [key] of HEIGHTS) settings.reset(key);
    });
    box.append(reset);
    return box;
}
