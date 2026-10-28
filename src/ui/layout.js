const {Clutter} = imports.gi;
const Main = imports.ui.main;

var Controller = class Controller {
    initManager(indicator, settings) {
        this._indicator = indicator;
        this._settings = settings;
    }

    applyPanelLayout() {
        this._applyPanelLayout();
    }

    _applyPanelLayout() {
        const indicator = this._indicator;
        if (!indicator?.sideColumns) return;
        const columns = indicator.sideColumns;
        const settings = this._settings;
        let bottom = false;
        try {
            const monitor = Main.layoutManager.findMonitorForActor(indicator);
            const [, y] = indicator.get_transformed_position();
            bottom = !!monitor && y + indicator.height / 2 > monitor.y + monitor.height / 2;
        } catch (_) { /* Fall back to the standard top panel before allocation. */ }
        const alignment = bottom ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
        for (const child of columns.get_children()) {
            child.y_expand = false;
            child.y_align = alignment;
        }
        columns.set_style(`spacing: 0; padding-${bottom ? 'bottom' : 'top'}: ${settings.get_int('popup-top-margin')}px; padding-right: ${settings.get_int('popup-left-margin')}px;`);
        const panels = columns.get_children().filter(child => child !== indicator.menu.box && child.visible);
        panels.forEach((panel, index) => panel.set_style(`margin-right: ${settings.get_int(index === panels.length - 1 ? 'main-panel-gap' : 'panel-gap')}px;`));
        indicator.syncPanelLayout = () => this._applyPanelLayout();
    }
};

function LayoutManager(indicator, settings) {
    this.initManager(indicator, settings);
}
LayoutManager.prototype = Object.create(Controller.prototype);
LayoutManager.prototype.constructor = LayoutManager;
