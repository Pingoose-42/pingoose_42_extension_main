const CountLabel = imports.misc.extensionUtils.getCurrentExtension().imports.ui.countLabel;
const {Clutter, Gio, GLib, GObject, Pango, St} = imports.gi;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Me = imports.misc.extensionUtils.getCurrentExtension();

function deadlineText(deadline, today = new Date()) {
    if (typeof deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return '—';
    const [year, month, day] = deadline.split('-').map(Number);
    const target = Date.UTC(year, month - 1, day);
    if (new Date(target).toISOString().slice(0, 10) !== deadline) return '—';
    const parts = new Intl.DateTimeFormat('en', {timeZone: 'Asia/Seoul',
        year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(today);
    const get = type => Number(parts.find(part => part.type === type).value);
    const current = Date.UTC(get('year'), get('month') - 1, get('day'));
    const remaining = Math.round((target - current) / 86400000);
    const suffix = remaining < 0 ? `${-remaining} days overdue` : `${remaining} days remain`;
    return `${year}. ${month}. ${day}. (${suffix})`;
}

function releasePointerHighlight(item) {
    item.connect('leave-event', () => {
        item.active = false;
        if (global.stage.get_key_focus() === item) global.stage.set_key_focus(null);
        return Clutter.EVENT_PROPAGATE;
    });
    return item;
}

var Indicator = GObject.registerClass(class PingooseIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Pingoose');
        this.accessible_name = 'Pingoose Notifications';
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._initFlapIcon();
        box.add_child(this.icon);
        this.loadingIcon=Me.imports.ui.spinner.create(20);
        this.loadingIcon.hide();box.add_child(this.loadingIcon);
        this.count = new St.Label({text: '42', y_align: Clutter.ActorAlign.CENTER, style_class: 'pingoose-count'});
        box.add_child(this.count);
        const syncStatus = () => { this.count.visible = this.count.text !== '42' && this.count.text !== ''; };
        this.count.connect('notify::text', syncStatus);
        syncStatus();
        this.add_child(box);
        const profileItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        profileItem.remove_all_children();
        this.profileItem = profileItem;
        profileItem.add_style_class_name('pingoose-overview-item');
        profileItem.add_style_class_name('pingoose-profile-container');
        const profile = new St.BoxLayout({vertical: true, style_class: 'pingoose-profile'});
        const identity = new St.BoxLayout({style_class: 'pingoose-identity'});
        this.avatar = new St.Bin({width: 64, height: 64, y_align: Clutter.ActorAlign.CENTER, style_class: 'pingoose-avatar'});
        this.avatar.set_child(new St.Icon({icon_name: 'avatar-default-symbolic', icon_size: 40}));
        identity.add_child(this.avatar);
        const names = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.profileHeader = new St.BoxLayout({x_expand: true, style_class: 'pingoose-profile-header'});
        this.profileName = new St.Label({text: 'Loading profile…', style_class: 'pingoose-profile-name'});
        this.profileLogin = new St.Label({text: '', style_class: 'pingoose-profile-login'});
        this.profileName.x_expand = true;
        this.profileName.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.profileHeader.add_child(this.profileName);
        names.add_child(this.profileHeader);

        identity.add_child(names);
        profile.add_child(identity);
        const stats = new St.BoxLayout({style_class: 'pingoose-profile-stats'});
        stats.add_child(this.profileLogin);
        this.profileLevel = new St.Label({text: 'Lv.—', style_class: 'pingoose-profile-level', y_align: Clutter.ActorAlign.CENTER});
        stats.add_child(this.profileLevel);
        const track = new St.Widget({style_class: 'pingoose-progress-track', height: 5, width: 90, y_align: Clutter.ActorAlign.CENTER});
        this.profileProgress = new St.Widget({style_class: 'pingoose-progress-fill', height: 5, width: 0});
        track.add_child(this.profileProgress);
        stats.add_child(track);
        this.profilePercent = new St.Label({text: '(—%)', y_align: Clutter.ActorAlign.CENTER});
        stats.add_child(this.profilePercent);
        this.profilePoints = new St.Label({text: 'Ev.P —', y_align: Clutter.ActorAlign.CENTER});
        stats.add_child(this.profilePoints);
        names.add_child(stats);
        const deadline = new St.BoxLayout({style_class: 'pingoose-deadline-row'});
        this.profilePace = new St.Label({text: 'Pace — ·', style_class: 'pingoose-profile-pace'});
        deadline.add_child(this.profilePace);
        this.deadlineCaption = new St.Label({text: 'Milestone Deadline :', style_class: 'pingoose-profile-caption'});
        deadline.add_child(this.deadlineCaption);
        this.profileDeadline = new St.Label({text: '—', style_class: 'pingoose-profile-deadline'});
        deadline.add_child(this.profileDeadline);
        profile.add_child(deadline);
        this.profileContent = profile;
        this.profileLoading = Me.imports.ui.spinner.create(32);
        this.profileLoading.x_expand=true;this.profileLoading.x_align=Clutter.ActorAlign.CENTER;
        profileItem.add_child(this.profileLoading);
        profileItem.add_child(profile);
        profile.hide();
        this.profileReady = false;
        this.avatarReady = false;
        this.studyReady = false;
        this.loadingTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this.checkProfileReady();
            if (!this.profileReady) {
                if (!this.loginOnly) this.count.text = '';
            }
            this.onCountChanged?.();
            return GLib.SOURCE_CONTINUE;
        });
        this.connect('destroy', () => {
            if (this.loadingTimer) GLib.source_remove(this.loadingTimer);
            this.loadingTimer = 0;
        });
        this.menu.addMenuItem(profileItem);
        this.profileSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this.profileSeparator);
        const overviewItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        overviewItem.remove_all_children();
        const overview = new St.BoxLayout({style_class: 'pingoose-overview', x_expand: true});
        const projectsColumn = new St.BoxLayout({vertical: true, style_class: 'pingoose-overview-column'});
        const myProjects=this.myProjectsButton=new St.Button({label:'My Projects',button_mask:St.ButtonMask.ONE,can_focus:true,x_align:Clutter.ActorAlign.START,style_class:'pingoose-project-heading'});
        this.projectButtons=new Map();
        this.syncProjectButtons=slug=>{
            this.activeProjectSlug=slug;
            for(const [key,button] of this.projectButtons){
                if(key===slug)button.add_style_class_name('pingoose-project-selected');
                else button.remove_style_class_name('pingoose-project-selected');
            }
            myProjects.style_class='pingoose-project-heading'+(slug==='__my_projects__'?' pingoose-toggle-active':'');
        };
        myProjects.connect('clicked',()=>{if(this.lastProfile?.login)this.onProjectOpen?.({slug:'__my_projects__',name:'My Projects',login:this.lastProfile.login});});
        projectsColumn.add_child(myProjects);
        this.projects = new PopupMenu.PopupMenuSection();
        const projectsLoading=new PopupMenu.PopupBaseMenuItem({reactive:false,can_focus:false});
        projectsLoading.add_child(Me.imports.ui.spinner.create(20));this.projects.addMenuItem(projectsLoading);
        const projectScroll = new St.ScrollView({style_class: 'pingoose-project-scroll', overlay_scrollbars: false});
        projectScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        projectScroll.add_actor(this.projects.actor);
        projectsColumn.add_child(projectScroll);
        overview.add_child(projectsColumn);
        const study = new St.BoxLayout({vertical: true, style_class: 'pingoose-overview-column pingoose-logtime-column'});
        this.logtimeTitle = new St.Label({text: '', style_class: 'pingoose-heading'});
        this.monthTime = new St.Label({text: '—', style_class: 'pingoose-study-value'});
        this.todayTime = new St.Label({text: 'Today: —', style_class: 'pingoose-study-value'});
        study.add_child(this.logtimeTitle);
        const studyRows = new PopupMenu.PopupMenuSection();
        for (const value of [this.monthTime, this.todayTime]) {
            const row = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            row.add_style_class_name('pingoose-project-item');
            row.add_child(value);
            studyRows.addMenuItem(row);
        }
        study.add_child(studyRows.actor);
        overview.add_child(study);
        overviewItem.add_style_class_name('pingoose-overview-item');
        this.overviewItem = overviewItem;
        this.projectsColumn = projectsColumn;
        this.studyColumn = study;
        overviewItem.add_child(overview);
        this.menu.addMenuItem(overviewItem);
        const visitItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        visitItem.remove_all_children();
        // Use the same outer menu-item inset as the overview above.
        visitItem.add_style_class_name('pingoose-overview-item');
        visitItem.add_style_class_name('pingoose-visit-row');
        this.visitIntra = new St.Button({can_focus: true,
            x_expand: true, x_align: Clutter.ActorAlign.FILL, style_class: 'pingoose-visit-intra'});
        this.visitIntra.set_child(new St.Label({text: 'Evaluation Slots', x_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
        visitItem.add_child(this.visitIntra);
        this.menu.addMenuItem(visitItem);
        this.slotsButtonItem = visitItem;
        this.slotItems = new PopupMenu.PopupMenuSection();
        const slotScroll = new St.ScrollView({style_class: 'pingoose-evaluation-scroll pingoose-slot-scroll', overlay_scrollbars: false});
        slotScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        slotScroll.add_actor(this.slotItems.actor);
        this.slotsItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this.slotsItem.remove_all_children();
        this.slotsItem.add_style_class_name('pingoose-scroll-container');
        this.slotsItem.add_child(slotScroll);
        this.menu.addMenuItem(this.slotsItem);
        this.slotsItem.hide();

        this.refreshLogtimeTitle();
        this.overviewSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this.overviewSeparator);
        // Keep worker diagnostics internal; the notifications area only shows cards.
        this.status = {label: {text: ''}};
        this.evaluations = new PopupMenu.PopupMenuSection();
        const evaluationScroll = new St.ScrollView({style_class: 'pingoose-evaluation-scroll pingoose-evaluation-info-scroll', can_focus: true, overlay_scrollbars: false});
        evaluationScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        evaluationScroll.add_actor(this.evaluations.actor);
        this.evaluationScroll = evaluationScroll;
        const evaluationItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        evaluationItem.remove_all_children();
        evaluationItem.add_style_class_name('pingoose-scroll-container');
        const evaluationArea = new St.BoxLayout({vertical: true, x_expand: true});
        this.evaluationToggle=this._sectionToggle('Evaluation Info',evaluationScroll,'expand-evaluations');
        evaluationArea.add_child(this.evaluationToggle);
        evaluationArea.add_child(evaluationScroll);
        evaluationItem.add_child(evaluationArea);
        this.evaluationItem = evaluationItem;
        this.menu.addMenuItem(evaluationItem);
        this.agenda = new PopupMenu.PopupMenuSection();
        const agendaScroll = new St.ScrollView({style_class: 'pingoose-evaluation-scroll pingoose-agenda-scroll', can_focus: true, overlay_scrollbars: false});
        agendaScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        agendaScroll.add_actor(this.agenda.actor);
        this.agendaScroll = agendaScroll;
        this.agendaItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this.agendaItem.remove_all_children();
        this.agendaItem.add_style_class_name('pingoose-scroll-container');
        const agendaArea=new St.BoxLayout({vertical:true,x_expand:true});
        this.agendaToggle=this._sectionToggle('Agenda',agendaScroll,'expand-agenda');
        agendaArea.add_child(this.agendaToggle);agendaArea.add_child(agendaScroll);
        this.agendaItem.add_child(agendaArea);
        this.menu.addMenuItem(this.agendaItem);
        this.cards = new PopupMenu.PopupMenuSection();
        const list = new St.ScrollView({style_class: 'pingoose-list', overlay_scrollbars: false, x_expand: true});
        list.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        list.add_actor(this.cards.actor);
        const listItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        listItem.remove_all_children();
        listItem.add_style_class_name('pingoose-list-container');
        const notificationArea = new St.BoxLayout({vertical: true, x_expand: true});
        this.notificationToggle=this._sectionToggle('Notifications',list,'expand-notifications');
        notificationArea.add_child(this.notificationToggle);
        notificationArea.add_child(list);
        listItem.add_child(notificationArea);
        this.notificationItem = listItem;
        this.menu.addMenuItem(listItem);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) this.refreshLogtimeTitle();
            if (open && this.lastProfile) this.updateProfile(this.lastProfile);
        });
        this.setLoginOnly(true);
    }

    _sectionToggle(title,content,key) {
        const preferences=imports.misc.extensionUtils.getSettings();
        const button=new St.Button({can_focus:true,x_expand:true,style_class:'pingoose-visit-intra pingoose-section-toggle'});
        button.set_child(new St.Label({text:title,x_expand:true,x_align:Clutter.ActorAlign.CENTER}));
        button.expanded=key ? preferences.get_boolean(key) : true;
        button.updateCount=(count,attention=0)=>{
            CountLabel.update(button.get_child(), title, count, button.expanded, attention);
            button.style_class='pingoose-visit-intra pingoose-section-toggle'+(button.expanded ? ' pingoose-toggle-active' : '');
            button.sectionCount=count;
            button.attentionCount=attention;
            content.visible=button.expanded;
        };
        button.connect('clicked',()=>{
            button.expanded=!button.expanded;
            if(key)preferences.set_boolean(key,button.expanded);
            button.updateCount(button.sectionCount,button.attentionCount);
        });
        button.updateCount(0);
        return button;
    }

    _initFlapIcon() {
        const path = imports.misc.extensionUtils.getCurrentExtension().path;
        const frames = Array.from({length: 12}, (_, index) => new Gio.FileIcon({
            file: Gio.File.new_for_path(`${path}/assets/flap/flap-${String(index).padStart(2, '0')}-symbolic.svg`),
        }));
        this.icon = new St.Icon({gicon: frames[0], icon_size: 24, style_class: 'system-status-icon'});
        const settings = St.Settings.get();
        const preferences = imports.misc.extensionUtils.getSettings();
        let timer = 0;
        const stop = () => {
            if (timer) GLib.source_remove(timer);
            timer = 0;
        };
        const sync = () => {
            stop();
            this.icon.gicon = frames[0];
            if (!preferences.get_boolean('topbar-animation') || !settings.enable_animations || !this.icon.mapped) return;
            const started = GLib.get_monotonic_time();
            // The supplied flap sequence is 12 frames over 800 ms; skip stale frames after a stall.
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 67, () => {
                const elapsed = (GLib.get_monotonic_time() - started) / 1000;
                this.icon.gicon = frames[Math.floor(elapsed * frames.length / 800) % frames.length];
                return GLib.SOURCE_CONTINUE;
            });
        };
        const signal = settings.connect('notify::enable-animations', sync);
        const preferenceSignal = preferences.connect('changed::topbar-animation', sync);
        this.icon.connect('notify::mapped', sync);
        this.icon.connect('destroy', () => {
            stop();
            settings.disconnect(signal);
            preferences.disconnect(preferenceSignal);
        });
        sync();
    }

    checkProfileReady() {
        const data = this.lastProfile;
        if (!data || this.profileReady) return;
        const ready = data.name && Number.isFinite(data.level) && Number.isFinite(data.progress) &&
            Number.isFinite(data.points) &&
            ((data.paceApplicable === false || data.deadlineKind === 'alumnization') ||
                (Number.isFinite(data.pace) && data.deadline)) &&
            Array.isArray(data.projects) && this.avatarReady && this.studyReady;
        // A missing/failed optional resource must not conceal the whole profile forever.
        const timedOut = this.profileLoadStarted && GLib.get_monotonic_time() - this.profileLoadStarted >= 30000000;
        if (!ready && !timedOut) return;
        this.profileReady = true;
        this.profileLoading.hide();
        this.profileContent.show();
        this.count.text = '42';
    }

    refreshLogtimeTitle() {
        const month = new Intl.DateTimeFormat('en-US', {month: 'short'}).format(new Date());
        this.logtimeTitle.text = `Logtime: ${month}`;
    }

    updateProfile(data) {
        if (!this.profileLoadStarted) this.profileLoadStarted = GLib.get_monotonic_time();
        const previous = this.lastProfile?.login === data.login ? this.lastProfile : {};
        // A reloading Intra page briefly exposes 0% before its real level data arrives.
        // Confirm regressions across stable samples; a level-up to 0% remains immediate.
        const regressed=Number.isFinite(previous.level) && Number.isFinite(previous.progress) &&
            Number.isFinite(data.level) && Number.isFinite(data.progress) &&
            (data.level<previous.level || (data.level===previous.level && data.progress<previous.progress));
        if(regressed){
            const key=JSON.stringify([data.login,data.level,data.progress]);
            const now=GLib.get_monotonic_time();
            if(this._pendingExperience?.key!==key)this._pendingExperience={key,since:now};
            if(now-this._pendingExperience.since<5000000)data={...data,level:previous.level,progress:previous.progress};
            else this._pendingExperience=null;
        }else this._pendingExperience=null;

        const merged = {...previous};
        for (const [key, value] of Object.entries(data)) {
            if (value !== null && value !== undefined && value !== '') merged[key] = value;
        }
        data = merged;
        this.lastProfile = data;
        this.checkProfileReady();
        const renderKey = JSON.stringify([data, deadlineText(data.deadline)]);
        if (renderKey === this.profileRenderKey) return;
        this.profileRenderKey = renderKey;
        this.updateProjects(data);
        const number = (value, max) => Number.isFinite(value) && value >= 0 && value <= max ? value : null;
        const level = number(data.level, 1000);
        const progress = number(data.progress, 100);
        this.profileName.text = typeof data.name === 'string' && data.name.trim() ? data.name.slice(0, 100) : data.login;
        this.profileLogin.text = `@${data.login}`;
        this.profileLevel.text = `Lv.${level ?? '—'}`;
        this.profilePercent.text = `(${progress ?? '—'}%)`;
        const progressWidth=90 * (progress ?? 0) / 100;
        if(this.profileProgress.width!==progressWidth)this.profileProgress.width=progressWidth;
        this.profilePoints.text = `Ev.P ${number(data.points, 1000000) ?? '—'}`;
        const showPace = data.paceApplicable !== false && data.deadlineKind !== 'alumnization';
        this.profilePace.visible = showPace;
        this.profilePace.text = `Pace ${number(data.pace, 1000) ?? '—'} ·`;
        this.deadlineCaption.text = ({milestone: 'Milestone Deadline :', ultimate: 'Ultimate Deadline :',
            blackhole: 'Blackholed at :', alumnization: 'Alumnization :'})[data.deadlineKind] || 'Milestone Deadline :';
        this.profileDeadline.text = deadlineText(data.deadline);
        if (showPace && number(data.pace, 1000) === 24 && this.profileDeadline.text !== '—')
            this.profileDeadline.add_style_class_name('pingoose-deadline-danger');
        else
            this.profileDeadline.remove_style_class_name('pingoose-deadline-danger');
    }

    updateProjects(data) {
        if (!Array.isArray(data.projects) || !/^[a-zA-Z0-9_-]{1,64}$/.test(data.login)) return;
        const projects = data.projects.slice(0, 20).filter(project => project &&
            typeof project.name === 'string' && project.name.trim() &&
            typeof project.slug === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(project.slug));
        const key = JSON.stringify([data.login, projects]);
        if (key === this.projectsKey) return;
        this.projectsKey = key;
        this.projects.removeAll();
        this.projectButtons.clear();
        if (!projects.length) {
            this.projects.addMenuItem(new PopupMenu.PopupMenuItem('No active projects.', {reactive: false}));
            return;
        }
        for (const project of projects) {
            const item = releasePointerHighlight(new PopupMenu.PopupMenuItem(project.name.slice(0, 80)));
            item.add_style_class_name('pingoose-project-item');
            this.projectButtons.set(project.slug,item);
            if(project.slug===this.activeProjectSlug)item.add_style_class_name('pingoose-project-selected');
            item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            item.connect('button-press-event',(_actor,event)=>event.get_button()===1?Clutter.EVENT_PROPAGATE:Clutter.EVENT_STOP);
            item.connect('button-release-event',(_actor,event)=>event.get_button()===1?Clutter.EVENT_PROPAGATE:Clutter.EVENT_STOP);
            item.connect('activate', (_item,event) => {
                if(event?.type()===Clutter.EventType.BUTTON_RELEASE && event.get_button()!==1)return;
                this.onProjectOpen?.({slug: project.slug, name: project.name, login: data.login});
            });
            this.projects.addMenuItem(item);
        }
    }

    updateStudyTime(message) {
        if (message.login !== GLib.get_user_name()) return;
        const format = minutes => Number.isInteger(minutes) && minutes >= 0 && minutes <= 44640
            ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : '—';
        this.refreshLogtimeTitle();
        this.monthTime.text = format(message.monthMinutes);
        this.todayTime.text = `Today: ${format(message.todayMinutes)}`;
        this.studyReady = Number.isInteger(message.monthMinutes) && Number.isInteger(message.todayMinutes);
        this.checkProfileReady();
    }

    updateAvatar(login) {
        if (login !== GLib.get_user_name()) return;
        const image = Gio.File.new_for_path(GLib.build_filenamev([
            GLib.get_user_state_dir(), 'pingoose', 'profile-avatar']));
        this.avatarReady = true;
        this.checkProfileReady();
        this.avatar.set_child(null);
        this.avatar.set_style(`background-image: url("${image.get_uri()}"); background-size: cover;`);
    }

    resetProfile() {
        this.lastProfile = null;
        this.profileRenderKey = null;
        this.profileLoadStarted = 0;
        this.profileReady = this.avatarReady = this.studyReady = false;
        this.profileContent.hide();
        this.profileLoading.show();
        this.projectsKey = null;
        this.profileName.text = 'Loading profile…';
        this.profileLogin.text = '';
        this.monthTime.text = '—';
        this.todayTime.text = 'Today: —';
        this.profileLevel.text = 'Lv.—';
        this.profilePercent.text = '(—%)';
        this.profileProgress.width = 0;
        this.profilePoints.text = 'Ev.P —';
        this.profilePace.text = 'Pace — ·';
        this.profileDeadline.text = '—';
        this.avatar.set_style('');
        this.avatar.set_child(new St.Icon({icon_name: 'avatar-default-symbolic', icon_size: 40}));
        this.projects.removeAll();
        const projectsLoading = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const spinner = Me?.imports?.ui?.spinner || imports.misc.extensionUtils.getCurrentExtension().imports.ui.spinner;
        projectsLoading.add_child(spinner.create(20));
        this.projects.addMenuItem(projectsLoading);
        this.setLoginOnly(true);
    }

    setLoginOnly(loginOnly) {
        if (this.loginOnly === loginOnly) return;
        this.loginOnly = loginOnly;
        this.icon.visible = true;
        this.accessible_name = 'Pingoose 42 Info';
        if (loginOnly) this.count.text = 'Login Required';
        this.onLoginStateChanged?.();
    }

});

