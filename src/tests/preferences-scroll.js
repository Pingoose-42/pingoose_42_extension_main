// Interactive GTK4 regression probe. Uses a bounded viewport even under tiling WMs.
// No user settings, notes or network requests are touched; the window closes itself.
imports.gi.versions.Gtk = '4.0';
const { Gtk, GLib } = imports.gi;
imports.searchPath.unshift(GLib.build_filenamev([GLib.get_current_dir(), 'src']));
const Common = imports.preferences.common;
Gtk.init();
const window = new Gtk.Window({ title: 'Pingoose scroll regression check' });
const root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
const scroll = new Gtk.ScrolledWindow({
    min_content_height: 180,
    max_content_height: 180,
    propagate_natural_height: true,
    vexpand: false,
    valign: Gtk.Align.START,
    hscrollbar_policy: Gtk.PolicyType.NEVER,
});
const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
function populate(count) {
    let child;
    while ((child = list.get_first_child())) list.remove(child);
    for (let i = 0; i < count; i++) list.append(new Gtk.Button({ label: 'Row ' + i }));
}
scroll.set_child(list);
root.append(scroll);
window.set_child(root);
populate(30);
window.present();
const loop = new GLib.MainLoop(null, false);
const wait = () =>
    new Promise((resolve) =>
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        })
    );
let failure;
(async () => {
    try {
        await wait();
        const adjustment = scroll.get_vadjustment();
        if (adjustment.upper <= adjustment.page_size) throw Error('Viewport must scroll');
        list.get_last_child().grab_focus();
        await wait();
        adjustment.value = 120;
        await wait();
        Common.preserveListScroll(scroll, list, () => populate(30));
        await wait();
        await wait();
        if (Math.abs(adjustment.value - 120) > 1)
            throw Error('Rebuild lost scroll position: ' + adjustment.value);
        Common.preserveListScroll(scroll, list, () => populate(1));
        await wait();
        await wait();
        if (adjustment.value !== 0) throw Error('Short list not clamped');
        print(
            'PASS: focused-row rebuild retains scroll in a bounded GTK viewport; shorter list clamps to top'
        );
    } catch (error) {
        failure = error;
    } finally {
        window.destroy();
        loop.quit();
    }
})();
loop.run();
if (failure) throw failure;
