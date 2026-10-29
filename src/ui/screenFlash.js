const { Clutter, GLib, St } = imports.gi;
const Main = imports.ui.main;

var Controller = class Controller {
    constructor(indicator, settings, notificationSettings) {
        this._indicator = indicator;
        this._settings = settings;
        this._notificationSettings = notificationSettings;
        this._flashActors = [];
        this._flashTimer = 0;
        this._lastFlash = -Infinity;
        this.signal = settings.connect('changed::flash-count', () => this._clearFlash());
    }

    show() {
        this._flashScreen();
    }

    destroy() {
        this._settings.disconnect(this.signal);
        this._clearFlash();
        this._indicator = null;
    }

    previewFlash() {
        this._clearFlash();
        this._lastFlash = 0;
        this._flashScreen(null, true);
    }

    _flashScreen(remaining = null, preview = false) {
        if (
            !this._indicator ||
            this._flashActors.length ||
            this._flashTimer ||
            Main.sessionMode.isLocked ||
            !St.Settings.get().enable_animations ||
            (!preview && !(this._notificationSettings?.get_boolean('show-banners') ?? true))
        )
            return;
        const count = remaining === null ? this._settings?.get_int('flash-count') || 0 : remaining;
        const brightness = Math.max(
            10,
            this._settings ? this._settings.get_int('flash-brightness') : 100
        );
        const thickness = this._settings ? this._settings.get_int('flash-thickness') : 5;
        if (count === 0 || brightness === 0) return;
        // Preserve the original appearance at 100%; beyond full actor opacity,
        // increase the border alpha so higher settings still brighten the flash.
        const peakOpacity = Math.min(255, Math.round((160 * brightness) / 100));
        const borderAlpha = Math.min(1, 0.75 * Math.max(1, (160 * brightness) / 100 / 255));
        const intervalUs =
            (this._settings ? this._settings.get_double('flash-interval') : 1) * 1_000_000;
        const now = GLib.get_monotonic_time();
        if (now - this._lastFlash < intervalUs) return;
        this._lastFlash = now;
        this._flashActors = Main.layoutManager.monitors.map(
            (monitor) =>
                new St.Widget({
                    style_class: 'pingoose-flash',
                    style: `border-width: ${thickness}px; border-color: rgba(133, 214, 203, ${borderAlpha});`,
                    reactive: false,
                    can_focus: false,
                    visible: true,
                    opacity: 0,
                    x: monitor.x,
                    y: monitor.y,
                    width: monitor.width,
                    height: monitor.height,
                })
        );
        for (const frame of this._flashActors) {
            Main.uiGroup.add_child(frame);
            frame.ease({
                opacity: peakOpacity,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () =>
                    frame.ease({
                        opacity: 0,
                        duration: 380,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onComplete: () => {
                            this._flashActors = this._flashActors.filter(
                                (actor) => actor !== frame
                            );
                            frame.destroy();
                            if (!this._flashActors.length && count > 1) {
                                const delay = Math.max(
                                    1,
                                    Math.ceil(
                                        (intervalUs -
                                            (GLib.get_monotonic_time() - this._lastFlash)) /
                                            1000
                                    )
                                );
                                this._flashTimer = GLib.timeout_add(
                                    GLib.PRIORITY_DEFAULT,
                                    delay,
                                    () => {
                                        this._flashTimer = 0;
                                        this._flashScreen(count - 1, preview);
                                        return GLib.SOURCE_REMOVE;
                                    }
                                );
                            }
                        },
                    }),
            });
        }
    }

    clearFlash() {
        this._clearFlash();
    }

    _clearFlash() {
        if (this._flashTimer) {
            GLib.source_remove(this._flashTimer);
            this._flashTimer = 0;
        }
        const actors = this._flashActors || [];
        this._flashActors = [];
        for (const actor of actors) {
            actor.remove_all_transitions();
            actor.destroy();
        }
    }
};
