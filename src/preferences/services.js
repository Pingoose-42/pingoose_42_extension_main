const {Gtk, Gio} = imports.gi;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Sites = Me.imports.models.serviceSites;
const Common = Me.imports.preferences.common;
function build(settings) {
    const box = new Gtk.Box({orientation:Gtk.Orientation.VERTICAL,spacing:12,
        margin_top:24,margin_bottom:24,margin_start:24,margin_end:24});
    Common.sectionHeading(box, 'Service Panel', false);
    const toggle = new Gtk.Switch({valign:Gtk.Align.CENTER});
    settings.bind('service-enabled',toggle,'active',Gio.SettingsBindFlags.DEFAULT);
    const header = new Gtk.Box({spacing:12});
    header.append(new Gtk.Label({label:'Enable 42 Services',xalign:0,hexpand:true})); header.append(toggle);box.append(header);
    Common.sectionHeading(box, 'Add Website');
    const name = new Gtk.Entry({placeholder_text:'Site name'});
    const url = new Gtk.Entry({placeholder_text:'https://example.org/'});
    box.append(name);box.append(url);
    const actions = new Gtk.Box({spacing:8});
    const add = new Gtk.Button({label:'Add Website'});
    const reset = new Gtk.Button({label:'Restore Defaults'});
    actions.append(add);actions.append(reset);box.append(actions);
    const error = new Gtk.Label({label:'',xalign:0,wrap:true});box.append(error);
    Common.sectionHeading(box, 'Saved Websites');
    const list=new Gtk.Box({orientation:Gtk.Orientation.VERTICAL,spacing:12});box.append(list);
    const save = sites => settings.set_string('service-sites',JSON.stringify(sites));
    const render = () => Common.preserveListScroll(list, list, () => {
        let child;while((child=list.get_first_child())) list.remove(child);
        const sites=Sites.readSites(settings);
        sites.forEach((site,index)=>{
            const row=new Gtk.Box({orientation:Gtk.Orientation.VERTICAL,spacing:6});
            const title=new Gtk.Entry({text:site.name});const address=new Gtk.Entry({text:site.url});
            row.append(title);row.append(address);
            const buttons=new Gtk.Box({spacing:8});
            const update=new Gtk.Button({label:'Save'});const remove=new Gtk.Button({label:'Remove'});
            update.connect('clicked',()=>{
                const value=Sites.normalizeSite(title.get_text(),address.get_text());
                if(!value){error.label='Enter a name and a valid HTTPS URL.';return;}
                const current=Sites.readSites(settings);current[index]=value;save(current);error.label='';render();
            });
            remove.connect('clicked',()=>{save(Sites.readSites(settings).filter((_s,i)=>i!==index));render();});
            buttons.append(update);buttons.append(remove);row.append(buttons);list.append(row);
        });
    });
    add.connect('clicked',()=>{
        const site=Sites.normalizeSite(name.get_text(),url.get_text());const sites=Sites.readSites(settings);
        if(!site || sites.length>=30){error.label='Enter a name and a valid HTTPS URL (maximum 30 websites).';return;}
        if(sites.some(item=>item.url===site.url)){error.label='This URL is already in the list.';return;}
        save([...sites,site]);name.set_text('');url.set_text('');error.label='';render();
    });
    reset.connect('clicked',()=>{settings.reset('service-sites');error.label='';render();});
    box.connect('map',render);render();return box;
}
