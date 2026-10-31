const { Clutter, St } = imports.gi;
const Util = imports.misc.util;
const Size = imports.misc.extensionUtils.getCurrentExtension().imports.models.panelSize;

// The menu keeps its original box and menu-item parents. An outside viewport
// handles screen overflow without changing the width or hiding fixed controls.
function mainViewport(box) {
    const scroll = new St.ScrollView({
        reactive: true,
        overlay_scrollbars: true,
        enable_mouse_scrolling: false,
        x_expand: false,
        y_expand: false,
        y_align: Clutter.ActorAlign.START,
        request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
        style_class: 'popup-menu-content pingoose-main-panel pingoose-main-viewport',
    });
    box.remove_style_class_name('popup-menu-content');
    box.remove_style_class_name('pingoose-main-panel');
    scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.NEVER);
    scroll.add_actor(box);
    return scroll;
}

function sideViewport(panel) {
    const scroll = new St.ScrollView({
        reactive: true,
        overlay_scrollbars: true,
        enable_mouse_scrolling: false,
        x_expand: false,
        y_expand: false,
        y_align: Clutter.ActorAlign.START,
        request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
        style_class: 'pingoose-panel-viewport',
    });
    scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.NEVER);
    scroll.add_actor(panel);
    panel.show();
    return scroll;
}

// Side-panel headers and inputs retain their natural height. Only the designated
// list/log viewport takes the remaining room, so resizing cannot squash controls.
var Viewport = class Viewport {
    constructor(actor, scroll = null, onAutomatic = null, content = actor) {
        this.actor = actor;
        this.content = content;
        this.scroll = scroll;
        this.onAutomatic = onAutomatic;
        this.fixed = false;
        this.scrollStyle = scroll?.get_style() || null;
    }

    chromeHeight() {
        if (!this.scroll) return 0;
        const node = this.content.get_theme_node();
        const width = node.adjust_for_width(this.content.width);
        const children = this.content.get_children().filter((child) => child.visible);
        let height = Math.max(0, children.length - 1) * node.get_length('spacing');
        for (const child of children) {
            if (child !== this.scroll) height += child.get_preferred_height(width)[1];
        }
        return Math.ceil(node.adjust_preferred_height(height, height)[1]);
    }

    minimumHeight() {
        return this.scroll ? this.chromeHeight() + Size.MINIMUM_VIEWPORT : this.naturalHeight();
    }

    dynamicHeight() {
        // Lists/logs keep their manually chosen reading area. Headers, forms
        // and Reveal rows grow around it instead of taking its space away.
        return this.scroll ? this.chromeHeight() : this.naturalHeight();
    }

    naturalHeight() {
        if (this.scroll) {
            const node = this.content.get_theme_node();
            const width = node.adjust_for_width(this.content.width || this.actor.width);
            return this.chromeHeight() + this.scroll.get_preferred_height(width)[1];
        }
        const node = this.actor.get_theme_node();
        const width = node.adjust_for_width(this.actor.width);
        const height = this.content.get_preferred_height(width)[1];
        return Math.ceil(node.adjust_preferred_height(height, height)[1]);
    }

    apply(height, natural = false) {
        const first = !this.fixed;
        this.fixed = true;
        this.naturalMode = natural;
        if (this.scroll) {
            const chrome = this.chromeHeight();
            const overflow = natural || height < chrome + Size.MINIMUM_VIEWPORT;
            const changedMode = overflow !== this.overflow;
            if (changedMode) {
                this.overflow = overflow;
                this.actor.set_policy(
                    St.PolicyType.NEVER,
                    overflow ? St.PolicyType.AUTOMATIC : St.PolicyType.NEVER
                );
                this.actor.enable_mouse_scrolling = overflow;
                this.scroll.set_style(
                    overflow
                        ? this.scrollStyle
                        : (this.scrollStyle || '') + '; min-height: 0; max-height: 4096px;'
                );
                if (overflow) {
                    this.scroll.height = -1;
                    this.content.height = -1;
                    this.onAutomatic?.();
                }
            }
            if (!overflow) {
                const available = height - chrome;
                if (first || changedMode || Math.abs(this.scroll.height - available) > 0.5)
                    this.scroll.height = available;
                if (first || changedMode || Math.abs(this.content.height - height) > 0.5)
                    this.content.height = height;
            }
        } else {
            this.actor.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
            this.actor.enable_mouse_scrolling = true;
        }
        if (first || Math.abs(this.actor.height - height) > 0.5) this.actor.height = height;
    }

    restore(notify = true) {
        if (!this.fixed) return;
        this.fixed = false;
        this.naturalMode = false;
        this.overflow = undefined;
        this.actor.height = -1;
        if (this.scroll) {
            this.content.height = -1;
            this.scroll.height = -1;
            this.scroll.set_style(this.scrollStyle);
        }
        this.actor.set_policy(St.PolicyType.NEVER, St.PolicyType.NEVER);
        this.actor.enable_mouse_scrolling = false;
        if (notify) this.onAutomatic?.();
    }

    revealFocus(focus) {
        if (
            this.fixed &&
            (!this.scroll || this.overflow) &&
            focus &&
            focus !== this.actor &&
            this.actor.contains(focus)
        )
            Util.ensureActorVisibleInScrollView(this.actor, focus);
    }
};
