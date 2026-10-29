const { Gio, GLib, WebKit2 } = imports.gi;
const ByteArray = imports.byteArray;

var Controller = class Controller {
    constructor({
        context,
        cancel,
        current,
        allowedURI,
        stateDirectory,
        getRow,
        onResult,
        onComplete,
    }) {
        this.context = context;
        this.cancel = cancel;
        this.current = current;
        this.allowedURI = allowedURI;
        this.stateDirectory = stateDirectory;
        this.getRow = getRow;
        this.onResult = onResult;
        this.onComplete = onComplete;
        this.jobs = new Map();
    }

    clear() {
        for (const cancel of [...this.jobs.values()]) cancel();
        this.jobs.clear();
    }

    lookup(row, login, identity) {
        const existingKey = `${row.id}:${row.begin}:${login}`;
        if (this.jobs.has(existingKey) || this.current() !== identity) return;
        let finished = false,
            timer = 0;
        // Separate hidden view keeps the signed-in user's profile intact.
        const avatarCached =
            (row.avatars || []).includes(login) &&
            Gio.File.new_for_path(`${this.stateDirectory}/counterpart-${login}`).query_exists(null);
        const view = new WebKit2.WebView({ web_context: this.context });
        if (avatarCached) view.get_settings().set_auto_load_images(false);
        view.get_settings().set_enable_write_console_messages_to_stdout(false);
        view.connect('permission-request', (_view, request) => {
            request.deny();
            return true;
        });
        view.connect('decide-policy', (_view, decision, type) => {
            if (
                type === WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION ||
                (type === WebKit2.PolicyDecisionType.NAVIGATION_ACTION &&
                    !this.allowedURI(decision.get_navigation_action().get_request().get_uri()))
            ) {
                decision.ignore();
                return true;
            }
            return false;
        });
        let avatarSaved = false;
        let foundSeat = null;
        let confirmedUnavailable = false;
        let foundName = row.names?.[login] || null;
        if (!avatarCached)
            view.connect('resource-load-started', (_view, resource, request) => {
                const uri = request.get_uri() || '';
                const match = uri.match(
                    /^https:\/\/cdn\.intra\.42\.fr\/users\/.*\/([a-zA-Z0-9_-]+)\.(?:jpg|jpeg|png|webp)(?:[?#]|$)/i
                );
                if (!match || match[1] !== login) return;
                resource.connect('finished', () => {
                    const response = resource.get_response();
                    if (
                        response?.get_status_code() !== 200 ||
                        !/^image\//.test(response.get_mime_type() || '')
                    )
                        return;
                    resource.get_data(this.cancel, (item, result) => {
                        try {
                            const bytes = item.get_data_finish(result);
                            if (
                                finished ||
                                this.current() !== identity ||
                                !bytes?.length ||
                                bytes.length > 2000000
                            )
                                return;
                            const active = this.getRow(row.id, row.begin);
                            if (
                                !active ||
                                active.missing ||
                                active.begin !== row.begin ||
                                Date.parse(active.begin) <= Date.now() ||
                                !active.users.includes(login)
                            )
                                return;
                            Gio.File.new_for_path(
                                `${this.stateDirectory}/counterpart-${login}`
                            ).replace_contents(
                                bytes,
                                null,
                                false,
                                Gio.FileCreateFlags.PRIVATE |
                                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                                null
                            );
                            avatarSaved = true;
                            this.onResult(row, login, identity, { avatar: true });
                        } catch (_) {
                            /* Keep the placeholder; retry on a later refresh. */
                        }
                    });
                });
            });
        // Reuse the profile JSON response already fetched by the page when DOM
        // hydration is slow. Match the requested login, never the navbar user.
        if (!foundName)
            view.connect('resource-load-started', (_view, resource, request) => {
                if (
                    !/^https:\/\/intrapy\.intra\.42\.fr\/api\/v1\/users(?:[/?]|$)/.test(
                        request.get_uri() || ''
                    )
                )
                    return;
                resource.connect('finished', () => {
                    const response = resource.get_response();
                    if (
                        response?.get_status_code() !== 200 ||
                        !/json/i.test(response.get_mime_type() || '')
                    )
                        return;
                    resource.get_data(this.cancel, (item, result) => {
                        try {
                            const bytes = item.get_data_finish(result);
                            if (
                                finished ||
                                this.current() !== identity ||
                                !bytes?.length ||
                                bytes.length > 2000000
                            )
                                return;
                            const profile = imports.models.favoriteProfile.fromResponse(
                                JSON.parse(ByteArray.toString(bytes)),
                                login
                            );
                            if (profile?.name) foundName = profile.name;
                        } catch (_) {}
                    });
                });
            });
        const key = `${row.id}:${row.begin}:${login}`;
        const release = () => {
            if (timer) GLib.source_remove(timer);
            timer = 0;
            this.jobs.delete(key);
            view.stop_loading();
            view.destroy();
        };
        const finish = (seat) => {
            if (finished) return;
            finished = true;
            release();
            if (this.current() !== identity) return;
            this.onComplete(key);
            this.onResult(row, login, identity, { name: foundName, seat, confirmedUnavailable });
        };
        this.jobs.set(key, () => {
            finished = true;
            release();
        });
        const lookupLimit = row.chatConfirmedAt?.[login] && avatarCached && foundName ? 5 : 15;
        let attempts = 0,
            reading = false;
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (finished) return GLib.SOURCE_REMOVE;
            if (++attempts >= lookupLimit || this.current() !== identity) {
                finish(foundSeat);
                return GLib.SOURCE_REMOVE;
            }
            if (reading) return GLib.SOURCE_CONTINUE;
            reading = true;
            // Seat lookup is deliberately conservative: no arbitrary page text is reported.
            const profileScript = foundName
                ? 'null'
                : `(${imports.models.favoriteProfile.readDOM.toString()})(${JSON.stringify(login)})`;
            const script = `JSON.stringify({profile:${profileScript},valid:location.pathname.replace(/\\/$/,'')===${JSON.stringify('/users/' + login)} && !!document.querySelector('header h2'),seat:Array.from(document.querySelectorAll('div,span')).map(e=>e.children.length?'':e.textContent.trim()).find(t=>/^c[0-9]+r[0-9]+s[0-9]+$/i.test(t)) || null,unavailable:Array.from(document.querySelectorAll('div,span')).some(e=>!e.children.length && e.textContent.trim().toLowerCase()==='unavailable')})`;
            view.run_javascript_in_world(script, 'pingoose-seat', this.cancel, (page, result) => {
                reading = false;
                if (finished || this.current() !== identity) return;
                try {
                    const data = JSON.parse(
                        page.run_javascript_in_world_finish(result).get_js_value().to_string()
                    );
                    if (data.profile?.name) foundName = data.profile.name;
                    if (data.valid && data.seat) foundSeat = data.seat;
                    confirmedUnavailable = !!(data.valid && data.unavailable && !data.seat);
                    if (confirmedUnavailable) foundSeat = null;
                    if (
                        (foundSeat || confirmedUnavailable) &&
                        foundName &&
                        (avatarSaved || avatarCached)
                    ) {
                        finish(foundSeat);
                    }
                } catch (_) {}
            });
            return GLib.SOURCE_CONTINUE;
        });
        view.load_uri(`https://profile-v3.intra.42.fr/users/${login}`);
    }
};
