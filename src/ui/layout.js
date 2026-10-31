const { Clutter, St } = imports.gi;
const Main = imports.ui.main;
const Me = imports.misc.extensionUtils.getCurrentExtension();

var Controller = class Controller {
    constructor(indicator, settings) {
        this._indicator = indicator;
        this._settings = settings;
        this._resizers = new Map();
        this._signals = [];
        this._inputMethod = new Me.imports.ui.inputMethodPopup.Controller(indicator.menu);
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
        this._mainActor = Me.imports.ui.panelViewport.mainViewport(main);
        const columns = new St.BoxLayout({
            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
            style_class: 'pingoose-chat-columns',
        });
        columns.add_child(this._mainActor);
        bin.set_child(columns);
        indicator.sideColumns = columns;
        this._panels = new Map();
        this._motion = new Me.imports.ui.popupMotion.Controller(
            indicator.menu,
            columns,
            () => this._bottom
        );
        this._mainResize = this._addResize(this._mainActor, {
            key: 'main-panel-height',
        });
        const environmentChanged = () => {
            for (const resize of this._resizers.values()) resize.cancel();
            this._applyPanelLayout();
        };
        this._signals.push([
            Main.layoutManager,
            Main.layoutManager.connect('monitors-changed', environmentChanged),
        ]);
        this._signals.push([
            global.display,
            global.display.connect('workareas-changed', environmentChanged),
        ]);
        this._signals.push([
            global.stage,
            global.stage.connect('notify::key-focus', () => {
                for (const resize of this._resizers.values())
                    resize.viewport.revealFocus(global.stage.get_key_focus());
            }),
        ]);
        indicator.addPanel = (panel, sizing = null) => {
            const frame = sizing ? Me.imports.ui.panelViewport.sideViewport(panel) : panel;
            const reveal = new Me.imports.ui.reveal.Reveal(frame, true);
            this._panels.set(panel, reveal);
            columns.insert_child_at_index(reveal, 0);
            reveal.connect('notify::visible', () => this._applyPanelLayout());
            return sizing ? this._addResize(panel, sizing, reveal, frame) : null;
        };
        indicator.setPanelVisible = (panel, visible) => {
            if (!visible) this._resizers.get(panel)?.cancel();
            this._panels.get(panel).setExpanded(visible, indicator.menu.isOpen);
        };
        indicator.placePanelBefore = (panel, sibling) => {
            columns.set_child_below_sibling(this._panels.get(panel), this._panels.get(sibling));
        };
        // Main stays last; moving a panel immediately before it preserves the others' order.
        indicator.bringPanelNearMain = (panel) => {
            columns.set_child_below_sibling(this._panels.get(panel), this._mainActor);
            indicator.syncPanelLayout?.();
        };
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        for (const [object, signal] of this._signals) object.disconnect(signal);
        this._signals = [];
        for (const resize of this._resizers.values()) resize.destroy();
        this._resizers.clear();
        this._inputMethod.destroy();
        this._indicator.syncPanelLayout = null;
        this._indicator.bringPanelNearMain = null;
        this._motion.destroy();
        this._indicator.addPanel = null;
        this._indicator.setPanelVisible = null;
        this._indicator.placePanelBefore = null;
        for (const reveal of this._panels.values()) reveal.destroy();
        this._panels.clear();
    }

    _addResize(panel, sizing, reveal = null, frame = panel) {
        const viewport = new Me.imports.ui.panelViewport.Viewport(
            frame,
            sizing.scroll,
            sizing.onAutomatic,
            panel
        );
        const resize = new Me.imports.ui.panelResize.Controller(
            frame,
            viewport,
            this._settings,
            sizing.key,
            {
                menu: this._indicator.menu,
                bounds: (actor) => this._resizeBounds(actor),
                ready: () =>
                    Math.abs(this._indicator.sideColumns.translation_y) < 0.5 &&
                    (!reveal || (reveal.expanded && reveal.progress === 1)),
            }
        );
        this._resizers.set(panel, resize);
        return resize;
    }

    _resizeBounds(actor) {
        const indicator = this._indicator;
        const index = Main.layoutManager.findIndexForActor(indicator);
        const workArea = Main.layoutManager.getWorkAreaForMonitor(index);
        const [, sourceY] = indicator.get_transformed_position();
        const [, sourceHeight] = indicator.get_transformed_size();
        const [, transformedHeight] = actor.get_transformed_size();
        const scale = actor.height > 0 ? transformedHeight / actor.height : 1;
        const bottom = !!this._bottom;
        const anchor = bottom ? sourceY : sourceY + sourceHeight;
        // CSS lengths are scaled by St; the stored px value is not necessarily
        // the actual padding at the current display scale.
        const margin = indicator.sideColumns
            .get_theme_node()
            .get_padding(bottom ? St.Side.BOTTOM : St.Side.TOP);
        return {
            bottom,
            scale,
            maximum: Me.imports.models.panelSize.availableHeight(
                workArea,
                anchor,
                bottom,
                margin + 4,
                scale
            ),
        };
    }

    applyPanelLayout() {
        this._applyPanelLayout();
    }

    _applyPanelLayout() {
        const indicator = this._indicator;
        if (this._destroyed || !indicator?.sideColumns) return;
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
            .filter((child) => child !== (this._mainActor || indicator.menu.box) && child.visible);
        panels.forEach((panel, index) =>
            (panel.childActor || panel).set_style(
                `margin-right: ${settings.get_int(index === panels.length - 1 ? 'main-panel-gap' : 'panel-gap')}px;`
            )
        );
        for (const resize of this._resizers?.values() || []) resize.refresh();
        indicator.syncPanelLayout = () => this._applyPanelLayout();
    }
};

var LayoutManager = Controller;
