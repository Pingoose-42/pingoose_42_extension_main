const {Gio} = imports.gi;
const Me = imports.misc.extensionUtils.getCurrentExtension();

var Controller = class Controller {
    initManager(options = {}) {
        this._indicator = options.indicator || null;
        this._settings = options.settings || null;
        this._bridge = options.bridge || null;
        this._servicePanel = options.servicePanel || null;
        this._updater = options.updater || null;
    }

    _requestFullReset() {
        if (this._resetting || !this._settings?.get_string('reset-request')) return;
        if (this._updater?.installing) {
            this._settings?.set_string('reset-status', 'error');
            return;
        }
        this._updater?.destroy();
        this._updater = null;
        const hasProcess = this._bridge?.isRunning || !!this._process;
        if (!hasProcess) {
            this._settings?.set_string('reset-status', 'error');
            return;
        }
        this._resetting = true;
        this._resetReady = false;
        this._resetWorkerExited = false;
        this._settings?.set_string('reset-status', 'running');
        this._indicator?.menu.close();
        if (this._servicePanel) {
            this._servicePanel.expanded = false;
            this._servicePanel.sync();
            for (const process of this._servicePanel.previews || []) process.force_exit();
        }
        this._bannerSource?.destroy();
        this._clearFlash?.();
        this._clearProfile?.();
        this._commands = [];
        if (this._bridge) this._bridge.send('reset-all');
        else if (this._send) this._send('reset-all');
    }

    _finishFullReset() {
        try {
            Me.imports.services.resetData.clearAll();
            Me.imports.models.settingsDefaults.restore(this._settings);
            this._cardArchiveFailed = false;
            this._clearProfile?.();
            this._servicePanel?.render();
            this._settings?.set_string('reset-request', '');
            this._settings?.set_string('reset-status', 'done');
            Gio.Settings.sync();
        } catch (error) {
            logError(error, 'Pingoose reset failed');
            this._settings?.set_string('reset-status', 'error');
        }
        this._resetReady = false;
        this._resetting = false;
        this._applyTheme?.();
        this._syncOptionalSections?.();
        if (this._bridge) this._bridge.start();
        else if (this._startWorker) this._startWorker();
    }
};

function ResetManager(options = {}) {
    this.initManager(options);
}
ResetManager.prototype = Object.create(Controller.prototype);
ResetManager.prototype.constructor = ResetManager;
