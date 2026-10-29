const {Gtk, Gio, GLib, Pango} = imports.gi;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Common = Me.imports.preferences.common;
const Model = Me.imports.models.agendaCalendar;
function build(settings) {
    const root = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 14});
    root.append(new Gtk.Label({label: 'Saved agenda events', xalign: 0, css_classes: ['heading']}));
    const refresh = new Gtk.Button({label: 'Refresh'}); root.append(refresh);
    const list = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 10}); root.append(list);
    const file = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'pingoose', 'calendar', 'history.json']));
    const render = () => Common.preserveListScroll(list, list, () => {
        let child; while ((child = list.get_first_child())) list.remove(child);
        try {
            let saved = {rows: []};
            if (file.query_exists(null)) {
                const [ok, bytes] = file.load_contents(null);
                if (!ok) throw new Error();
                saved = JSON.parse(imports.byteArray.toString(bytes));
                Model.calendar(saved.rows, saved.subject);
            }
            if (!saved.rows.length) list.append(new Gtk.Label({label: 'No saved agenda events.', xalign: 0}));
            for (const row of [...saved.rows].sort((a,b) => Date.parse(b.begin)-Date.parse(a.begin))) {
                const frame = new Gtk.Frame();
                const card = new Gtk.Box({spacing: 12, margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12});
                frame.set_child(card); list.append(frame);
                const text = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 5, hexpand: true}); card.append(text);
                text.append(new Gtk.Label({label: row.name, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR}));
                const date = new Gtk.Label({label: `${new Date(row.begin).toLocaleString()} – ${new Date(row.end).toLocaleString()}`, xalign: 0, wrap: true});
                date.add_css_class('dim-label'); text.append(date);
                const remove = new Gtk.Button({label: 'Delete', valign: Gtk.Align.CENTER}); card.append(remove);
                remove.connect('clicked', () => Common.confirm(root, 'Delete this calendar event?', row.name, 'Delete', () => {
                    settings.set_strv('deleted-calendar-events', [...new Set([...settings.get_strv('deleted-calendar-events'), Model.eventKey(saved.subject, row)])]);
                    // Apply locally too, so management works while the Shell extension is disabled.
                    const controller = new Me.imports.services.agendaCalendar.Controller(settings, () => {});
                    controller.destroy();
                    render();
                }));
            }
        } catch (_) { list.append(new Gtk.Label({label: 'Unable to read saved events. Please retry.', xalign: 0})); }
    });
    refresh.connect('clicked', render);
    root.connect('map', render);
    render(); return root;
}
