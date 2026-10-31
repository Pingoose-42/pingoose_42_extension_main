const { St } = imports.gi;
const Size = imports.misc.extensionUtils.getCurrentExtension().imports.models.panelSize;

// Give short lists only the space they need, then share the remaining height
// among longer lists. A tiny work area retains readable lists for outer scrolling.
function distribute(natural, minimum, available) {
    const heights = minimum.slice();
    let remaining = Math.max(0, available - heights.reduce((sum, value) => sum + value, 0));
    let pending = natural.map((_height, index) => index);
    while (remaining > 0.01 && pending.length) {
        const share = remaining / pending.length;
        const next = [];
        for (const index of pending) {
            const extra = Math.min(share, Math.max(0, natural[index] - heights[index]));
            heights[index] += extra;
            remaining -= extra;
            if (natural[index] - heights[index] > 0.01) next.push(index);
        }
        pending = next;
    }
    return heights;
}

var Controller = class Controller {
    constructor(actor, content, sections) {
        this.actor = actor;
        this.content = content;
        this.sections = sections || [];
        this.heights = new Map();
    }

    _visible(reveal) {
        for (let actor = reveal; actor; actor = actor.get_parent()) {
            if (!actor.visible) return false;
            if (actor === this.content) return true;
        }
        return false;
    }

    _measure() {
        const node = this.actor.get_theme_node();
        const width = node.adjust_for_width(this.actor.width);
        const current = this.content.get_preferred_height(width)[1];
        let chrome = node.adjust_preferred_height(current, current)[1];
        const entries = [];
        for (const section of this.sections) {
            const { scroll, content, reveal } = section;
            if (!this._visible(reveal)) continue;
            const progress = Math.max(0, Math.min(1, reveal.progress));
            if (!progress) continue;
            const scrollNode = scroll.get_theme_node();
            let contentWidth = scrollNode.adjust_for_width(scroll.width || reveal.width || width);
            // Reserve the normal scrollbar width even while its list fits. This
            // prevents wrapping from oscillating when a scrollbar appears.
            if (!scroll.overlay_scrollbars)
                contentWidth -= scroll.get_vscroll_bar()?.get_preferred_width(-1)[1] || 0;
            const contentHeight = content.get_preferred_height(Math.max(1, contentWidth))[1];
            const margin = (scroll.margin_top || 0) + (scroll.margin_bottom || 0);
            // adjust_preferred_height() would reapply the stylesheet's old
            // max-height. Measure decoration only, leaving list content uncapped.
            const decoration = [St.Side.TOP, St.Side.BOTTOM].reduce(
                (sum, side) =>
                    sum + scrollNode.get_padding(side) + scrollNode.get_border_width(side),
                0
            );
            const natural = Math.ceil(contentHeight + decoration) + margin;
            chrome -= reveal.get_preferred_height(reveal.width || width)[1];
            entries.push({
                scroll,
                progress,
                margin,
                natural,
                minimum: Math.min(natural, Size.MINIMUM_VIEWPORT + margin),
            });
        }
        return { chrome: Math.max(0, chrome), entries };
    }

    naturalHeight() {
        const { chrome, entries } = this._measure();
        return Math.ceil(
            chrome + entries.reduce((sum, entry) => sum + entry.natural * entry.progress, 0)
        );
    }

    minimumHeight() {
        const { chrome, entries } = this._measure();
        return Math.ceil(
            chrome + entries.reduce((sum, entry) => sum + entry.minimum * entry.progress, 0)
        );
    }

    fit(height) {
        const { chrome, entries } = this._measure();
        const heights = distribute(
            entries.map((entry) => entry.natural * entry.progress),
            entries.map((entry) => entry.minimum * entry.progress),
            Math.max(0, height - chrome)
        );
        entries.forEach((entry, index) => {
            // Reveal rounds the exposed height. Round its allowance down before
            // undoing progress so all four lists still fit their shared budget.
            const target = Math.max(
                0,
                Math.floor(Math.floor(heights[index]) / entry.progress - entry.margin)
            );
            if (this.heights.get(entry.scroll) === target) return;
            this.heights.set(entry.scroll, target);
            // Actor heights are already scaled pixels. CSS px would scale the
            // measured budget again on HiDPI displays, and retain old CSS caps.
            entry.scroll.height = target;
        });
    }

    destroy() {
        for (const scroll of this.heights.keys()) scroll.height = -1;
        this.heights.clear();
    }
};
