const { Clutter, Meta } = imports.gi;
const Size = imports.misc.extensionUtils.getCurrentExtension().imports.models.panelSize;

// Resizing owns only its temporary pointer grab. Shell continues to own popup
// focus, modality, opening/closing and Escape when no resize is in progress.
var Controller = class Controller {
    constructor(actor, viewport, settings, key, options) {
        this.actor = actor;
        this.viewport = viewport;
        this.settings = settings;
        this.key = key;
        this.options = options;
        this.signals = [];
        this.preview = null;
        this.drag = null;
        this.pending = 0;
        this.cursor = false;
        this.destroyed = false;
        this._connect(actor, 'captured-event', (_actor, event) => this.capture(event));
        // Clutter 42 delivers grabbed pointer events here, not in capture phase.
        this._connect(actor, 'event', (_actor, event) => this.dragEvent(event));
        this._connect(actor, 'queue-relayout', () => this.refresh());
        this._connect(actor, 'notify::mapped', () => {
            if (!actor.mapped) this.cancel();
            else this.refresh();
        });
        this._connect(actor, 'destroy', () => this.destroy(false));
        this._connect(settings, `changed::${key}`, () => {
            this.cancel();
            this.refresh();
        });
        this._connect(options.menu, 'open-state-changed', (_menu, open) => {
            if (!open) this.cancel();
            else this.refresh();
        });
        this.refresh();
    }

    _connect(object, name, callback) {
        this.signals.push([object, object.connect(name, callback)]);
    }

    get automatic() {
        return this.preview === null && this.settings.get_int(this.key) === 0;
    }

    get naturalContent() {
        return this.automatic || !!this.viewport.overflow;
    }

    refresh() {
        if (this.destroyed || this.applying) return;
        if (this.automatic) {
            this.applying = true;
            this.viewport.restore();
            this.applying = false;
            return;
        }
        if (this.pending || !this.actor.mapped) return;
        this.pending = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
            this.pending = 0;
            this.apply();
            return false;
        });
    }

    apply() {
        if (this.destroyed || !this.actor.mapped || this.actor.width <= 0) return;
        const height = this.preview ?? this.settings.get_int(this.key);
        if (!height) return;
        const bounds = this.options.bounds(this.actor);
        this.applying = true;
        this.viewport.apply(Size.clamp(height, this.viewport.minimumHeight(), bounds.maximum));
        this.applying = false;
    }

    edge(event) {
        if (!this.options.menu.isOpen || !this.actor.mapped || !this.options.ready()) return false;
        const [x, y] = event.get_coords();
        const [ok, localX, localY] = this.actor.transform_stage_point(x, y);
        return (
            ok &&
            Size.isResizeEdge(
                localX,
                localY,
                this.actor.width,
                this.actor.height,
                this.options.bounds(this.actor).bottom
            )
        );
    }

    setCursor(active) {
        if (this.cursor === active) return;
        this.cursor = active;
        global.display.set_cursor(
            active
                ? this.options.bounds(this.actor).bottom
                    ? Meta.Cursor.NORTH_RESIZE
                    : Meta.Cursor.SOUTH_RESIZE
                : Meta.Cursor.DEFAULT
        );
    }

    capture(event) {
        if (this.destroyed) return Clutter.EVENT_PROPAGATE;
        // Grabs can still target descendants. Intercept before their buttons or
        // entries consume a release; the event handler covers direct delivery.
        if (this.drag) return this.dragEvent(event);
        const type = event.type();
        if (type === Clutter.EventType.LEAVE) {
            this.setCursor(false);
        } else if ([Clutter.EventType.MOTION, Clutter.EventType.ENTER].includes(type)) {
            this.setCursor(this.edge(event));
        } else if (
            type === Clutter.EventType.BUTTON_PRESS &&
            event.get_button() === 1 &&
            this.edge(event)
        ) {
            const [, y] = event.get_coords();
            const bounds = this.options.bounds(this.actor);
            const grab = global.stage.grab(this.actor);
            if (!grab) return Clutter.EVENT_PROPAGATE;
            this.drag = {
                grab,
                y,
                height: this.actor.height,
                initial: this.settings.get_int(this.key),
                bounds: { ...bounds },
                changed: false,
                cancelled: false,
            };
            this.preview = this.actor.height;
            this.setCursor(true);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    dragEvent(event) {
        if (!this.drag) return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type === Clutter.EventType.LEAVE && global.stage.get_grab_actor() !== this.actor) {
            this.cancel();
            return Clutter.EVENT_PROPAGATE;
        }
        if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
            // Keep the grab until button-up so the cancelled drag cannot click
            // a menu item underneath the pointer on its eventual release.
            this.drag.cancelled = true;
            this.preview = null;
            this.setCursor(false);
            this.refresh();
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE && event.get_button() === 1) {
            this.finish(!this.drag.cancelled);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.MOTION) {
            if (!(event.get_state() & Clutter.ModifierType.BUTTON1_MASK)) {
                this.finish(false);
                return Clutter.EVENT_STOP;
            }
            if (!this.drag.cancelled) {
                const bounds = this.options.bounds(this.actor);
                if (
                    bounds.bottom !== this.drag.bounds.bottom ||
                    Math.abs(bounds.scale - this.drag.bounds.scale) > 0.001
                ) {
                    this.cancel();
                    return Clutter.EVENT_STOP;
                }
                const [, y] = event.get_coords();
                this.preview = Size.dragHeight(
                    this.drag.height,
                    this.drag.y,
                    y,
                    bounds.scale,
                    bounds.bottom,
                    this.viewport.minimumHeight(),
                    bounds.maximum
                );
                this.drag.changed = Math.abs(this.preview - this.drag.height) >= 1;
                this.refresh();
            }
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_STOP;
    }

    finish(commit) {
        const drag = this.drag;
        if (!drag) return;
        const value = this.preview;
        this.drag = null;
        this.preview = null;
        drag.grab.dismiss();
        this.setCursor(false);
        if (commit && drag.changed && value !== drag.initial)
            this.settings.set_int(this.key, value);
        this.refresh();
    }

    cancel() {
        this.finish(false);
        this.setCursor(false);
    }

    destroy(restore = true) {
        if (this.destroyed) return;
        this.destroyed = true;
        this.cancel();
        if (this.pending) Meta.later_remove(this.pending);
        this.pending = 0;
        for (const [object, signal] of this.signals) object.disconnect(signal);
        this.signals = [];
        // Owners can already have stopped their timers by this point.
        if (restore) this.viewport.restore(false);
    }
};
