const {Gtk}=imports.gi;
const Common=imports.misc.extensionUtils.getCurrentExtension().imports.preferences.common;
function open(parent,settings) {
    const dialog=new Gtk.Dialog({title:'Chat Block List',transient_for:parent.get_root(),modal:true,default_width:400});
    dialog.add_button('Close',Gtk.ResponseType.CLOSE);
    dialog.connect('response',()=>dialog.destroy());
    const box=dialog.get_content_area();box.spacing=12;
    box.margin_top=box.margin_bottom=box.margin_start=box.margin_end=18;
    const input=new Gtk.Box({spacing:8});
    const entry=new Gtk.Entry({placeholder_text:'Seat or @Intra ID',hexpand:true});
    const add=new Gtk.Button({label:'Add'});
    input.append(entry);input.append(add);box.append(input);
    const status=new Gtk.Label({label:'',wrap:true,xalign:0});box.append(status);
    const list=new Gtk.Box({orientation:Gtk.Orientation.VERTICAL,spacing:8});
    const scroll=new Gtk.ScrolledWindow({min_content_height:180,max_content_height:320,propagate_natural_height:true,hscrollbar_policy:Gtk.PolicyType.NEVER});
    scroll.set_child(list);box.append(scroll);
    const render = () => Common.preserveListScroll(scroll, list, () => {
        let child;while((child=list.get_first_child()))list.remove(child);
        const rules=settings.get_strv('blocked-chat-seats');
        if(!rules.length)list.append(new Gtk.Label({label:'No blocked seats.',xalign:0}));
        for(const rule of rules){
            const row=new Gtk.Box({spacing:8});
            row.append(new Gtk.Label({label:rule,hexpand:true,xalign:0}));
            const remove=new Gtk.Button({label:'Remove'});
            remove.connect('clicked',()=>settings.set_strv('blocked-chat-seats',settings.get_strv('blocked-chat-seats').filter(value=>value!==rule)));
            row.append(remove);list.append(row);
        }
    });
    const submit=()=>{
        let value=entry.get_text().trim().toLowerCase();
        if(!/^c[1-9][0-9]*(?:r[1-9][0-9]*(?:s[1-9][0-9]*)?)?$/.test(value) && /^@?[a-z0-9_-]{1,64}$/.test(value))value='@'+value.replace(/^@/,'');
        if(!/^c[1-9][0-9]*(?:r[1-9][0-9]*(?:s[1-9][0-9]*)?)?$/.test(value) && !/^@[a-z0-9_-]{1,64}$/.test(value)){
            status.label='Enter a cluster, row, seat, or @Intra ID.';return;
        }
        const rules=settings.get_strv('blocked-chat-seats');
        if(rules.includes(value)){status.label='Already blocked.';return;}
        if(rules.length>=64){status.label='Up to 64 block rules are allowed.';return;}
        settings.set_strv('blocked-chat-seats',[...rules,value]);
        entry.set_text('');status.label='Block rule added.';
    };
    add.connect('clicked',submit);entry.connect('activate',submit);
    const signal=settings.connect('changed::blocked-chat-seats',render);
    dialog.connect('destroy',()=>settings.disconnect(signal));
    render();dialog.present();
    return dialog;
}
