const {Gtk, Pango} = imports.gi;
// One native GTK scroll viewport per tab: wheel and touchpad behavior should
// not depend on whether the pointer is over a header, form, or saved list.
function scrollPage(content) {
    const scroll = new Gtk.ScrolledWindow({hexpand:true,vexpand:true,
        hscrollbar_policy:Gtk.PolicyType.NEVER,vscrollbar_policy:Gtk.PolicyType.AUTOMATIC,
        propagate_natural_height:false,overlay_scrolling:false,min_content_height:0});
    scroll.set_child(content);
    return scroll;
}
function row(parent, name, control) {
    const box = new Gtk.Box({spacing:24});
    box.append(new Gtk.Label({label:name, xalign:0, hexpand:true, wrap:true}));
    box.append(control); parent.append(box);
}
function confirm(parent, title, detail, accept, action) {
    const dialog = new Gtk.MessageDialog({transient_for:parent.get_root(), modal:true,
        message_type:Gtk.MessageType.QUESTION, buttons:Gtk.ButtonsType.NONE,
        text:title, secondary_text:detail});
    dialog.add_button('Cancel',Gtk.ResponseType.CANCEL);
    dialog.add_button(accept,Gtk.ResponseType.ACCEPT);
    dialog.set_default_response(Gtk.ResponseType.CANCEL);
    dialog.connect('response',(_dialog,response)=>{
        dialog.destroy();
        if(response===Gtk.ResponseType.ACCEPT) action();
    });
    dialog.present();
}

// Replacing a focused row lets GTK move focus to a later row and scroll to it.
// Move focus to the viewport before removal, then restore the user's position
// after allocation. Only list mutations use this; normal keyboard navigation stays intact.
function preserveListScroll(scroll, list, update) {
    // Page lists no longer own nested viewports. Resolve their tab viewport.
    while(scroll && typeof scroll.get_vadjustment !== 'function')scroll=scroll.get_parent();
    if(!scroll){update();return;}
    if (!scroll.get_mapped()) { update(); return; }
    const adjustment = scroll.get_vadjustment();
    const previous = scroll._pingooseScrollRestore;
    const value = previous ? previous.value : adjustment.value;
    if (previous) scroll.remove_tick_callback(previous.id);
    const focus = scroll.get_root()?.get_focus();
    if (focus && (focus === list || focus.is_ancestor(list))) {
        scroll.set_focusable(true);
        scroll.grab_focus();
    }
    update();
    let frames = 0;
    const pending = {value, id: 0};
    pending.id = scroll.add_tick_callback(() => {
        if (++frames < 2) return true;
        adjustment.value = Math.max(adjustment.lower,
            Math.min(value, adjustment.upper - adjustment.page_size));
        scroll._pingooseScrollRestore = null;
        return false;
    });
    scroll._pingooseScrollRestore = pending;
    if (!scroll._pingooseScrollUnmap) {
        scroll._pingooseScrollUnmap = scroll.connect('unmap', () => {
            const pending = scroll._pingooseScrollRestore;
            if (pending) scroll.remove_tick_callback(pending.id);
            scroll._pingooseScrollRestore = null;
        });
    }
}

// Consistent headings for preference groups; keep controls and their bindings intact.
function sectionHeading(parent, title, separator = true) {
    if (separator) parent.append(new Gtk.Separator({margin_top: 6, margin_bottom: 6}));
    const label = new Gtk.Label({label: title, xalign: 0});
    label.add_css_class('heading');
    const attributes = new Pango.AttrList();
    attributes.insert(Pango.attr_scale_new(1.12));
    label.set_attributes(attributes);
    parent.append(label);
}
