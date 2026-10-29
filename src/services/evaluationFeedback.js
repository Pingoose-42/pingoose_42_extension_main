const { WebKit2, GLib } = imports.gi;
const Model = imports.models.evaluationFeedback;
var Checker = class Checker {
    constructor(context, allowedURI) {
        this.context = context;
        this.allowedURI = allowedURI;
    }
    run(login, slug, callback) {
        if (this.view) return;
        const view = (this.view = new WebKit2.WebView({ web_context: this.context }));
        view.get_settings().set_auto_load_images(false);
        view.get_settings().set_enable_write_console_messages_to_stdout(false);
        const finish = (value) => {
            if (this.view !== view) return;
            this.close();
            callback(value);
        };
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
        view.connect('load-failed', () => {
            finish(null);
            return false;
        });
        view.connect('load-changed', (_view, event) => {
            if (event !== WebKit2.LoadEvent.FINISHED || this.view !== view) return;
            if (view.get_main_resource()?.get_response()?.get_status_code() !== 200) {
                finish(null);
                return;
            }
            const script = `JSON.stringify((${Model.readPage.toString()})(${JSON.stringify(login)},${JSON.stringify(slug)}))`;
            view.run_javascript_in_world(script, 'pingoose-feedback', null, (page, result) => {
                if (this.view !== view) return;
                try {
                    finish(
                        JSON.parse(
                            page.run_javascript_in_world_finish(result).get_js_value().to_string()
                        )
                    );
                } catch (_) {
                    finish(null);
                }
            });
        });
        this.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 25, () => {
            this.timer = 0;
            finish(null);
            return GLib.SOURCE_REMOVE;
        });
        const request = WebKit2.URIRequest.new(`https://projects.intra.42.fr/${slug}/${login}`);
        request.get_http_headers().replace('Cache-Control', 'no-cache');
        view.load_request(request);
    }
    close() {
        if (this.timer) GLib.source_remove(this.timer);
        this.timer = 0;
        const view = this.view;
        this.view = null;
        view?.stop_loading();
        view?.destroy();
    }
};
