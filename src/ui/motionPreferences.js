const { St } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;

// Shared policy, independent of panel contents or saved expansion state.
var Controller = class Controller {
    constructor(onChange) {
        this.settings = ExtensionUtils.getSettings();
        this.desktop = St.Settings.get();
        this.signals = [
            [this.settings, this.settings.connect('changed::panel-animations', onChange)],
            [this.settings, this.settings.connect('changed::panel-animation-duration', onChange)],
            [this.desktop, this.desktop.connect('notify::enable-animations', onChange)],
        ];
    }
    get enabled() {
        return this.desktop.enable_animations && this.settings.get_boolean('panel-animations');
    }
    get duration() {
        return Math.max(100, Math.min(500, this.settings.get_int('panel-animation-duration')));
    }
    destroy() {
        for (const [object, signal] of this.signals) object.disconnect(signal);
        this.signals = [];
    }
};
