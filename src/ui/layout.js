const { Clutter, St } = imports.gi;
const Main = imports.ui.main;

var Controller = class Controller {
    constructor(indicator, settings) {
        this._indicator = indicator;
        this._settings = settings;
        // All side panels share the main popup grab and column layout.
        const bin = indicator.menu._boxPointer.bin;
        const main = indicator.menu.box;
        // Painted panel gaps must retain pointer events inside the popup.
        main.reactive = true;
        // Each column keeps its natural height instead of stretching to the tallest panel.
        main.request_mode = Clutter.RequestMode.HEIGHT_FOR_WIDTH;
        main.x_expand = false;
        main.y_expand = false;
        main.y_align = Clutter.ActorAlign.START;
        bin.remove_child(main);
        indicator.menu.actor.add_style_class_name('pingoose-panel-host');
        main.add_style_class_name('pingoose-main-panel');
        const columns = new St.BoxLayout({
            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
            style_class: 'pingoose-chat-columns',
        });
        columns.add_child(main);
        bin.set_child(columns);
        indicator.sideColumns = columns;
        // Avoid the shared popup outline sliding past independently sized panels on close.
        this._originalClose = indicator.menu.close;
        indicator.menu.close = () =>
            this._originalClose.call(indicator.menu, imports.ui.boxpointer.PopupAnimation.NONE);
        // Main stays last; moving a panel immediately before it preserves the others' order.
        indicator.bringPanelNearMain = (panel) => {
            columns.set_child_below_sibling(panel, main);
            indicator.syncPanelLayout?.();
        };
    }

    destroy() {
        this._indicator.syncPanelLayout = null;
        this._indicator.bringPanelNearMain = null;
        this._indicator.menu.close = this._originalClose;
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
        } catch (_) {
            /* Fall back to the standard top panel before allocation. */
        }
        const alignment = bottom ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
        for (const child of columns.get_children()) {
            child.y_expand = false;
            child.y_align = alignment;
        }
        columns.set_style(
            `spacing: 0; padding-${bottom ? 'bottom' : 'top'}: ${settings.get_int('popup-top-margin')}px; padding-right: ${settings.get_int('popup-left-margin')}px;`
        );
        const panels = columns
            .get_children()
            .filter((child) => child !== indicator.menu.box && child.visible);
        panels.forEach((panel, index) =>
            panel.set_style(
                `margin-right: ${settings.get_int(index === panels.length - 1 ? 'main-panel-gap' : 'panel-gap')}px;`
            )
        );
        indicator.syncPanelLayout = () => this._applyPanelLayout();
    }
};

var LayoutManager = Controller;
