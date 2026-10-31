const { WebKit2 } = imports.gi;

// Background requests share navigation restrictions, but their callers own
// loading, cancellation, timers and destruction for each individual operation.
function create(context, allowedURI, { loadImages = true } = {}) {
    const view = new WebKit2.WebView({ web_context: context });
    const settings = view.get_settings();
    settings.set_enable_write_console_messages_to_stdout(false);
    if (!loadImages) settings.set_auto_load_images(false);
    view.connect('permission-request', (_view, request) => {
        request.deny();
        return true;
    });
    view.connect('decide-policy', (_view, decision, type) => {
        if (
            type === WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION ||
            (type === WebKit2.PolicyDecisionType.NAVIGATION_ACTION &&
                !allowedURI(decision.get_navigation_action().get_request().get_uri()))
        ) {
            decision.ignore();
            return true;
        }
        return false;
    });
    return view;
}
