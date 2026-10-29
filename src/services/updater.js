// Desktop lifecycle and notifications. Network/git/install work stays out of Shell.
const { Gio, GLib } = imports.gi;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const Me = imports.misc.extensionUtils.getCurrentExtension();

var Updater = class Updater {
    constructor(settings, installed = null) {
        this._installed = installed;
        this._settings = settings;
        this._alive = true;
        this.installing = false;
        this._settingsSignal = settings.connect('changed::update-check-request', () =>
            this._check(true)
        );
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
            this._timer = 0;
            this._check(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _check(manual) {
        if (this._process || this.installing) {
            if (manual)
                this._notify(
                    'Pingoose Update',
                    'An update check or installation is already running.'
                );
            return;
        }
        if (manual) this._notify('Checking for updates', 'Checking the configured GitHub branch…');
        this._run(
            'check',
            null,
            (result) => {
                if (result.status === 'available') this._offer(result);
                else if (result.status === 'error')
                    this._notify('Update check failed', result.error);
                else if (manual && result.status === 'current')
                    this._notify(
                        'Pingoose is up to date',
                        'No newer commit was found on the configured branch.'
                    );
                else if (manual && result.status === 'busy')
                    this._notify(
                        'Pingoose Update',
                        'Another update check or installation is already running.'
                    );
            },
            manual
        );
    }

    _run(action, commit, complete, manual = false) {
        const args = ['/usr/bin/python3', `${Me.path}/worker/updater.py`, action];
        if (commit) args.push('--commit', commit);
        if (manual) args.push('--force');
        try {
            const process = Gio.Subprocess.new(
                args,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            this._process = process;
            process.communicate_utf8_async(null, null, (child, response) => {
                let result;
                try {
                    const [, stdout] = child.communicate_utf8_finish(response);
                    result = JSON.parse(stdout);
                    if (!child.get_successful() && result.status !== 'error') throw Error();
                } catch (_) {
                    result = {
                        status: 'error',
                        error: 'The update helper failed. Please try again at the next login.',
                    };
                }
                if (this._process === child) this._process = null;
                if (this._alive) complete(result);
            });
        } catch (_) {
            complete({ status: 'error', error: 'Could not start the update helper.' });
        }
    }

    _notify(title, body, actions = []) {
        if (!this._alive) return;
        if (!this._source) {
            this._source = new MessageTray.Source(
                'Pingoose Update',
                'software-update-available-symbolic'
            );
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        const notice = new MessageTray.Notification(this._source, title, body);
        notice.pingooseBanner = true;
        notice.setTransient(!actions.length);
        notice.setResident(!!actions.length);
        for (const [label, action] of actions)
            notice.addAction(label, () => {
                notice.destroy();
                action();
            });
        this._source.showNotification(notice);
    }

    _offer(result) {
        const commit = result.commit;
        if (this._settings.get_boolean('auto-update')) {
            this._install(commit.sha);
            return;
        }
        let answered = false;
        const answer = (yes) => {
            if (answered) return;
            answered = true;
            if (yes) this._install(commit.sha);
        };
        this._notify(
            'A new version of Pingoose is available',
            `${result.repository} · ${result.branch}\n${commit.sha.slice(0, 7)} · ${commit.message}\nUpdate now?`,
            [
                ['Yes', () => answer(true)],
                ['No', () => answer(false)],
            ]
        );
    }

    _install(commit) {
        if (this.installing || !this._alive) return;
        this.installing = true;
        this._notify('Updating Pingoose', 'Downloading and installing the approved commit…');
        this._run('install', commit, (result) => {
            this.installing = false;
            if (result.status === 'installed') {
                this._installed?.(result.commit);
                this._notify(
                    'Pingoose update complete',
                    'Restart GNOME Shell to apply it: press Alt+F2, type r, and press Enter (X11). On Wayland, log out and back in.'
                );
            } else
                this._notify(
                    'Pingoose update failed',
                    result.error || 'Another update is already running.'
                );
        });
    }

    destroy() {
        if (!this._alive) return;
        this._alive = false;
        this._settings.disconnect(this._settingsSignal);
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = 0;
        // Let an approved installation finish even if the extension is disabled.
        if (!this.installing) this._process?.force_exit();
        this._source?.destroy();
        this._source = null;
    }
};
