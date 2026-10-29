const { Gio } = imports.gi;
const Me = imports.misc.extensionUtils.getCurrentExtension();

// Reset completes only when the worker has removed its data and exited.
var Controller = class Controller {
    constructor(bridge, settings, { prepare, clear, refresh, updater }) {
        this.bridge = bridge;
        this.settings = settings;
        this.prepare = prepare;
        this.clear = clear;
        this.refresh = refresh;
        this.updater = updater;
        this.active = false;
        this.listeners = [
            bridge.on('reset-ready', () => {
                this.ready = true;
                this.finish();
            }),
            bridge.on('reset-error', () => {
                this.active = false;
                settings.set_string('reset-status', 'error');
            }),
            bridge.on('process-exited', () => {
                this.exited = true;
                if (this.active && !this.ready) {
                    this.active = false;
                    settings.set_string('reset-status', 'error');
                } else this.finish();
            }),
        ];
        this.signal = settings.connect('changed::reset-request', () => this.request());
    }

    request() {
        if (this.active || !this.settings.get_string('reset-request')) return;
        if (this.updater?.installing || !this.bridge.isRunning) {
            this.settings.set_string('reset-status', 'error');
            return;
        }
        this.updater?.destroy();
        this.updater = null;
        this.active = true;
        this.ready = false;
        this.exited = false;
        this.settings.set_string('reset-status', 'running');
        this.prepare();
        this.clear();
        this.bridge.send('reset-all');
    }

    finish() {
        if (!this.active || !this.ready || !this.exited) return;
        try {
            Me.imports.services.resetData.clearAll();
            Me.imports.models.settingsDefaults.restore(this.settings);
            this.clear();
            this.settings.set_string('reset-request', '');
            this.settings.set_string('reset-status', 'done');
            Gio.Settings.sync();
        } catch (error) {
            logError(error, 'Pingoose reset failed');
            this.settings.set_string('reset-status', 'error');
        }
        this.active = false;
        this.ready = false;
        this.refresh();
        this.bridge.start();
    }

    destroy() {
        this.settings.disconnect(this.signal);
        this.listeners.forEach((unsubscribe) => unsubscribe());
    }
};
