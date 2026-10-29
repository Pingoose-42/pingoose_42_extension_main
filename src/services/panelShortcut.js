const { Meta, Shell } = imports.gi;
const Main = imports.ui.main;
var Binding = class Binding {
    constructor(settings, open) {
        this.settings = settings;
        this.open = open;
        this.signal = settings.connect('changed::panel-shortcut', () => this.sync());
        this.sync();
    }
    sync() {
        if (this.registered) Main.wm.removeKeybinding('panel-shortcut');
        this.registered = false;
        if (!this.settings.get_strv('panel-shortcut').length) return;
        Main.wm.addKeybinding(
            'panel-shortcut',
            this.settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this.open()
        );
        this.registered = true;
    }
    destroy() {
        if (this.registered) Main.wm.removeKeybinding('panel-shortcut');
        this.settings.disconnect(this.signal);
    }
};
