const { GLib } = imports.gi;
const ByteArray = imports.byteArray;

var Controller = class Controller {
    constructor({ context, cancel, settings, current, getCampus, allowedURI, emit }) {
        this.context = context;
        this.cancel = cancel;
        this.featureSettings = settings;
        this.current = current;
        this.getCampus = getCampus;
        this.allowedURI = allowedURI;
        this.emit = emit;
    }

    clear() {
        this.queuedChatLookup = null;
        this.cancelActive?.();
    }

    lookup(request) {
        if (
            !this.current() ||
            !imports.models.featureFlags.enabled(this.featureSettings, 'hidden-cluster-chat') ||
            !/^[a-z0-9_-]{1,64}$/.test(request.login || '') ||
            !/^\d{1,24}$/.test(request.request || '')
        )
            return;
        if (this.chatLookup) {
            if (!request.favorite && !this.queuedChatLookup) this.queuedChatLookup = request;
            else
                this.emit({
                    type: 'chat-lookup',
                    ...request,
                    error: 'Lookup already running. Please try again.',
                });
            return;
        }
        const identity = this.current();
        const view = imports.worker.backgroundView.create(
            this.context,
            (uri) => this.allowedURI(uri),
            { loadImages: !request.stateOnly }
        );
        this.chatLookup = view;
        let attempts = 0,
            reading = false,
            profile = null,
            avatar = null,
            finished = false,
            avatarURL = null,
            avatarReading = false,
            availabilityKnown = false,
            campus = null;
        let timer = 0;
        const release = () => {
            if (timer) GLib.source_remove(timer);
            timer = 0;
            view.stop_loading();
            view.destroy();
            this.chatLookup = null;
            this.cancelActive = null;
        };
        this.cancelActive = () => {
            finished = true;
            release();
        };
        const images = new Map();
        const readAvatar = () => {
            const resource = images.get(avatarURL);
            if (!resource || avatar || avatarReading || finished) return;
            const response = resource.get_response();
            if (
                response?.get_status_code() !== 200 ||
                !/^image\//.test(response.get_mime_type() || '')
            )
                return;
            avatarReading = true;
            resource.get_data(this.cancel, (item, result) => {
                avatarReading = false;
                try {
                    const bytes = item.get_data_finish(result);
                    if (!finished && bytes?.length && bytes.length <= 2000000)
                        avatar = GLib.base64_encode(bytes);
                } catch (_) {}
            });
        };
        const finish = (seat) => {
            if (finished) return;
            finished = true;
            release();
            if (this.current() === identity)
                this.emit({
                    type: 'chat-lookup',
                    ...request,
                    seat: campus && campus === this.getCampus() ? seat : null,
                    ...(!campus || campus !== this.getCampus()
                        ? {
                              error:
                                  campus && this.getCampus()
                                      ? 'Only users from your campus can be added or connected.'
                                      : 'Could not verify the campus. Reload your session and try again.',
                          }
                        : {}),
                    ...(request.favorite
                        ? { profile, avatar, seatKnown: availabilityKnown, campus }
                        : {}),
                });
            const queued = this.queuedChatLookup;
            this.queuedChatLookup = null;
            if (queued && this.current() === identity) this.lookup(queued);
        };
        if (request.favorite && !request.stateOnly)
            view.connect('resource-load-started', (_view, resource, resourceRequest) => {
                const uri = resourceRequest.get_uri() || '';
                if (/^https:\/\/intrapy\.intra\.42\.fr\/api\/v1\/users(?:[/?]|$)/.test(uri)) {
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
                                if (finished || !bytes?.length || bytes.length > 2000000) return;
                                const found = imports.models.favoriteProfile.fromResponse(
                                    JSON.parse(ByteArray.toString(bytes)),
                                    request.login
                                );
                                if (found) profile = found;
                            } catch (_) {}
                        });
                    });
                    return;
                }
                // Match the actual profile portrait URL, not an assumed login filename.
                if (!/^https:\/\/cdn\.intra\.42\.fr\/users\//.test(uri)) return;
                images.set(uri, resource);
                resource.connect('finished', readAvatar);
            });
        timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (++attempts > 15 || this.current() !== identity) {
                finish(null);
                return GLib.SOURCE_REMOVE;
            }
            if (reading || (!request.favorite && view.is_loading)) return GLib.SOURCE_CONTINUE;
            reading = true;
            const script = `JSON.stringify({seat:Array.from(document.querySelectorAll('div,span')).map(e=>e.children.length?'':e.textContent.trim()).find(t=>/^c[0-9]+r[0-9]+s[0-9]+$/i.test(t)) || null, unavailable:Array.from(document.querySelectorAll('div,span')).some(e=>!e.children.length && e.textContent.trim().toLowerCase()==='unavailable'), profile:(${imports.models.favoriteProfile.readDOM.toString()})(${JSON.stringify(request.login)})})`;
            view.run_javascript_in_world(script, 'pingoose-chat-lookup', null, (page, result) => {
                reading = false;
                if (this.chatLookup !== view) return;
                try {
                    const data = JSON.parse(
                        page.run_javascript_in_world_finish(result).get_js_value().to_string()
                    );
                    const seat = data.seat?.toLowerCase() || null;
                    if (data.profile?.profileLogin === request.login) campus = data.profile.campus;
                    if (campus && this.getCampus() && campus !== this.getCampus()) {
                        finish(null);
                        return;
                    }
                    if (request.favorite) {
                        availabilityKnown = !!seat || !!data.unavailable;
                        if (
                            !profile &&
                            data.profile?.profileLogin === request.login &&
                            data.profile.name
                        )
                            profile = { name: data.profile.name };
                        if (data.profile?.profileLogin === request.login)
                            avatarURL = data.profile.avatar || null;
                        readAvatar();
                        if (
                            campus &&
                            campus === this.getCampus() &&
                            (profile || request.stateOnly) &&
                            (request.add || availabilityKnown) &&
                            (request.avatarCached ||
                                avatar ||
                                (!avatarURL && attempts >= 5) ||
                                attempts >= 14)
                        ) {
                            finish(seat);
                        }
                    } else if (seat && campus && campus === this.getCampus()) {
                        finish(seat);
                    }
                } catch (_) {}
            });
            return GLib.SOURCE_CONTINUE;
        });
        view.load_uri('https://profile-v3.intra.42.fr/users/' + encodeURIComponent(request.login));
    }
};
