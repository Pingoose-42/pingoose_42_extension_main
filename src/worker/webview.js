#!/usr/bin/gjs
imports.gi.versions.Gtk = '3.0';
imports.gi.versions.WebKit2 = '4.0';
imports.gi.versions.Soup = '2.4';
const { Gio, GLib, Gtk, Soup, WebKit2 } = imports.gi;
const ByteArray = imports.byteArray;
const System = imports.system;
const SOURCE_ROOT = GLib.path_get_dirname(GLib.path_get_dirname(System.programPath));
imports.searchPath.unshift(SOURCE_ROOT);
const Model = imports.models.evaluations;
const { readProfileDOM } = imports.worker.profile;
const { summarizeLogtime } = imports.models.logtime;
const HOME = 'https://profile-v3.intra.42.fr/';
const ENDPOINT = 'https://intrapy.intra.42.fr/api/v1/users/me/scale_teams';
const UID = new Gio.Credentials().get_unix_user();
const now = () => GLib.get_monotonic_time() / 1000000;
let worker = null;
let owner = 0;
let stopped = false;
let exitCode = 0;
let lastStatus = '';
function emit(message) {
    if (stopped) return;
    print(JSON.stringify(message));
}
function status(state, extra = {}) {
    const message = { type: 'status', state, ...extra };
    const key = JSON.stringify(message);
    if (state !== 'watching' && key === lastStatus) return;
    lastStatus = key;
    emit(message);
}
function stop(code = 0) {
    if (stopped) return;
    stopped = true;
    exitCode = code;
    worker?.close();
    if (owner) Gio.bus_unown_name(owner);
    Gtk.main_quit();
}
function privateDirectory(path) {
    if (GLib.mkdir_with_parents(path, 0o700) !== 0) throw new Error('storage-error');
    const file = Gio.File.new_for_path(path);
    const info = file.query_info(
        'standard::type,unix::uid',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null
    );
    if (
        info.get_file_type() !== Gio.FileType.DIRECTORY ||
        info.get_attribute_uint32('unix::uid') !== UID
    )
        throw new Error('storage-error');
    file.set_attribute_uint32('unix::mode', 0o700, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
}
function profileURI(uri) {
    try {
        const parsed = GLib.Uri.parse(uri || '', GLib.UriFlags.NONE);
        return (
            parsed.get_scheme() === 'https' &&
            parsed.get_host() === 'profile-v3.intra.42.fr' &&
            !parsed.get_userinfo() &&
            [-1, 443].includes(parsed.get_port())
        );
    } catch (_) {
        return false;
    }
}
function allowedURI(uri) {
    if (uri === 'about:blank') return true;
    try {
        const parsed = GLib.Uri.parse(uri, GLib.UriFlags.NONE);
        const host = parsed.get_host() || '';
        return (
            parsed.get_scheme() === 'https' &&
            !parsed.get_userinfo() &&
            [-1, 443].includes(parsed.get_port()) &&
            (host === 'auth.42.fr' || host === 'intra.42.fr' || host.endsWith('.intra.42.fr'))
        );
    } catch (_) {
        return false;
    }
}

// Read only the visible profile DOM; no page storage or authentication data.
class Worker {
    constructor() {
        this.login = GLib.get_user_name();
        const source = Gio.SettingsSchemaSource.new_from_directory(
            `${SOURCE_ROOT}/schemas`,
            Gio.SettingsSchemaSource.get_default(),
            false
        );
        this.featureSettings = new Gio.Settings({
            settings_schema: source.lookup('org.gnome.shell.extensions.pingoose', true),
        });
        this.logtimeSettingsSignal = this.featureSettings.connect('changed', (_settings, key) => {
            if (!['logtime-seconds-mode', 'logtime-daily-limit'].includes(key)) return;
            this.nextLogtime = 0;
            this.refreshLogtime();
        });
        this.auth = null;
        this.agenda = new imports.worker.agenda.AgendaClient(this, {
            emit,
            now,
            isStopped: () => stopped,
        });
        this.loginWindow = false;
        this.nextProfileRead = 0;
        this.nextProfileReload = now() + 45;
        this.profileReading = false;
        this.avatarURL = null;
        this.avatarResources = new Map();
        this.profileDiagnostics = {};
        this.diagnosticUntil = now() + 90;
        this.pending = null;
        this.nextPoll = Infinity;
        this.notBefore = 0;
        this.reloadAt = Infinity;
        this.backoff = 20;
        this.lastPageLoad = now();
        this.cancel = new Gio.Cancellable();
        this.session = new Soup.Session({
            timeout: 15,
            ssl_strict: true,
            user_agent: 'Pingoose/3',
        });
        this.stateDirectory = GLib.build_filenamev([GLib.get_user_state_dir(), 'pingoose']);
        privateDirectory(this.stateDirectory);
        this.signedOutFile = Gio.File.new_for_path(`${this.stateDirectory}/signed-out`);
        this.webLoginOnlyFile = Gio.File.new_for_path(`${this.stateDirectory}/web-login-only`);
        this.signedOut = this.signedOutFile.query_exists(null);
        this.clearingLogin = false;
        this.stateFile = Gio.File.new_for_path(`${this.stateDirectory}/intrapy-evaluations.json`);
        const directory = GLib.build_filenamev([GLib.get_user_data_dir(), 'pingoose']);
        privateDirectory(directory);
        const manager = new WebKit2.WebsiteDataManager({
            base_data_directory: `${directory}/profile`,
            base_cache_directory: `${directory}/cache`,
        });
        this.dataManager = manager;
        this.context = WebKit2.WebContext.new_with_website_data_manager(manager);
        this.context.connect('download-started', (_context, download) => download.cancel());
        this.context
            .get_cookie_manager()
            .set_persistent_storage(
                `${directory}/cookies.sqlite`,
                WebKit2.CookiePersistentStorage.SQLITE
            );
        const content = new WebKit2.UserContentManager();
        content.add_script(
            new WebKit2.UserScript(
                `(${imports.worker.profile.preferCadetCursus.toString()})()`,
                WebKit2.UserContentInjectedFrames.TOP_FRAME,
                WebKit2.UserScriptInjectionTime.START,
                ['https://profile-v3.intra.42.fr/*'],
                null
            )
        );
        this.view = new WebKit2.WebView({
            web_context: this.context,
            user_content_manager: content,
        });
        this.view.get_settings().set_enable_write_console_messages_to_stdout(false);
        this.window = new Gtk.Window({
            title: 'Loading…',
            default_width: 1000,
            default_height: 750,
        });
        this.window.set_wmclass('pingoose-webview', 'PingooseWebView');
        this.window.set_icon_from_file(
            GLib.build_filenamev([SOURCE_ROOT, 'assets', '42intra.png'])
        );
        const header = new Gtk.HeaderBar({ title: 'Loading…', show_close_button: true });
        const syncPageTitle = () => {
            const title = (this.view.get_title() || '').trim() || 'Loading…';
            this.window.set_title(title);
            header.set_title(title);
        };
        this.view.connect('notify::title', syncPageTitle);
        this.navigation = imports.worker.navigation.create(this.view, this.window);
        this.navigation.set_no_show_all(true);
        this.navigation.hide();
        header.pack_start(this.navigation);
        this.window.set_titlebar(header);
        this.window.add(this.view);
        this.window.connect('delete-event', () => {
            this.window.hide();
            return true;
        });
        this.view.connect('permission-request', (_view, request) => {
            request.deny();
            return true;
        });
        this.view.connect('decide-policy', (_view, decision, type) => {
            if (
                type !== WebKit2.PolicyDecisionType.NAVIGATION_ACTION &&
                type !== WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION
            )
                return false;
            if (
                type === WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION ||
                !allowedURI(decision.get_navigation_action().get_request().get_uri())
            ) {
                decision.ignore();
                return true;
            }
            return false;
        });
        this.view.connect('load-failed', () => {
            if (!this.auth) {
                status('network-error');
                this.reloadAt = now() + 30;
            }
            return false;
        });
        this.view.connect('load-changed', (_view, event) => {
            if (event === WebKit2.LoadEvent.STARTED) this.lastPageLoad = now();
            if (
                event === WebKit2.LoadEvent.FINISHED &&
                /^https:\/\/profile\.intra\.42\.fr\/(?:[?#].*)?$/.test(this.view.get_uri() || '') &&
                this.loginWindow
            ) {
                this.view.load_uri(HOME);
                return;
            }
            if (event === WebKit2.LoadEvent.FINISHED && !this.auth) {
                status(profileURI(this.view.get_uri()) ? 'loading' : 'login-needed');
            }
        });
        this.view.connect('resource-load-started', (_view, resource, request) => {
            const uri = request.get_uri() || '';
            if (/^https:\/\/cdn\.intra\.42\.fr\/users\//.test(uri)) {
                if (this.avatarResources.size >= 8) this.avatarResources.clear();
                this.avatarResources.set(uri, resource);
                resource.connect('finished', () => {
                    this.nextProfileRead = 0;
                });
            }
            if (/logtime|locations/i.test(uri)) {
                resource.connect('finished', () =>
                    this.inspectLogtime(resource, uri, resource.get_response())
                );
            }
            if (
                !uri.startsWith('https://intrapy.intra.42.fr/') ||
                request.get_http_method() !== 'GET'
            )
                return;
            try {
                const header = request.get_http_headers()?.get_one('Authorization');
                if (header) {
                    this.acceptAuthorization(header);
                }
                resource.connect('finished', () => {
                    if (stopped) return;
                    const response = resource.get_response();
                    this.inspectLogtime(resource, uri, response);
                    this.inspectProfileResource(resource, uri, response);
                    this.nextProfileRead = 0;
                    if (response?.get_status_code() === 429)
                        this.fail(
                            'rate-limit',
                            Model.retryAfter(response.get_http_headers()?.get_one('Retry-After'))
                        );
                });
            } catch (error) {
                if (error.message === 'account-error') this.logout('account-error');
                else {
                    this.auth = null;
                    status('auth-error');
                }
            }
        });
        this.clusters = new imports.worker.clusters.Controller({
            context: this.context,
            session: this.session,
            cancel: this.cancel,
            settings: this.featureSettings,
            current: () => (!stopped && !this.signedOut ? this.auth : null),
            emit,
        });
        const current = () =>
            !stopped && !this.signedOut && !this.clearingLogin ? this.auth : null;
        this.chatLookup = new imports.worker.chatLookup.Controller({
            context: this.context,
            cancel: this.cancel,
            settings: this.featureSettings,
            current,
            getCampus: () => this.profileCampus,
            allowedURI,
            emit,
        });
        this.counterpartLookup = new imports.worker.counterpartLookup.Controller({
            context: this.context,
            cancel: this.cancel,
            current,
            allowedURI,
            stateDirectory: this.stateDirectory,
            getRow: (id, begin) =>
                this.evaluationState?.evaluations.find(
                    (row) => row.id === id && row.begin === begin
                ),
            onComplete: (key) => this.counterpartChecks?.set(key, now()),
            onResult: (row, login, identity, result) => {
                if (current() !== identity) return;
                const update = imports.models.counterpart.apply(
                    this.evaluationState,
                    row,
                    login,
                    result
                );
                if (!update.changed) return;
                this.writeState(this.evaluationState);
                this.publishEvaluations();
                if (update.notification) emit(update.notification);
            },
        });
        this.slotRequests = new imports.worker.slots.Controller({
            context: this.context,
            allowedURI,
            current,
            settings: this.featureSettings,
            emit,
        });
        this.windows = new imports.worker.windows.Controller({
            context: this.context,
            login: this.login,
            canBrowse: () => !stopped && !this.signedOut && !this.clearingLogin,
            canOpenProject: () => !!current(),
            onError: () => status('service-error'),
        });
        this.commands = new imports.worker.commands.Router({
            clusters: (request) => this.clusters.lookup(request),
            chatLookup: (request) => this.chatLookup.lookup(request),
            subscription: (id, action) => this.changeAgendaSubscription(id, action),
            refreshAgenda: () => {
                this.agenda.nextPoll = 0;
                this.pollAgenda();
            },
            refresh: () => this.refreshData(),
            reset: () => this.resetAll(),
            createSlots: (payload) => this.slotRequests.request('create', null, payload),
            autoSlots: (single) => this.slotRequests.automatic(single),
            slots: (action, id) => this.slotRequests.request(action, id),
            project: (project, time) => this.windows.project(project, time),
            service: (site, time) => this.windows.open(site, time),
            closeServices: () => this.windows.closeServices(),
            checkEvaluations: () => this.checkEvaluations(),
            feedback: (id) => this.dismissEvaluation(id),
            quit: () => stop(),
            logout: () => this.logout(),
            login: (time) => this.showLogin(time),
            show: (time) =>
                this.windows.open({ name: '42 Intra', url: 'https://profile.intra.42.fr/' }, time),
            hide: () => this.window.hide(),
            diagnose: () => {
                this.profileDiagnostics = {};
                this.diagnosticUntil = now() + 90;
                this.view.load_uri(HOME);
            },
            invalid: (action) => {
                if (action === 'createSlots') this.slotRequests.error('Invalid slot schedule.');
                else if (['project', 'service'].includes(action)) status('service-error');
            },
        });
        this.view.show();
        {
            this.input = new Gio.DataInputStream({
                base_stream: new Gio.UnixInputStream({ fd: 0, close_fd: false }),
            });
            this.readCommand();
            this.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this.tick();
                return GLib.SOURCE_CONTINUE;
            });
            // Restore the private WebKit session; tokens are observed in memory only.
            if (this.signedOut) status('login-needed');
            else {
                status('loading');
                this.view.load_uri(HOME);
            }
        }
    }

    readProfile() {
        if (this.profileReading || this.view.is_loading || !profileURI(this.view.get_uri())) return;
        this.nextProfileRead = now() + 2;
        this.profileReading = true;
        const identity = this.auth;
        const campusScript = this.profileCampus
            ? JSON.stringify(this.profileCampus)
            : `(${imports.models.favoriteProfile.readDOM.toString()})(${JSON.stringify(identity.login)}, true)?.campus || null`;
        this.view.run_javascript_in_world(
            `JSON.stringify({...JSON.parse((${readProfileDOM.toString()})(${JSON.stringify(identity.login)})),campus:${campusScript}})`,
            'pingoose-profile',
            this.cancel,
            (view, result) => {
                this.profileReading = false;
                if (stopped || this.auth !== identity) return;
                try {
                    const profile = JSON.parse(
                        view.run_javascript_in_world_finish(result).get_js_value().to_string()
                    );
                    if (profile.profileLogin && profile.profileLogin !== identity.login) {
                        this.logout('account-error');
                        return;
                    }
                    if (
                        !this.profileCampus &&
                        imports.services.profileCampusCache.validCampus(profile.campus)
                    ) {
                        this.profileCampus = profile.campus;
                        try {
                            imports.services.profileCampusCache.write(
                                this.stateDirectory,
                                identity,
                                profile.campus
                            );
                        } catch (_) {
                            /* Keep the session cache if disk storage is unavailable. */
                        }
                    }
                    if (!profile.name && profile.level === null) {
                        this.nextProfileRead = now() + 3;
                        return;
                    }
                    const coreReady =
                        profile.name &&
                        profile.level !== null &&
                        profile.progress !== null &&
                        profile.points !== null;
                    if (Array.isArray(profile.projects) && !profile.projects.length) {
                        if (!coreReady || this.view.is_loading) this.emptyProjectsSince = null;
                        else if (!this.emptyProjectsSince) this.emptyProjectsSince = now();
                        if (!this.emptyProjectsSince || now() - this.emptyProjectsSince < 6)
                            profile.projects = null;
                    } else this.emptyProjectsSince = null;
                    if (Array.isArray(profile.projects)) {
                        this.profileProjects = profile.projects;
                        let changed = false;
                        for (const row of this.evaluationState?.evaluations || []) {
                            if (row.slug) continue;
                            const matches = profile.projects.filter(
                                (p) => p.name.toLowerCase() === row.project.toLowerCase()
                            );
                            if (matches.length === 1) {
                                row.slug = matches[0].slug;
                                changed = true;
                            }
                        }
                        if (changed) this.writeState(this.evaluationState);
                    }
                    emit({ type: 'profile', login: identity.login, ...profile, avatar: undefined });
                    if (coreReady && Array.isArray(profile.projects) && !this.view.is_loading)
                        this.refreshPart('profile');
                    if (profile.avatar && profile.avatar !== this.avatarURL)
                        this.loadAvatar(profile.avatar, identity);
                    const resource = this.avatarResources.get(profile.avatar);
                    const report = JSON.stringify({
                        projects: profile.projects?.length ?? null,
                        hasImage: !!profile.avatar,
                        resources: this.avatarResources.size,
                        matched: !!resource,
                        httpStatus: resource?.get_response()?.get_status_code() ?? null,
                    });
                    if (report !== this.avatarReport) {
                        this.avatarReport = report;
                        Gio.File.new_for_path(
                            `${this.stateDirectory}/profile-image-status.json`
                        ).replace_contents(
                            ByteArray.fromString(report),
                            null,
                            false,
                            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
                            null
                        );
                    }
                } catch (_) {
                    this.nextProfileRead = now() + 10;
                }
            }
        );
    }

    loadAvatar(url, identity) {
        // Reuse the image loaded by the authenticated WebKit page. A separate
        // HTTP client can be refused by the CDN even for the same image URL.
        const resource = this.avatarResources.get(url);
        if (!resource || !/^https:\/\/cdn\.intra\.42\.fr\/users\//.test(url)) return;
        const response = resource.get_response();
        if (
            !response ||
            response.get_status_code() !== 200 ||
            !/^image\//.test(response.get_mime_type() || '') ||
            response.get_content_length() > 2000000
        )
            return;
        this.avatarURL = url;
        resource.get_data(this.cancel, (item, result) => {
            try {
                const image = item.get_data_finish(result);
                if (stopped || this.auth !== identity) {
                    this.avatarURL = null;
                    return;
                }
                if (!image || !image.length || image.length > 2000000)
                    throw new Error('invalid-image');
                Gio.File.new_for_path(`${this.stateDirectory}/profile-avatar`).replace_contents(
                    image,
                    null,
                    false,
                    Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
                    null
                );
                emit({ type: 'profile-avatar', login: identity.login });
            } catch (_) {
                this.avatarURL = null;
            }
        });
    }

    inspectLogtime(resource, uri, response) {
        if (
            !this.auth ||
            this.signedOut ||
            !/^https:\/\/translate\.intra\.42\.fr\/users\/\d+\/locations_stats\//.test(uri) ||
            response?.get_status_code() !== 200
        )
            return;
        this.logtimeURL = uri;
        this.refreshLogtime();
    }

    refreshLogtime() {
        if (
            !this.auth ||
            !this.logtimeURL ||
            this.logtimePending ||
            now() < (this.nextLogtime || 0)
        )
            return;
        this.logtimePending = true;
        this.nextLogtime = now() + 60;
        const identity = this.auth;
        const message = Soup.Message.new('GET', this.logtimeURL);
        message.set_flags(Soup.MessageFlags.NO_REDIRECT);
        message.request_headers.append('Authorization', identity.header);
        this.session.queue_message(message, (_session, result) => {
            this.logtimePending = false;
            if (stopped || this.auth !== identity) return;
            try {
                if (result.status_code !== 200 || result.response_body.length > 1000000)
                    throw new Error('logtime-unavailable');
                const summary = summarizeLogtime(
                    JSON.parse(result.response_body.data),
                    new Date(),
                    {
                        secondsMode: this.featureSettings.get_string('logtime-seconds-mode'),
                        dailyLimit: this.featureSettings.get_string('logtime-daily-limit'),
                    }
                );
                emit({ type: 'study-time', login: identity.login, ...summary });
                this.refreshPart(
                    'logtime',
                    Number.isInteger(summary.monthMinutes) && Number.isInteger(summary.todayMinutes)
                );
            } catch (_) {
                this.refreshPart('logtime', false);
                emit({
                    type: 'study-time',
                    login: identity.login,
                    monthMinutes: null,
                    todayMinutes: null,
                });
            }
        });
    }

    inspectProfileResource(resource, uri, response) {
        if (
            !this.auth ||
            this.signedOut ||
            now() > this.diagnosticUntil ||
            response?.get_status_code() !== 200
        )
            return;
        const path = uri.split('?')[0].replace('https://intrapy.intra.42.fr', '');
        // Only the signed-in user's profile requests, never other users or evaluations.
        if (
            !/^\/api\/v1\/users\/me(?:\/|$)/.test(path) ||
            /scale_teams|events|logtime|projects|feedback/.test(path) ||
            Object.keys(this.profileDiagnostics).length >= 20 ||
            this.profileDiagnostics[path]
        )
            return;
        if (
            !/json/i.test(response.get_mime_type() || '') ||
            response.get_content_length() > 1000000
        )
            return;
        this.profileDiagnostics[path] = { pending: true };
        resource.get_data(this.cancel, (item, result) => {
            if (stopped || this.signedOut || !this.auth) return;
            try {
                const data = item.get_data_finish(result);
                if (data.length > 1000000) return;
                const body = JSON.parse(ByteArray.toString(data));
                const fields = [];
                const allowed =
                    /^(login|preferred_username|display_name|first_name|last_name|level|correction_point|correction_points|evaluation_points|pace|deadline|milestone_deadline|begin_at|end_at|image_url|avatar_url|picture_url)$/;
                const walk = (value, prefix, depth) => {
                    if (depth > 7 || fields.length >= 300) return;
                    if (Array.isArray(value)) {
                        value.slice(0, 3).forEach((v, i) => walk(v, `${prefix}[${i}]`, depth + 1));
                        return;
                    }
                    if (!value || typeof value !== 'object') return;
                    for (const [key, v] of Object.entries(value)) {
                        if (
                            !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(key) ||
                            /token|secret|password|email|phone|address/i.test(key)
                        )
                            continue;
                        const field = {
                            path: `${prefix}.${key}`,
                            type: v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v,
                        };
                        if (allowed.test(key) && (typeof v === 'number' || typeof v === 'string'))
                            field.value = typeof v === 'string' ? v.slice(0, 300) : v;
                        fields.push(field);
                        walk(v, field.path, depth + 1);
                        if (fields.length >= 300) break;
                    }
                };
                walk(body, '$', 0);
                this.profileDiagnostics[path] = { fields };
                Gio.File.new_for_path(
                    `${this.stateDirectory}/profile-diagnostics.json`
                ).replace_contents(
                    ByteArray.fromString(
                        JSON.stringify(
                            {
                                checkedAt: new Date().toISOString(),
                                endpoints: this.profileDiagnostics,
                            },
                            null,
                            2
                        )
                    ),
                    null,
                    false,
                    Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
                    null
                );
            } catch (_) {
                this.profileDiagnostics[path] = { error: 'response-unavailable' };
            }
        });
    }

    acceptAuthorization(header) {
        if (this.signedOut || this.clearingLogin) return;
        if (
            typeof header !== 'string' ||
            header.length > 20000 ||
            !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(header)
        )
            throw new Error('auth-error');
        const payload = header.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const claims = JSON.parse(
            ByteArray.toString(
                GLib.base64_decode(payload + '='.repeat((4 - (payload.length % 4)) % 4))
            )
        );
        let info;
        try {
            info = Model.claimsInfo(claims, this.login);
        } catch (error) {
            if (error.message === 'account-error') this.logout('account-error');
            throw error;
        }
        if (this.auth?.header === header) {
            this.finishLogin();
            return;
        }
        if (
            this.auth?.subject !== info.subject ||
            this.auth?.login !== info.login ||
            !this.profileCampus
        )
            this.profileCampus = imports.services.profileCampusCache.read(
                this.stateDirectory,
                info
            );
        this.auth = { ...info, header }; // Only this helper's memory; never emit or persist headers/claims.
        try {
            const saved = this.readState();
            if (saved?.subject === info.subject) {
                this.evaluationState = saved;
                this.publishEvaluations();
            }
        } catch (_) {
            /* receive() reports storage errors without replacing the file. */
        }
        if (this.nextPoll === Infinity) this.nextPoll = now() + 1;
        this.reloadAt = Infinity;
        status('authenticated');
        this.finishLogin();
    }

    finishLogin() {
        // A validated login token is sufficient; do not wait for navigation.
        if (!this.loginWindow || !this.auth) return;
        this.loginWindow = false;
        this.window.hide();
    }

    readState() {
        let info;
        try {
            info = this.stateFile.query_info(
                'standard::type,standard::size,unix::uid,unix::mode',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null
            );
        } catch (error) {
            if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) return null;
            throw error;
        }
        if (
            info.get_file_type() !== Gio.FileType.REGULAR ||
            info.get_size() > 4194304 ||
            info.get_attribute_uint32('unix::uid') !== UID ||
            info.get_attribute_uint32('unix::mode') & 0o077
        )
            throw new Error('storage-error');
        const stream = this.stateFile.read(null);
        try {
            const bytes = stream.read_bytes(4194305, null).get_data();
            if (bytes.length > 4194304) throw new Error('storage-error');
            return Model.storedState(ByteArray.toString(bytes));
        } finally {
            stream.close(null);
        }
    }

    writeState(state) {
        this.stateFile.replace_contents(
            ByteArray.fromString(JSON.stringify(state)),
            null,
            false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
    }

    receive(text, identity) {
        let rows, completeList;
        try {
            const raw = JSON.parse(text);
            rows = Model.parseRows(raw);
            completeList = raw.length === rows.length;
        } catch (_) {
            this.fail('response-error');
            return false;
        }
        let plan;
        let previousRows = new Map();
        let missingNotices = [];
        try {
            const previous = this.readState();
            ({ plan, previousRows, missingNotices } = imports.models.evaluationState.reconcile(
                previous,
                identity.subject,
                rows,
                completeList
            ));
            this.evaluationState = plan.state;
            if (JSON.stringify(previous) !== JSON.stringify(plan.state))
                this.writeState(plan.state);
        } catch (_) {
            this.fail('storage-error');
            return false;
        }
        // shortcut: a crash after saving can lose delivery; add acknowledgements if durable delivery is needed.
        for (const row of plan.added) emit(Model.notification(row));
        for (const row of missingNotices)
            emit({
                type: 'notification',
                id: `missing:${row.id}:${row.missingAt}`,
                body: `Evaluation Missing · ${row.project}\nThis match is no longer listed. It may have been cancelled.`,
            });
        for (const id of previousRows.keys())
            if (this.evaluationState.dismissed.includes(id)) {
                for (const key of this.counterpartChecks?.keys() || [])
                    if (key.startsWith(`${id}:`)) this.counterpartChecks.delete(key);
                emit({ type: 'evaluation-dismissed', id });
            }
        this.publishEvaluations();
        this.pollEvaluationFeedback();
        for (const row of rows) {
            const previous = previousRows.get(row.id);
            if (previous && Date.parse(previous.begin) <= Date.now()) continue;
            if (
                previous &&
                previous.begin !== row.begin &&
                !this.evaluationState.dismissed.includes(row.id)
            )
                emit({
                    type: 'notification',
                    id: `rescheduled:${row.id}:${row.begin}`,
                    body: `Evaluation time changed · ${row.project}\n${new Date(row.begin).toLocaleString('en-GB')}`,
                });
        }
        this.counterpartChecks ||= new Map();
        for (const row of this.evaluationState.evaluations) {
            const remaining = Date.parse(row.begin) - Date.now();
            if (row.missing || remaining <= 0 || remaining > 899000) continue;
            for (const login of row.users || []) {
                const key = `${row.id}:${row.begin}:${login}`;
                if (now() >= (this.counterpartChecks.get(key) || 0)) {
                    this.counterpartChecks.set(key, Infinity);
                    this.counterpartLookup.lookup(row, login, identity);
                }
            }
        }
        this.backoff = 20;
        this.scheduleEvaluationPoll();
        if (this.notBefore > now() + 10)
            status('retry-wait', { retryAfter: Math.ceil(this.notBefore - now()) });
        else status('watching', { login: identity.login, count: rows.length });
        return true;
    }

    // Allow one second for the server to publish the match at the 15-minute boundary.
    scheduleEvaluationPoll() {
        let delay = 10000;
        const time = Date.now();
        for (const row of this.evaluationState?.evaluations || []) {
            const remaining = Date.parse(row.begin) - time;
            if (remaining > 899000) delay = Math.min(delay, remaining - 899000);
            else if (remaining > 0) delay = Math.min(delay, 5000);
        }
        this.nextPoll = Math.max(now() + delay / 1000, this.notBefore);
        if (this.evaluationPollTimer) GLib.source_remove(this.evaluationPollTimer);
        this.evaluationPollTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            Math.max(1, Math.ceil((this.nextPoll - now()) * 1000)),
            () => {
                this.evaluationPollTimer = 0;
                if (
                    !stopped &&
                    this.auth &&
                    !this.signedOut &&
                    !this.pending &&
                    now() >= this.notBefore &&
                    now() >= this.nextPoll
                )
                    this.poll();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    pollEvaluationFeedback() {
        if (!this.auth || !this.evaluationState || this.feedbackChecker?.view) return;
        this.feedbackDue ||= new Map();
        const model = imports.models.evaluationFeedback;
        const groups = model.projectGroups(
            this.evaluationState.evaluations,
            this.profileProjects || []
        );
        const selected = [...groups].find(([slug]) => now() >= (this.feedbackDue.get(slug) || 0));
        if (!selected) return;
        const [slug, rows] = selected;
        const identity = this.auth;
        this.feedbackDue.set(slug, now() + 10);
        this.feedbackChecker ||= new imports.services.evaluationFeedback.Checker(
            this.context,
            allowedURI
        );
        this.feedbackChecker.run(identity.login, slug, (page) => {
            if (stopped || this.auth !== identity || !this.evaluationState) return;
            let changed = false;
            for (const checked of rows) {
                const row = this.evaluationState.evaluations.find(
                    (r) => r.id === checked.id && r.begin === checked.begin
                );
                if (!row || !model.eligibleEvaluatee(row)) continue;
                const result = model.inspect(row, page, slug);
                if (result.state === 'complete') this.dismissEvaluation(row.id);
                else if (
                    result.watch &&
                    JSON.stringify(row.feedbackWatch) !== JSON.stringify(result.watch)
                ) {
                    row.feedbackWatch = result.watch;
                    changed = true;
                }
            }
            if (changed) this.writeState(this.evaluationState);
        });
    }

    publishEvaluations() {
        if (!this.evaluationState) return;
        emit({ type: 'evaluations', rows: this.evaluationState.evaluations });
    }

    fail(state, wait = 0) {
        const delay = Math.max(this.backoff, wait);
        if (wait > 0 || state === 'rate-limit')
            this.notBefore = Math.max(this.notBefore, now() + delay);
        this.nextPoll = Math.max(now() + delay, this.notBefore);
        if (Number.isFinite(this.reloadAt)) this.reloadAt = Math.max(this.reloadAt, this.notBefore);
        this.backoff = Math.min(300, this.backoff * 2);
        status(state, { retryAfter: Math.ceil(this.nextPoll - now()) });
    }

    tick() {
        if (this.refreshParts && now() >= this.refreshDeadline) this.refreshPart('timeout', false);
        if (stopped || this.signedOut || this.clearingLogin) return;
        if (
            this.auth &&
            now() >= this.nextProfileReload &&
            now() >= this.notBefore &&
            !this.window.get_visible() &&
            !this.view.is_loading
        ) {
            this.nextProfileReload = now() + 45;
            this.nextProfileRead = now() + 3;
            this.view.reload_bypass_cache();
        }
        if (this.auth) {
            this.refreshLogtime();
            this.pollAgenda();
            this.pollEvaluationFeedback();
        }
        if (this.auth && now() >= this.nextProfileRead) this.readProfile();
        if (!this.auth && now() >= this.reloadAt) {
            this.reloadAt = Infinity;
            this.view.load_uri(HOME);
        }
        if (this.auth && !this.pending && now() >= this.nextPoll) this.poll();
        if (
            !this.auth &&
            !this.view.is_loading &&
            now() - this.lastPageLoad > 30 &&
            this.reloadAt === Infinity
        ) {
            status('login-needed');
        }
    }

    changeAgendaSubscription(id, action) {
        this.agenda.changeSubscription(id, action);
    }

    pollAgenda() {
        this.agenda.poll();
    }

    poll() {
        const identity = this.auth;
        const message = Soup.Message.new('GET', ENDPOINT);
        message.set_flags(Soup.MessageFlags.NO_REDIRECT);
        message.request_headers.append('Authorization', identity.header);
        message.request_headers.append('Content-Type', 'application/json');
        const cancel = new Gio.Cancellable();
        this.pending = cancel;
        let stream = null;
        let done = false;
        let deadline = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
            deadline = 0;
            cancel.cancel();
            return GLib.SOURCE_REMOVE;
        });
        const finish = (text = null, state = null, wait = 0) => {
            if (done) return;
            done = true;
            if (deadline) GLib.source_remove(deadline);
            if (stream) {
                try {
                    stream.close(null);
                } catch (_) {}
            }
            this.pending = null;
            if (stopped || this.auth !== identity) return;
            if (state === 'auth-error') {
                this.auth = null;
                // Reload the authenticated WebKit session to obtain a fresh token.
                this.reloadAt = now() + this.backoff;
            }
            if (state) {
                this.fail(state, wait);
                this.refreshPart('evaluations', false);
            } else {
                if (!this.receive(text, identity)) state = 'response-error';
                this.refreshPart('evaluations', !state);
            }
            if (this.sessionEvaluationCheck) {
                this.sessionEvaluationCheck = false;
                emit({
                    type: 'evaluation-check',
                    ...(state
                        ? { error: 'Unable to refresh evaluations.' }
                        : { rows: this.evaluationState?.evaluations || [] }),
                });
            }
        };
        this.session.send_async(message, cancel, (session, result) => {
            try {
                stream = session.send_finish(result);
                const code = message.status_code;
                if (code !== 200) {
                    finish(
                        null,
                        code === 401
                            ? 'auth-error'
                            : code === 403
                              ? 'permission-error'
                              : code === 429
                                ? 'rate-limit'
                                : 'api-error',
                        Model.retryAfter(message.response_headers.get_one('Retry-After'))
                    );
                    return;
                }
                const chunks = [];
                let size = 0;
                const read = () =>
                    stream.read_bytes_async(32768, GLib.PRIORITY_DEFAULT, cancel, (input, next) => {
                        try {
                            const bytes =
                                input.read_bytes_finish(next).get_data() || new Uint8Array(0);
                            size += bytes.length;
                            if (size > 1000000) {
                                finish(null, 'response-error');
                                return;
                            }
                            if (bytes.length) {
                                chunks.push(bytes);
                                read();
                                return;
                            }
                            const all = new Uint8Array(size);
                            let offset = 0;
                            for (const chunk of chunks) {
                                all.set(chunk, offset);
                                offset += chunk.length;
                            }
                            finish(ByteArray.toString(all));
                        } catch (_) {
                            finish(null, 'network-error');
                        }
                    });
                read();
            } catch (_) {
                finish(null, 'network-error');
            }
        });
    }

    logout(state = 'login-needed', complete = null) {
        this.windows.clear();
        if (this.clearingLogin) {
            complete?.(false);
            return;
        }
        if (this.evaluationPollTimer) GLib.source_remove(this.evaluationPollTimer);
        this.evaluationPollTimer = 0;
        this.refreshPart('logout', false);
        this.signedOut = true;
        this.clearingLogin = true;
        this.auth = null;
        this.profileCampus = null;
        this.clusters.clear();
        this.chatLookup.clear();
        this.counterpartLookup.clear();
        this.counterpartChecks = new Map();
        this.feedbackChecker?.close();
        this.feedbackChecker = null;
        this.feedbackDue = null;
        this.profileProjects = null;
        this.slotRequests.clear();
        this.evaluationState = null;
        this.pending?.cancel();
        this.session.abort();
        this.nextPoll = this.reloadAt = Infinity;
        this.avatarURL = null;
        this.avatarResources.clear();
        this.logtimeURL = null;
        this.nextLogtime = 0;
        this.view.stop_loading();
        this.window.hide();
        this.loginWindow = false;
        for (const marker of [this.signedOutFile, this.webLoginOnlyFile])
            marker.replace_contents(
                ByteArray.fromString('1'),
                null,
                false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        for (const name of [
            'session.json',
            'profile-avatar',
            'profile-diagnostics.json',
            'profile-image-status.json',
        ]) {
            try {
                Gio.File.new_for_path(`${this.stateDirectory}/${name}`).delete(null);
            } catch (_) {}
        }
        emit({ type: 'signed-out' });
        status(state);
        this.view.load_uri('about:blank');
        this.dataManager.clear(WebKit2.WebsiteDataTypes.ALL, 0, null, (manager, result) => {
            try {
                manager.clear_finish(result);
            } catch (_) {
                this.clearingLogin = false;
                status('storage-error');
                complete?.(false);
                return;
            }
            this.clearingLogin = false;
            complete?.(true);
        });
    }

    cleanupCounterpartImages() {
        const retained = new Set(
            (this.evaluationState?.evaluations || []).flatMap((row) => row.users)
        );
        const directory = Gio.File.new_for_path(this.stateDirectory);
        let files;
        try {
            files = directory.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null
            );
            let info;
            while ((info = files.next_file(null))) {
                const name = info.get_name();
                const match = name.match(/^counterpart-([a-zA-Z0-9_-]{1,64})$/);
                if (match && !retained.has(match[1])) directory.get_child(name).delete(null);
            }
        } catch (_) {
            /* Retry cleanup on subsequent acknowledgements or logout. */
        } finally {
            files?.close(null);
        }
    }

    refreshPart(name, success = true) {
        if (!this.refreshParts) return;
        if (!success) {
            this.refreshParts = null;
            emit({ type: 'refresh-state', state: 'failed' });
            return;
        }
        this.refreshParts.delete(name);
        if (!this.refreshParts.size) {
            this.refreshParts = null;
            emit({ type: 'refresh-state', state: 'complete' });
        }
    }

    refreshData() {
        if (!this.auth || this.signedOut || this.clearingLogin) {
            emit({ type: 'refresh-state', state: 'failed' });
            return;
        }
        this.refreshParts = new Set(['profile', 'evaluations', 'agenda', 'logtime']);
        this.refreshDeadline = now() + 85;
        const due = Math.max(now(), this.notBefore || 0);
        this.nextPoll = due;
        this.agenda.nextPoll = due;
        this.nextLogtime = due;
        this.nextProfileReload = due;
        this.nextProfileRead = due + 3;
        // Retain displayed data until fresh responses arrive.
        if (due > now()) return;
        this.nextProfileReload = now() + 45;
        this.avatarURL = null;
        this.view.reload_bypass_cache();
        if (!this.pending) this.poll();
        this.pollAgenda();
        this.refreshLogtime();
    }

    dismissEvaluation(id) {
        if (!this.auth || !this.evaluationState) return;
        const row = this.evaluationState.evaluations.find((item) => item.id === id);
        if (!row || (!row.missing && Date.parse(row.begin) > Date.now())) return;
        imports.models.evaluationState.dismiss(this.evaluationState, [id]);
        for (const key of this.counterpartChecks?.keys() || [])
            if (key.startsWith(`${id}:`)) this.counterpartChecks.delete(key);
        this.writeState(this.evaluationState);
        this.cleanupCounterpartImages();
        emit({ type: 'evaluation-dismissed', id });
        this.publishEvaluations();
    }

    checkEvaluations() {
        if (!this.auth || this.signedOut) {
            emit({ type: 'evaluation-check', error: 'Not authenticated.' });
            return;
        }
        if (!this.pending && now() < this.notBefore) {
            emit({
                type: 'evaluation-check',
                error: 'Evaluation refresh is waiting for the server retry interval.',
            });
            return;
        }
        this.sessionEvaluationCheck = true;
        if (!this.pending) this.poll();
    }

    showLogin(timestamp) {
        if (this.clearingLogin) return;
        this.signedOut = false;
        try {
            this.signedOutFile.delete(null);
        } catch (_) {}
        this.loginWindow = true;
        this.navigation.hide();
        this.window.show_all();
        this.window.present_with_time(timestamp);
        if (!this.view.is_loading) this.view.load_uri(HOME);
    }

    resetAll() {
        this.logout('login-needed', (success) => {
            if (!success) {
                emit({ type: 'reset-error' });
                return;
            }
            emit({ type: 'reset-ready' });
            stop();
        });
    }

    readCommand() {
        this.input.read_line_async(GLib.PRIORITY_DEFAULT, this.cancel, (input, result) => {
            try {
                const [line] = input.read_line_finish_utf8(result);
                if (line === null) {
                    stop();
                    return;
                }
                if (line.length <= 4096) this.commands.dispatch(line.trim());
                if (!stopped) this.readCommand();
            } catch (_) {
                if (!stopped) stop(1);
            }
        });
    }

    close() {
        if (this.logtimeSettingsSignal) this.featureSettings.disconnect(this.logtimeSettingsSignal);
        this.logtimeSettingsSignal = 0;
        this.clusters.clear();
        this.chatLookup.clear();
        this.counterpartLookup.clear();
        this.counterpartChecks = new Map();
        this.windows.clear();
        this.feedbackChecker?.close();
        this.feedbackChecker = null;
        this.feedbackDue = null;
        this.profileProjects = null;
        this.slotRequests.clear();
        this.cancel.cancel();
        this.pending?.cancel();
        this.session.abort();
        if (this.evaluationPollTimer) GLib.source_remove(this.evaluationPollTimer);
        this.evaluationPollTimer = 0;
        if (this.timer) GLib.source_remove(this.timer);
        this.view.stop_loading();
        this.window.destroy();
        this.auth = null;
    }
}

GLib.set_prgname('pingoose-webview');
GLib.set_application_name('Pingoose WebView');
{
    // GNOME Shell matches this entry to the WebKit window's WM_CLASS.
    try {
        const applications = GLib.build_filenamev([GLib.get_user_data_dir(), 'applications']);
        GLib.mkdir_with_parents(applications, 0o755);
        const icon = GLib.build_filenamev([SOURCE_ROOT, 'assets', '42intra.png']);
        const desktop = `[Desktop Entry]\nType=Application\nName=Pingoose WebView\nComment=Pingoose web browser\nExec=gnome-extensions prefs pingoose@local\nIcon=${icon}\nStartupWMClass=PingooseWebView\nNoDisplay=true\nTerminal=false\n`;
        const file = Gio.File.new_for_path(`${applications}/pingoose.desktop`);
        let previous = '';
        try {
            previous = ByteArray.toString(file.load_contents(null)[1]);
        } catch (_) {}
        if (previous !== desktop)
            file.replace_contents(
                ByteArray.fromString(desktop),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
    } catch (_) {
        /* Window name and icon still work when desktop registration is unavailable. */
    }
}
Gtk.init(null);
GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 15, () => {
    stop();
    return GLib.SOURCE_REMOVE;
});
GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 2, () => {
    stop();
    return GLib.SOURCE_REMOVE;
});
// The session bus releases ownership on crashes; no stale PID file or shared profile writers.
owner = Gio.bus_own_name(
    Gio.BusType.SESSION,
    'org.gnome.Shell.Extensions.Pingoose.Worker',
    Gio.BusNameOwnerFlags.DO_NOT_QUEUE,
    null,
    () => {
        try {
            worker = new Worker();
        } catch (_) {
            status('worker-error');
            stop(1);
        }
    },
    () => {
        if (!stopped) {
            status('worker-busy');
            stop(1);
        }
    }
);
Gtk.main();
System.exit(exitCode);
