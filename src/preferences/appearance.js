const {Gtk, Gio} = imports.gi;
const Common = imports.misc.extensionUtils.getCurrentExtension().imports.preferences.common;
const Order = imports.misc.extensionUtils.getCurrentExtension().imports.models.appearance;
function build(settings) {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
    Common.sectionHeading(box, 'Animation & Scrollbars', false);
    const animation=new Gtk.Switch({valign:Gtk.Align.CENTER});
    settings.bind('topbar-animation',animation,'active',Gio.SettingsBindFlags.DEFAULT);
    Common.row(box,'Top Bar Animation',animation);
    const scrollbars = new Gtk.Switch({valign: Gtk.Align.CENTER});
    settings.bind('auto-hide-scrollbars', scrollbars, 'active', Gio.SettingsBindFlags.DEFAULT);
    Common.row(box, 'Auto-hide scrollbars', scrollbars);
    Common.sectionHeading(box, 'Panel Sections & Order');
    const list = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 10});
    box.append(list);
    const rows = new Map();
    const available = Order.sections.filter(section=>section[0]!=='chat' || imports.misc.extensionUtils.getCurrentExtension().imports.models.featureFlags.enabled(settings,'hidden-cluster-chat'));
    let draft = Order.read(settings);
    const apply = new Gtk.Button({label:'Apply',sensitive:false});
    const refresh = () => {
        const order = draft.filter(key=>rows.has(key));
        order.forEach((key, index) => {
            const item = rows.get(key);
            const previous = index ? rows.get(order[index - 1]).row : null;
            if (item.row.get_prev_sibling() !== previous)
                list.reorder_child_after(item.row, previous);
            item.number.label = `${index + 1}.`;
            item.up.sensitive = index > 0;
            item.down.sensitive = index < order.length - 1;
        });
        apply.sensitive = JSON.stringify(draft) !== JSON.stringify(Order.read(settings));
    };
    for (const [key, name, toggles] of available) {
        const row = new Gtk.Box({spacing: 10});
        const number = new Gtk.Label({width_chars: 2}); row.append(number);
        const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, hexpand: true});
        if (toggles.length > 1) content.append(new Gtk.Label({label: name, xalign: 0}));
        for (const toggleKey of toggles) {
            const line = new Gtk.Box({spacing: 12});
            const label = toggles.length === 1 ? name : {projects:'My Projects',logtime:'Logtime'}[toggleKey];
            line.append(new Gtk.Label({label, xalign: 0, hexpand: true}));
            const toggle = new Gtk.Switch({valign: Gtk.Align.CENTER});
            settings.bind(`show-${toggleKey}`, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
            line.append(toggle); content.append(line);
        }
        row.append(content);
        const up = new Gtk.Button({label: '↑', tooltip_text: 'Move up', valign: Gtk.Align.CENTER});
        const down = new Gtk.Button({label: '↓', tooltip_text: 'Move down', valign: Gtk.Align.CENTER});
        const move = delta => {
            const order = draft.filter(value=>rows.has(value)), index = order.indexOf(key), target = index + delta;
            if (target < 0 || target >= order.length) return;
            [order[index], order[target]] = [order[target], order[index]];
            draft = Order.normalize(order); Common.preserveListScroll(list, list, refresh);
        };
        up.connect('clicked', () => move(-1)); down.connect('clicked', () => move(1));
        row.append(up); row.append(down); list.append(row);
        rows.set(key, {row,number,up,down});
    }
    const reset = new Gtk.Button({label:'Reset order'});
    reset.connect('clicked', () => {draft=Order.normalize(settings.get_default_value('section-order').deep_unpack());refresh();});
    const actions=new Gtk.Box({spacing:8});actions.append(reset);actions.append(apply);box.append(actions);
    apply.connect('clicked',()=>{settings.set_strv('section-order',draft);refresh();});
    box.append(imports.misc.extensionUtils.getCurrentExtension().imports.preferences.layout.build(settings));
    const externalChange=()=>{draft=Order.read(settings);refresh();};
    let signal = 0;
    box.connect('map', () => {
        if (!signal) signal = settings.connect('changed::section-order', externalChange);
        refresh();
    });
    box.connect('unmap', () => {
        if (signal) settings.disconnect(signal);
        signal = 0;
    });
    refresh(); return box;
}
