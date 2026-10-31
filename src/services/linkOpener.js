const { Gio } = imports.gi;

/**
 * Opens a link either in the default system browser or in the Pingoose WebKit window,
 * depending on the 'open-in-browser' setting.
 */
function openLink(settings, bridge, site) {
    if (!site || !site.url) return;

    if (settings && settings.get_boolean('open-in-browser')) {
        try {
            const context =
                typeof global !== 'undefined' && global.create_app_launch_context
                    ? global.create_app_launch_context(0, -1)
                    : null;
            Gio.AppInfo.launch_default_for_uri(site.url, context);
            return;
        } catch (_) {
            // Fall back to built-in webview if system browser launch fails
        }
    }

    const payload = JSON.stringify({ name: site.name || '42 Intra', url: site.url });
    bridge?.send?.('service:open:' + payload);
}

/**
 * Opens a project page either in the default browser or in Pingoose WebKit window.
 */
function openProject(settings, bridge, project) {
    if (!project || !project.slug) return;

    if (settings && settings.get_boolean('open-in-browser')) {
        const url = `https://projects.intra.42.fr/${project.slug}/${project.login || ''}`;
        try {
            const context =
                typeof global !== 'undefined' && global.create_app_launch_context
                    ? global.create_app_launch_context(0, -1)
                    : null;
            Gio.AppInfo.launch_default_for_uri(url, context);
            return;
        } catch (_) {
            // Fall back to built-in webview
        }
    }

    bridge?.send?.('project:open:' + JSON.stringify(project));
}

if (typeof module !== 'undefined') {
    module.exports = { openLink, openProject };
}
