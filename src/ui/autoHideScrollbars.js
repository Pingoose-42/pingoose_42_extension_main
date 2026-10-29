const { Clutter, GLib, St } = imports.gi;

// Change only scrollbar visibility, retaining its allocation to avoid layout jumps.
var Controller = class Controller {
    constructor(root, settings) {
        this.settings = settings;
        this.actors = new Map();
        this.bars = new Map();
        this.settingSignal = settings.connect('changed::auto-hide-scrollbars', () => {
            for (const state of this.bars.values()) this.apply(state);
        });
        this.watch(root);
    }
    watch(actor) {
        if (this.actors.has(actor)) return;
        const signals = [];
        this.actors.set(actor, signals);
        signals.push(actor.connect('actor-added', (_parent, child) => this.watch(child)));
        signals.push(
            actor.connect('destroy', () => {
                const states = this.bars.get(actor);
                if (states) this.release(states);
                this.actors.delete(actor);
            })
        );
        if (actor instanceof St.ScrollView) {
            const state = { scroll: actor, timer: 0, dragging: false, signals: [], bars: [] };
            this.bars.set(actor, state);
            for (const bar of [actor.get_hscroll_bar(), actor.get_vscroll_bar()]) {
                if (!bar) continue;
                state.bars.push({ bar, opacity: bar.opacity, reactive: bar.reactive });
                state.signals.push([
                    bar,
                    bar.connect('scroll-start', () => {
                        state.dragging = true;
                        this.activity(state);
                    }),
                ]);
                state.signals.push([
                    bar,
                    bar.connect('scroll-stop', () => {
                        state.dragging = false;
                        this.activity(state);
                    }),
                ]);
            }
            signals.push(
                actor.connect('scroll-event', () => {
                    this.activity(state);
                    return Clutter.EVENT_PROPAGATE;
                })
            );
            this.apply(state);
        }
        for (const child of actor.get_children()) this.watch(child);
    }
    stop(state) {
        if (state.timer) GLib.source_remove(state.timer);
        state.timer = 0;
    }
    visible(state, visible) {
        for (const { bar, opacity, reactive } of state.bars) {
            bar.opacity = visible ? opacity : 0;
            bar.reactive = visible ? reactive : false;
        }
    }
    apply(state) {
        this.stop(state);
        this.visible(state, !this.settings.get_boolean('auto-hide-scrollbars') || state.dragging);
    }
    activity(state) {
        this.stop(state);
        this.visible(state, true);
        if (!this.settings.get_boolean('auto-hide-scrollbars') || state.dragging) return;
        state.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
            state.timer = 0;
            this.visible(state, false);
            return GLib.SOURCE_REMOVE;
        });
    }
    release(state) {
        this.stop(state);
        for (const [object, signal] of state.signals) object.disconnect(signal);
        this.bars.delete(state.scroll);
    }
    destroy() {
        this.settings.disconnect(this.settingSignal);
        for (const state of [...this.bars.values()]) {
            this.visible(state, true);
            this.release(state);
        }
        for (const [actor, signals] of this.actors)
            for (const signal of signals) actor.disconnect(signal);
        this.actors.clear();
    }
};
