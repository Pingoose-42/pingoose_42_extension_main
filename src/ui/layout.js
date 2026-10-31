const { Clutter, St } = imports.gi;
const Main = imports.ui.main;
const Me = imports.misc.extensionUtils.getCurrentExtension();

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
        bin.set_child(null);
        indicator.menu.actor.add_style_class_name('pingoose-panel-host');
        main.add_style_class_name('pingoose-main-panel');
        const columns = new St.BoxLayout({
            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
            style_class: 'pingoose-chat-columns',
        });
        columns.add_child(main);
        bin.set_child(columns);
        indicator.sideColumns = columns;
        this._panels = new Map();
        this._motion = new Me.imports.ui.popupMotion.Controller(
            indicator.menu,
            columns,
            () => this._bottom
        );
        indicator.addPanel = (panel) => {
            const reveal = new Me.imports.ui.reveal.Reveal(panel, true);
            this._panels.set(panel, reveal);
            columns.insert_child_at_index(reveal, 0);
            reveal.connect('notify::visible', () => this._applyPanelLayout());
        };
        indicator.setPanelVisible = (panel, visible) => {
            this._panels.get(panel).setExpanded(visible, indicator.menu.isOpen);
        };
        indicator.placePanelBefore = (panel, sibling) => {
            columns.set_child_below_sibling(this._panels.get(panel), this._panels.get(sibling));
        };
        // Main stays last; moving a panel immediately before it preserves the others' order.
        indicator.bringPanelNearMain = (panel) => {
            columns.set_child_below_sibling(this._panels.get(panel), main);
            indicator.syncPanelLayout?.();
        };
    }

    destroy() {
        this._indicator.syncPanelLayout = null;
        this._indicator.bringPanelNearMain = null;
        this._motion.destroy();
        this._indicator.addPanel = null;
        this._indicator.setPanelVisible = null;
        this._indicator.placePanelBefore = null;
        for (const reveal of this._panels.values()) reveal.destroy();
        this._panels.clear();
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
        this._bottom = bottom;
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
            (panel.childActor || panel).set_style(
                `margin-right: ${settings.get_int(index === panels.length - 1 ? 'main-panel-gap' : 'panel-gap')}px;`
            )
        );
        indicator.syncPanelLayout = () => this._applyPanelLayout();
    }
};

var LayoutManager = Controller;
