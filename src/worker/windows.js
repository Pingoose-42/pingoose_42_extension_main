var Controller = class Controller {
    constructor({ context, login, canBrowse, canOpenProject, onError }) {
        this.context = context;
        this.login = login;
        this.canBrowse = canBrowse;
        this.canOpenProject = canOpenProject;
        this.onError = onError;
        this.services = new Set();
        this.projects = new Set();
    }

    open(site, timestamp = 0) {
        if (!this.canBrowse()) return;
        this._open(this.services, site.name, site.url, false, timestamp);
    }

    project(project, timestamp = 0) {
        if (
            !this.canOpenProject() ||
            !/^[a-zA-Z0-9_-]{1,100}$/.test(project.slug) ||
            project.login !== this.login
        )
            return;
        this._open(
            this.projects,
            project.name,
            `https://projects.intra.42.fr/${project.slug}/${project.login}`,
            true,
            timestamp
        );
    }

    _open(windows, name, url, project, timestamp) {
        if (windows.size >= 5) return;
        try {
            const window = imports.worker.serviceBrowser.open(
                this.context,
                name,
                url,
                project,
                timestamp
            );
            windows.add(window);
            window.connect('destroy', () => windows.delete(window));
        } catch (_) {
            this.onError();
        }
    }

    closeServices() {
        for (const window of [...this.services]) window.destroy();
        this.services.clear();
    }

    clear() {
        this.closeServices();
        for (const window of [...this.projects]) window.destroy();
        this.projects.clear();
    }
};
