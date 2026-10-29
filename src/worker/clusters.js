const { GLib, Soup } = imports.gi;

var Controller = class Controller {
    constructor({ context, session, cancel, settings, current, emit }) {
        this.context = context;
        this.session = session;
        this.cancel = cancel;
        this.featureSettings = settings;
        this.current = current;
        this.emit = emit;
        this.clusterCampus = null;
    }

    clear() {
        this.cancelClusterLookup?.();
        this.clusterCampus = null;
    }

    lookup(request) {
        if (
            !this.current() ||
            this.clusterLookup ||
            !imports.models.featureFlags.enabled(this.featureSettings, 'hidden-cluster-chat') ||
            !/^\d{1,24}$/.test(request.request || '')
        )
            return;
        const identity = this.current();
        this.clusterLookup = true;
        let finished = false;
        let deadline = 0;
        const finish = (data) => {
            if (finished) return;
            finished = true;
            if (deadline) GLib.source_remove(deadline);
            deadline = 0;
            this.clusterLookup = false;
            this.cancelClusterLookup = null;
            if (this.current() === identity)
                this.emit({ type: 'favorite-clusters', request: request.request, ...data });
        };
        this.cancelClusterLookup = () => finish({ error: 'Cluster lookup cancelled.' });
        deadline = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
            deadline = 0;
            finish({ error: 'Cluster lookup timed out. Please try again.' });
            return GLib.SOURCE_REMOVE;
        });
        // Use Meta's own scoped cookies, never the profile API bearer token.
        const get = (path, done) => {
            const uri = 'https://meta.intra.42.fr' + path;
            this.context.get_cookie_manager().get_cookies(uri, this.cancel, (manager, result) => {
                if (finished) return;
                try {
                    const cookies = manager.get_cookies_finish(result);
                    const message = Soup.Message.new('GET', uri);
                    message.set_flags(Soup.MessageFlags.NO_REDIRECT);
                    message.request_headers.append(
                        'Cookie',
                        cookies.map((cookie) => cookie.to_cookie_header()).join('; ')
                    );
                    this.session.queue_message(message, (_session, response) => {
                        if (finished) return;
                        if (
                            response.status_code !== 200 ||
                            response.response_body.length > 5000000
                        ) {
                            finish({
                                error: 'Could not load cluster seats. Open Meta Clusters in Pingoose and sign in, then try again.',
                            });
                            return;
                        }
                        try {
                            done(response.response_body.data);
                        } catch (_) {
                            finish({
                                error: 'Could not read the cluster response. Please try again.',
                            });
                        }
                    });
                } catch (_) {
                    finish({ error: 'Could not load cluster seats. Please try again.' });
                }
            });
        };
        const loadSeats = () =>
            get('/clusters.json', (body) =>
                finish(imports.models.clusterSeats.snapshot(JSON.parse(body), this.clusterCampus))
            );
        if (this.clusterCampus) loadSeats();
        else
            get('/clusters', (body) => {
                const campus = body.match(/\bdata-campus-id=["'](\d+)["']/)?.[1];
                if (!campus) {
                    finish({
                        error: 'Could not identify your cluster campus. Please sign in to Meta Clusters.',
                    });
                    return;
                }
                this.clusterCampus = campus;
                loadSeats();
            });
    }
};
