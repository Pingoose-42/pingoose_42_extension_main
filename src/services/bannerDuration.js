const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;

// GNOME 42 exposes no per-notification banner timeout. Scope these hooks to
// marked Pingoose notifications; queued notifications retain their real urgency.
var Controller = class Controller {
    constructor(settings, tray = Main.messageTray) {
        this._tray = tray;
        this._hooks = [];
        const duration = () => settings.get_int('notification-duration');
        this._wrap(
            '_showNotificationCompleted',
            (original) =>
                function (...args) {
                    const result = original.apply(this, args);
                    if (this._notification?.pingooseBanner)
                        this._updateNotificationTimeout(duration() * 1000);
                    return result;
                }
        );
        this._wrap(
            '_updateState',
            (original) =>
                function (...args) {
                    const notice = this._notification;
                    if (!notice?.pingooseBanner || duration() !== 0)
                        return original.apply(this, args);
                    // Suppress automatic expiry only. X, Escape, activation, removal and
                    // session changes still follow the Shell's normal dismissal logic.
                    const urgency = notice.urgency;
                    notice.urgency = MessageTray.Urgency.CRITICAL;
                    try {
                        return original.apply(this, args);
                    } finally {
                        notice.urgency = urgency;
                    }
                }
        );
        this._settings = settings;
        this._changed = settings.connect('changed::notification-duration', () => {
            if (tray._notification?.pingooseBanner)
                tray._updateNotificationTimeout(duration() * 1000);
        });
    }

    _wrap(name, factory) {
        const original = this._tray[name];
        const replacement = factory(original);
        this._tray[name] = replacement;
        this._hooks.push({ name, original, replacement });
    }

    destroy() {
        this._settings.disconnect(this._changed);
        for (const { name, original, replacement } of this._hooks.reverse()) {
            if (this._tray[name] === replacement) this._tray[name] = original;
        }
        if (this._tray._notification?.pingooseBanner) this._tray._updateNotificationTimeout(4000);
        this._hooks = [];
    }
};
