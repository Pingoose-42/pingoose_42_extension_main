// Load the real GJS module with explicit platform doubles, without a Shell session.
const fs = require('node:fs');
const vm = require('node:vm');
function moduleExport(path, name, context = {}) {
    const supplied = context.imports || {};
    const imports = {
        ...supplied,
        gi: supplied.gi || context,
        ui: {
            ...supplied.ui,
            main: { ...supplied.ui?.main, ...context.Main },
            popupMenu: context.PopupMenu || supplied.ui?.popupMenu || {},
            messageTray: context.MessageTray || supplied.ui?.messageTray || {},
        },
    };
    return vm.runInNewContext(fs.readFileSync(`src/${path}`, 'utf8') + '\n' + name, {
        ...context,
        imports,
    });
}
const controller = (path, context = {}) => moduleExport(path, 'Controller', context);
module.exports = { controller, moduleExport };

// Small scene-graph double shared by controller tests; no Shell process is launched.
class Signals {
    constructor() {
        this.signals = new Map();
        this.nextSignal = 1;
    }
    connect(name, callback) {
        const id = this.nextSignal++;
        this.signals.set(id, { name, callback });
        return id;
    }
    disconnect(id) {
        this.signals.delete(id);
    }
    emit(name, ...args) {
        let result;
        for (const signal of [...this.signals.values()])
            if (signal.name === name) result = signal.callback(this, ...args);
        return result;
    }
}
class Text extends Signals {
    set_single_line_mode() {}
    set_line_wrap() {}
    set_line_wrap_mode() {}
    set_activatable() {}
    set_editable(value) {
        this.editable = value;
    }
    delete_selection() {
        this.deleted = true;
    }
    insert_unichar(value) {
        this.inserted = value;
    }
}
class Actor extends Signals {
    constructor(props = {}) {
        super();
        this.children = [];
        this.clutter_text = new Text();
        this._visible = true;
        this._text = '';
        this.mapped = true;
        this.width = 278;
        this.height = 100;
        this.adjustment = Object.assign(new Signals(), {
            lower: 0,
            upper: 700,
            page_size: 150,
            value: 0,
        });
        Object.assign(this, props);
    }
    get visible() {
        return this._visible;
    }
    set visible(value) {
        this._visible = value;
        this.emit('notify::visible');
    }
    get text() {
        return this._text;
    }
    set text(value) {
        this._text = value;
        this.clutter_text.emit('text-changed');
    }
    show() {
        this.visible = true;
    }
    hide() {
        this.visible = false;
    }
    add_child(child) {
        this.children.push(child);
        child.parent = this;
    }
    add_actor(child) {
        this.add_child(child);
    }
    set_child(child) {
        this.add_child(child);
    }
    get_children() {
        return [...this.children];
    }
    add_style_class_name(name) {
        this.style_class = (this.style_class || '') + ' ' + name;
    }
    remove_style_class_name(name) {
        this.style_class = (this.style_class || '').replace(name, '').trim();
    }
    set_style(style) {
        this.style = style;
    }
    set_policy() {}
    set_clip_to_allocation() {}
    set_position(x, y) {
        this.x = x;
        this.y = y;
    }
    get_vscroll_bar() {
        return { get_adjustment: () => this.adjustment };
    }
    get_theme_node() {
        return {
            get_content_box: () => ({ x1: 10, x2: this.width - 10, y1: 10 }),
            get_foreground_color: () => ({}),
        };
    }
    destroy() {
        for (const child of [...this.children]) child.destroy();
        if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
        this.signals.clear();
        this.clutter_text.signals.clear();
        this.destroyed = true;
    }
}
module.exports.Signals = Signals;
module.exports.Actor = Actor;
