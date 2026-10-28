const {Clutter, Gio, GLib, St} = imports.gi;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Me = imports.misc.extensionUtils.getCurrentExtension();

var Controller = class Controller {
    _buildSettings() {
        const indicator = this._indicator;
        const toolbar = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        toolbar.remove_all_children();
        toolbar.add_style_class_name('pingoose-toolbar');
        indicator.menu.addMenuItem(toolbar, 0);
        indicator.toolbarItem = toolbar;
        const mainItems = indicator.menu._getMenuItems();

        const gear = new St.Button({style_class: 'pingoose-settings-button', can_focus: true,
            x_expand: false, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START, accessible_name: 'More options'});
        gear.set_child(new St.Label({text: '⋮', style_class: 'pingoose-more-icon'}));
        const toolbarSpace = new St.Widget({x_expand: true});
        toolbar.add_child(toolbarSpace);
        const refreshStatus=new St.BoxLayout({style:'spacing: 4px;',y_align:Clutter.ActorAlign.CENTER});
        this._refreshSpinner=Me.imports.ui.spinner.create(18);
        this._refreshResult=new St.Icon({icon_name:'emblem-ok-symbolic',icon_size:18});
        refreshStatus.add_child(this._refreshSpinner);refreshStatus.add_child(this._refreshResult);
        this._refreshSpinner.hide();this._refreshResult.hide();
        toolbar.add_child(refreshStatus);toolbar.add_child(gear);
        toolbar.connect('destroy',()=>{
            if(this._refreshTimer)GLib.source_remove(this._refreshTimer);
            this._refreshTimer=0;this._refreshPending=false;
        });
        const welcome = new PopupMenu.PopupMenuSection();
        indicator.menu.addMenuItem(welcome);
        // A plain full-width container avoids menu-item ornament/indent columns.
        const welcomeContent = new St.BoxLayout({vertical: true, x_expand: true,
            style_class: 'pingoose-welcome-content'});
        welcomeContent.add_child(new St.Label({text: 'Pingoose 42 Info', x_expand: true,
            x_align: Clutter.ActorAlign.CENTER, style_class: 'pingoose-welcome-title'}));
        const loginButton = new St.Button({can_focus: true, x_expand: true,
            x_align: Clutter.ActorAlign.CENTER, style_class: 'pingoose-login-button'});
        loginButton.set_child(new St.Label({text: 'Log in to 42 Intra',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
        loginButton.connect('clicked', () => { indicator.menu.close(); this._send('login'); });
        welcomeContent.add_child(loginButton);
        welcome.actor.add_child(welcomeContent);
        const settings = new PopupMenu.PopupMenu(gear, 1.0, St.Side.TOP);
        Main.uiGroup.add_child(settings.actor);
        settings.actor.hide();
        this._optionsMenu = settings;
        this._optionsManager ||= new PopupMenu.PopupMenuManager(indicator);
        this._optionsManager.addMenu(settings);
        settings.addAction('Visit 42 Intra', () => { indicator.menu.close(); this._send('show'); });
        settings.addAction('Refresh', () => {
            settings.close();
            if(indicator.loginOnly || this._refreshPending)return;
            this._refreshPending=true;this._refreshWorkerDone=false;this._refreshSlotsDone=false;
            if(this._refreshTimer)GLib.source_remove(this._refreshTimer);
            this._refreshResult.hide();this._refreshSpinner.show();this._updatePanelLabel();
            this._refreshTimer=GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,90,()=>{
                this._refreshTimer=0;this._finishRefresh(false);return GLib.SOURCE_REMOVE;
            });
            this._send('refresh');this._requestSlots('slots:list');
        });
        settings.addAction('Settings', () => {
            indicator.menu.close();
            imports.misc.extensionUtils.openPrefs();
        });
        const Flags=Me.imports.models.featureFlags;
        const devMenu=Me.imports.dev.devOptions.addOptions(settings,()=>this._message({type:'notification',
            id:`test:${GLib.get_monotonic_time()}`,test:true,body:'Test notification'}),row=>{
                if(!Flags.enabled(this._settings,'hidden-dev-options'))return;
                const profile=this._indicator.lastProfile;
                const login=profile?.login || GLib.get_user_name();
                const seat=String(profile?.location || GLib.get_host_name()).split('.')[0].toLowerCase();
                row.users=[login];row.seats={[login]:/^c\d+r\d+s\d+$/.test(seat)?seat:'Unavailable'};
                row.names=profile?.name?{[login]:profile.name}:{};
                row.devSelf=true;row.avatars=[login];row.chatConfirmedAt={[login]:Date.now()};
                this._evaluations=[...this._evaluations,row];this._saveCardState();this._renderEvaluations();settings.close();
                this._message(Me.imports.models.evaluations.notification(row));
            },this._settings,row=>{
                if(!Flags.enabled(this._settings,'hidden-dev-options'))return;
                this._agendaAll=[...(this._agendaAll || this._agenda),row];this._agenda=[...this._agenda,row];this._renderAgenda();settings.close();
                this._message({type:'notification',id:row.id,category:'agenda',body:'New agenda event · Test Agenda'});
            },()=>{settings.close();this._message({type:'test-maintenance'});});
        const syncDev=()=>{devMenu.visible=Flags.enabled(this._settings,'hidden-dev-options');};
        syncDev();
        const showMain = () => {
            for (const item of mainItems) item.actor.visible = !indicator.loginOnly;
            welcome.actor.visible = indicator.loginOnly;
            this._syncOptionalSections();
        };
        const sync = () => this._applyTheme();
        this._themeChanged = this._settings.connect('changed', (_settings, key) => {
            if (['update-check-request', 'agenda-calendar-status', 'sync-agenda-calendar', 'deleted-calendar-events'].includes(key)) return;
            if (key === 'logout-request') {
                if(!this._resetting){this._chatPanel?.reset();this._send('logout');}
                return;
            }
            if (key === 'agenda-reset-request') {
                if(!this._resetting){this._restoreAgenda();this._send('agenda:refresh');}
                return;
            }
            if (key === 'dismissed-agenda-ids') {
                this._dismissedAgendaIds=new Set(this._settings.get_strv(key));
                this._agenda=(this._agendaAll || []).filter(row=>!this._dismissedAgendaIds.has(String(row.id)));
                this._renderAgenda();
                return;
            }
            if (key === 'reset-request') { this._requestFullReset(); return; }
            if (key === 'reset-status' || this._resetting) return;
            syncDev(); sync(); this._applyPanelLayout(); showMain();
            if(['hidden-auto-slots','hidden-options-unlocked'].includes(key))this._renderSlots();
        });
        sync(); this._applyPanelLayout();
        indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (!open) {
                settings.close();
                if(this._settings.get_boolean('auto-close-panels')){
                    if(this._servicePanel){this._servicePanel.expanded=false;this._servicePanel.sync();}
                    if(this._projectPanel){this._projectPanel.capture();this._projectPanel.expanded=false;this._projectPanel.sync();}
                    if(this._chatPanel){if(this._chatPanel._favorites)this._chatPanel._favorites.expanded=false;this._chatPanel._expanded=false;this._chatPanel.sync();}
                }
            }
            if (open) {
                settings.close();
                this._slotCreateExpanded=false;
                this._slotDraft=null;
                this._agendaExpanded?.clear();
                this._renderSlots();
                if(this._slotsExpanded && !indicator.loginOnly)this._requestSlots('slots:list');
                this._renderAgenda();
                showMain();
                this._unreadIds.clear();
                for (const notification of this._notifications) notification.unread = false;
                this._saveCardState();
                this._updatePanelLabel();
            }
        });
        indicator.onLoginStateChanged = () => { settings.close(); showMain(); };
        gear.connect('clicked', () => settings.toggle());
        showMain();
    }

    _checkRefreshDone() {
        if(this._refreshPending && this._refreshWorkerDone && this._refreshSlotsDone)this._finishRefresh(true);
    }

    _finishRefresh(success) {
        this._refreshPending=false;
        this._updatePanelLabel();
        if(this._refreshTimer)GLib.source_remove(this._refreshTimer);
        this._refreshSpinner.hide();
        this._refreshResult.gicon=new Gio.FileIcon({file:Gio.File.new_for_path(Me.path+'/assets/spinner/'+(success?'complete.svg':'incomplete-symbolic.svg'))});
        this._refreshResult.accessible_name=success?'Refresh complete':'Refresh incomplete. Try again.';
        this._refreshResult.show();
        this._refreshTimer=GLib.timeout_add(GLib.PRIORITY_DEFAULT,success?2000:4000,()=>{
            this._refreshTimer=0;this._refreshResult.hide();return GLib.SOURCE_REMOVE;
        });
    }

    _applyTheme() {
        const actor=this._indicator.menu.actor;
        actor.remove_style_class_name('pingoose-dark');
        actor.remove_style_class_name('pingoose-light');
        actor.add_style_class_name(`pingoose-${this._settings.get_string('theme')}`);
    }

};

function SettingsManager(indicator, settings, options = {}) {
    this._indicator = indicator;
    this._settings = settings;
    Object.assign(this, options);
}
SettingsManager.prototype = Object.create(Controller.prototype);
SettingsManager.prototype.constructor = SettingsManager;
