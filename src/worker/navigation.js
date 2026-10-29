const { Gtk, Gdk } = imports.gi;

// Shared by the Intra window and authenticated service/project windows.
function create(view, window) {
    const box = new Gtk.Box({ spacing: 6 });
    const iconButton = (name, icon) => {
        const button = new Gtk.Button({ tooltip_text: name });
        button.set_image(Gtk.Image.new_from_icon_name(icon, Gtk.IconSize.BUTTON));
        button.get_accessible().set_name(name);
        return button;
    };
    const back = iconButton('Back', 'go-previous-symbolic');
    const forward = iconButton('Forward', 'go-next-symbolic');
    const refresh = iconButton('Refresh', 'view-refresh-symbolic');
    back.connect('clicked', () => {
        if (view.can_go_back()) view.go_back();
    });
    forward.connect('clicked', () => {
        if (view.can_go_forward()) view.go_forward();
    });
    refresh.connect('clicked', () => view.reload());
    refresh.tooltip_text = 'Refresh (F5)';
    // Capture before WebKit consumes the key, including when a page input has focus.
    const keys = Gtk.EventControllerKey.new(window);
    keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    keys.connect('key-pressed', (_keys, keyval, _keycode, state) => {
        if (
            keyval !== Gdk.KEY_F5 ||
            !box.get_visible() ||
            state & Gtk.accelerator_get_default_mod_mask()
        )
            return false;
        view.reload();
        return true;
    });
    box._refreshKeys = keys;
    for (const button of [back, forward, refresh]) box.pack_start(button, false, false, 0);
    const sync = () => {
        back.sensitive = view.can_go_back();
        forward.sensitive = view.can_go_forward();
    };
    view.get_back_forward_list().connect('changed', sync);
    sync();
    box.show_all();
    return box;
}
