const {Gtk,Gio}=imports.gi;
const Common=imports.misc.extensionUtils.getCurrentExtension().imports.preferences.common;
const Notes=imports.misc.extensionUtils.getCurrentExtension().imports.models.projectNotes;
function build(settings){
    const root=new Gtk.Box({orientation:Gtk.Orientation.VERTICAL,spacing:14,margin_top:24,margin_bottom:24,margin_start:24,margin_end:24});
    Common.sectionHeading(root, 'Project Behavior', false);
    const row=new Gtk.Box({spacing:12});row.append(new Gtk.Label({label:'Open project page directly',hexpand:true,xalign:0}));
    const toggle=new Gtk.Switch({valign:Gtk.Align.CENTER});settings.bind('project-open-direct',toggle,'active',Gio.SettingsBindFlags.DEFAULT);row.append(toggle);root.append(row);
    const firstTab=new Gtk.ComboBoxText();firstTab.append('todo','TODO List');firstTab.append('note','Note');
    settings.bind('project-default-tab',firstTab,'active-id',Gio.SettingsBindFlags.DEFAULT);
    Common.row(root,'Default project tab',firstTab);
    Common.sectionHeading(root, 'Saved Notes & TODO Lists');
    const actions=new Gtk.Box({spacing:8});root.append(actions);
    const refresh=new Gtk.Button({label:'Refresh Notes'});actions.append(refresh);
    const clear=new Gtk.Button({label:'Delete All'});actions.append(clear);
    const status=new Gtk.Label({label:'',xalign:0,wrap:true});root.append(status);
    const list=new Gtk.Box({orientation:Gtk.Orientation.VERTICAL,spacing:12});root.append(list);
    const render = () => Common.preserveListScroll(list, list, () => {
        let child;while((child=list.get_first_child()))list.remove(child);
        try{
            const notes=Notes.list();
            if(!notes.length)list.append(new Gtk.Label({label:'No saved notes.',xalign:0}));
            for(const group of Notes.grouped(notes)) {
                const section=new Gtk.Box({orientation:Gtk.Orientation.VERTICAL,spacing:10});
                const frame=new Gtk.Frame();frame.set_child(section);list.append(frame);
                section.margin_top=12;section.margin_bottom=12;section.margin_start=12;section.margin_end=12;
                const tasks=group.rows.filter(note=>note.kind==='todo').length;
                const heading=new Gtk.Label({label:`${group.name} · @${group.login}\n${tasks} tasks · ${group.rows.length-tasks} notes`,xalign:0,wrap:true});
                heading.add_css_class('heading');section.append(heading);
                for(const note of group.rows){
                    const card=new Gtk.Box({orientation:Gtk.Orientation.HORIZONTAL,spacing:12});
                    const content=new Gtk.Box({orientation:Gtk.Orientation.VERTICAL,spacing:4,hexpand:true});
                    const title=note.kind==='todo'?note.body:note.title;
                    content.append(new Gtk.Label({label:`${note.kind==='todo'?'Task':'Note'} · ${title}`,xalign:0,wrap:true,wrap_mode:imports.gi.Pango.WrapMode.WORD_CHAR}));
                    if(note.kind==='note')content.append(new Gtk.Label({label:note.body,xalign:0,wrap:true,wrap_mode:imports.gi.Pango.WrapMode.WORD_CHAR}));
                    const date=new Gtk.Label({label:`Created ${new Date(note.created).toLocaleString()}`,xalign:0});date.add_css_class('dim-label');content.append(date);
                    card.append(content);
                    const remove=new Gtk.Button({label:'Delete',valign:Gtk.Align.CENTER});remove.connect('clicked',()=>{
                        Common.confirm(root,note.kind==='todo'?'Delete this task?':'Delete this note?',
                            'This action cannot be undone.','Delete',()=>{
                                try{Notes.remove(note.id);render();}catch(_){status.label='Unable to delete. Please retry.';}
                            });
                    });card.append(remove);section.append(card);
                }
            }
        }catch(_){list.append(new Gtk.Label({label:'Unable to read notes.',xalign:0}));}
    });
    clear.connect('clicked',()=>Common.confirm(root,'Delete all notes and TODO lists?',
        'All saved project notes and TODO lists will be permanently deleted.','Delete All',()=>{
            try{Notes.clear();render();status.label='All notes and TODO lists deleted.';}catch(_){status.label='Unable to delete. Please retry.';}
        }));
    refresh.connect('clicked',render);root.connect('map',render);render();return root;
}
