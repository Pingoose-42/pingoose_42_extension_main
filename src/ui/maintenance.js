const {Gio,GLib,St,Clutter}=imports.gi;
const PopupMenu=imports.ui.popupMenu;
const Me=imports.misc.extensionUtils.getCurrentExtension();
const Model=Me.imports.models.maintenance;
var Controller=class Controller {
    constructor(indicator,restore,refresh) {
        this.indicator=indicator;this.restore=restore;this.refresh=refresh;this.hidden=new Map();this.active=false;
        this.file=Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_cache_dir(),'pingoose','maintenance.json']));
        try {const [ok,bytes]=this.file.load_contents(null);if(ok){const saved=JSON.parse(imports.byteArray.toString(bytes));if(saved.login===GLib.get_user_name()){this.schedule=Model.valid(saved.schedule)?saved.schedule:null;this.profile=saved.profile;}}}catch(_){}
        this.item=new PopupMenu.PopupBaseMenuItem({reactive:false,can_focus:false});
        this.item.remove_all_children();
        this.item.add_style_class_name('pingoose-scroll-container');
        const content=new St.BoxLayout({vertical:true,x_expand:true,style_class:'pingoose-maintenance-notice pingoose-section-toggle'});
        const title=new St.Label({text:'Intranet maintenance in progress',style_class:'pingoose-maintenance-title'});
        title.clutter_text.line_wrap=true;
        this.label=new St.Label({x_expand:true,style_class:'pingoose-maintenance-body'});this.label.clutter_text.line_wrap=true;
        const header=new St.BoxLayout({style_class:'pingoose-maintenance-header'});
        title.x_expand=true;title.y_align=Clutter.ActorAlign.CENTER;
        this.failure=new St.Label({text:'×',visible:false,y_align:Clutter.ActorAlign.CENTER,style_class:'pingoose-maintenance-failure',accessible_name:'Connection check failed'});
        this.refreshButton=new St.Button({can_focus:true,y_align:Clutter.ActorAlign.CENTER,style_class:'pingoose-maintenance-refresh',accessible_name:'Check Intra availability'});
        this.refreshIcon=new St.Icon({icon_name:'view-refresh-symbolic',icon_size:18});
        this.spinner=Me.imports.ui.spinner.create(18);this.spinner.hide();
        const icons=new St.BoxLayout();icons.add_child(this.refreshIcon);icons.add_child(this.spinner);this.refreshButton.set_child(icons);
        this.refreshButton.connect('clicked',()=>this.check());
        const controls=new St.BoxLayout({width:62,style_class:'pingoose-maintenance-controls'});
        const failureSlot=new St.Bin({width:20,y_align:Clutter.ActorAlign.CENTER});failureSlot.set_child(this.failure);
        controls.add_child(failureSlot);controls.add_child(this.refreshButton);
        header.add_child(new St.Widget({width:62}));header.add_child(title);header.add_child(controls);
        content.add_child(header);content.add_child(this.label);
        const description=new St.Label({text:'42 Auth and Intranet may be unavailable.',x_expand:true,style_class:'pingoose-maintenance-body pingoose-maintenance-description'});
        description.clutter_text.line_wrap=true;content.add_child(description);
        this.item.add_child(content);indicator.menu.addMenuItem(this.item);this.item.hide();
        this.timer=GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,1,()=>{this.sync();return GLib.SOURCE_CONTINUE;});
        this.sync();
    }
    observe(message) {
        if(message.login!==GLib.get_user_name())return;
        const schedule=Model.parse(message.maintenanceText);
        if(schedule && schedule.end>Date.now())this.schedule=schedule;
        if(!this.active && message.name)this.profile={...this.indicator.lastProfile,...message,maintenanceText:undefined};
        const serialized=JSON.stringify({login:message.login,schedule:this.schedule,profile:this.profile});
        if(serialized!==this.saved){
            try{GLib.mkdir_with_parents(this.file.get_parent().get_path(),0o700);this.file.replace_contents(imports.byteArray.fromString(serialized),null,false,Gio.FileCreateFlags.PRIVATE,null);this.saved=serialized;}catch(_){}
        }
        this.sync();
    }
    check() {
        if(this.busy || !this.active)return;
        this.busy=true;this.failure.hide();this.refreshIcon.hide();this.spinner.show();this.refreshButton.reactive=false;
        this.checkTimer=GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,90,()=>{this.checkTimer=0;this.result('failed');return GLib.SOURCE_REMOVE;});
        try{this.refresh();}catch(_){this.result('failed');}
    }
    result(state) {
        if(!this.busy || !['complete','failed'].includes(state))return;
        this.busy=false;if(this.checkTimer)GLib.source_remove(this.checkTimer);this.checkTimer=0;
        this.spinner.hide();this.refreshIcon.show();this.refreshButton.reactive=true;
        if(state==='complete'){
            this.bypassEnd=(this.testSchedule || this.schedule)?.end;
            this.sync();
        }else this.failure.show();
    }
    test() {
        this.bypassEnd=null;
        this.testSchedule={start:Date.now(),end:Date.now()+60000};
        this.profile=this.indicator.lastProfile || this.profile;
        this.sync();
    }
    sync() {
        if(this.testSchedule && Date.now()>=this.testSchedule.end)this.testSchedule=null;
        const schedule=this.testSchedule || this.schedule;
        const enabled=Model.active(schedule) && this.bypassEnd!==schedule.end;
        if(!enabled){
            if(this.active){this.active=false;this.release();this.restore();}
            this.item.hide();return;
        }
        if(!this.active){this.active=true;if(this.profile?.login===GLib.get_user_name())this.indicator.updateProfile(this.profile);}
        this.label.text=`${Model.label(schedule).replace(' – ', ' –\n')}`;
        this.item.show();
        const profile=this.indicator.profileItem.actor || this.indicator.profileItem;
        const notice=this.item.actor || this.item;
        const actors=[...this.indicator.menu.box.get_children(),...this.indicator.sideColumns.get_children().filter(a=>a!==this.indicator.menu.box)];
        for(const actor of actors){
            if(actor===notice || actor===profile)continue;
            if(!this.hidden.has(actor)){
                const record={visible:actor.visible,signal:0};
                record.signal=actor.connect('notify::visible',()=>{if(this.active && actor.visible){record.visible=true;actor.hide();}});
                this.hidden.set(actor,record);
            }
            actor.hide();
        }
        profile.visible=!!this.profile || this.indicator.profileReady;
    }
    release(){for(const [actor,record] of this.hidden){actor.disconnect(record.signal);actor.visible=record.visible;}this.hidden.clear();}
    destroy(){if(this.checkTimer)GLib.source_remove(this.checkTimer);if(this.timer)GLib.source_remove(this.timer);this.active=false;this.release();this.item.destroy();}
};
