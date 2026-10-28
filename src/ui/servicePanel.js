const {Clutter, Gio, GLib, St} = imports.gi;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Sites = Me.imports.models.serviceSites;
var ServicePanel = class ServicePanel {
    constructor(indicator, send) {
        this.send = send;
        this.indicator = indicator;
        this.settings = imports.misc.extensionUtils.getSettings();
        this.expanded = this.settings.get_boolean('expand-services');
        this.previews = new Set();
        this.root = new St.BoxLayout({vertical: true, reactive: true, visible: false,
            y_expand: false, y_align: Clutter.ActorAlign.START, style_class: 'pingoose-chat-panel pingoose-service-panel'});
        indicator.sideColumns.insert_child_at_index(this.root, 0);
        const header = new St.BoxLayout({style_class: 'pingoose-chat-header'});
        header.add_child(new St.Label({text: '42 Services', x_expand: true, style_class: 'pingoose-heading'}));
        const close = new St.Button({label: '×', can_focus: true, accessible_name: 'Close 42 Services', style_class: 'pingoose-dismiss'});
        close.connect('clicked', () => { this.expanded=false; this.sync(); });
        header.add_child(close); this.root.add_child(header);
        const scroll = new St.ScrollView({overlay_scrollbars: false, style_class: 'pingoose-service-scroll'});
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this.cards = new St.BoxLayout({vertical: true, style_class: 'pingoose-service-cards'});
        scroll.add_actor(this.cards); this.root.add_child(scroll);
        this.item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this.item.remove_all_children(); this.item.add_style_class_name('pingoose-overview-item');
        const button = new St.Button({label: '42 Services', can_focus: true, x_expand: true, style_class: 'pingoose-visit-intra'});
        this.button=button;
        button.connect('clicked', () => { this.expanded=!this.expanded; if(this.expanded)this.indicator.bringPanelNearMain(this.root); this.sync(); });
        this.item.add_child(button); indicator.menu.addMenuItem(this.item);
        this.signal = this.settings.connect('changed', (_s,key) => {
            if (key==='service-sites') this.render();
            if (key==='service-enabled' && !this.settings.get_boolean(key)) {
                this.expanded=false;
                this.send('service:close');
                for (const process of this.previews) process.force_exit();
            }
            this.sync();
        });
        this.menuSignal = indicator.menu.connect('open-state-changed', () => this.sync());
        this.render(); this.sync();
    }
    sync() {
        if(this.settings.get_boolean('expand-services')!==this.expanded)this.settings.set_boolean('expand-services',this.expanded);
        const visible = !this.indicator.loginOnly && this.settings.get_boolean('service-enabled') && this.settings.get_boolean('show-services');
        this.item.visible=visible;
        this.root.visible=visible && this.expanded;
        this.button.style_class='pingoose-visit-intra'+(this.root.visible ? ' pingoose-toggle-active' : '');
        this.indicator.syncPanelLayout?.();
        if (this.root.visible && this.indicator.menu.isOpen) this.loadPreviews();
    }
    render() {
        for (const process of this.previews) process.force_exit();
        this.cards.destroy_all_children();
        this.entries=[];
        for (const site of Sites.readSites(this.settings)) {
            const button = new St.Button({can_focus:true, x_expand:true, style_class:'pingoose-service-card'});
            const content = new St.BoxLayout({x_expand:true, style_class:'pingoose-service-card-content'});
            const picture = new St.Bin({width:48,height:48,y_align:Clutter.ActorAlign.CENTER,style_class:'pingoose-service-picture'});
            picture.set_child(new St.Icon({icon_name:'web-browser-symbolic',icon_size:24}));
            content.add_child(picture);
            content.add_child(new St.Label({text:site.name,x_expand:true,y_align:Clutter.ActorAlign.CENTER,style_class:'pingoose-service-name'}));
            button.set_child(content);
            button.connect('clicked', () => this.open(site));
            this.cards.add_child(button);
            this.entries.push({site,picture,requested:false});
        }
        if (!this.entries.length) this.cards.add_child(new St.Label({text:'Add websites in Settings → 42 Services.'}));
    }
    loadPreviews() {
        for (const entry of this.entries) {
            if (this.previews.size >= 2) break;
            if (entry.requested) continue;
            entry.requested=true;
            const directory=GLib.build_filenamev([GLib.get_user_cache_dir(),'pingoose','service-icons-v2']);
            try {
                const process=Gio.Subprocess.new(['/usr/bin/python3',`${Me.path}/worker/servicePreview.py`,entry.site.url,directory],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
                this.previews.add(process);
                process.communicate_utf8_async(null,null,(child,result)=>{
                    this.previews.delete(child);
                    try {
                        const [,output]=child.communicate_utf8_finish(result);
                        if (this.destroyed || !child.get_successful() || !this.entries.includes(entry)) return;
                        const path=output.trim();
                        if (!path.startsWith(directory+'/') || !/\/[a-f0-9]{64}\.png$/.test(path)) return;
                        entry.picture.set_child(new St.Icon({gicon:new Gio.FileIcon({file:Gio.File.new_for_path(path)}),icon_size:32}));
                    } catch (_) {}
                    finally { if (!this.destroyed) this.sync(); }
                });
            } catch (_) {}
        }
    }
    open(site) {
        if (!this.settings.get_boolean('service-enabled')) return;
        try {
            this.send('service:open:' + JSON.stringify(site));
            this.indicator.menu.close();
        } catch (_) { Main.notify('42 Services','Unable to open the website.'); }
    }
    destroy() {
        this.destroyed=true;
        this.settings.disconnect(this.signal);
        this.indicator.menu.disconnect(this.menuSignal);
        for (const process of this.previews) process.force_exit();
    }
};
