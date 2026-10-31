const { Clutter } = imports.gi;
const Main = imports.ui.main;

function candidatePopup() {
    // IBus is optional; loading its module can fail before a manager exists.
    try {
        return imports.misc.ibusManager.getIBusManager()?._candidatePopup || null;
    } catch (_) {
        return null;
    }
}

var Controller = class Controller {
    constructor(menu) {
        this._menu = menu;
        this._forwarding = false;
        this._openSignal = menu.connect('open-state-changed', (_menu, open) => {
            if (open) this._placeMenu();
        });
        // Layout is constructed before addToStatusArea registers PopupMenuManager.
        this._captureSignal = menu.actor.connect('captured-event', (_actor, event) =>
            this._capture(event)
        );
        if (menu.isOpen) this._placeMenu();
    }

    _placeMenu() {
        const actor = this._menu.actor;
        const parent = actor.get_parent();
        if (!parent) return;
        // PopupMenu.open raises itself each time. Follow GNOME 42 addChrome's
        // layer: above ordinary windows, below native popup windows and IME UI.
        for (const anchor of [global.top_window_group, Main.layoutManager.keyboardBox]) {
            if (anchor && anchor !== actor && anchor.get_parent() === parent) {
                parent.set_child_below_sibling(actor, anchor);
                return;
            }
        }
    }

    _capture(event) {
        if (this._destroyed || this._forwarding || !this._menu.isOpen)
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (
            type !== Clutter.EventType.BUTTON_PRESS &&
            type !== Clutter.EventType.BUTTON_RELEASE &&
            type !== Clutter.EventType.SCROLL
        )
            return Clutter.EVENT_PROPAGATE;

        const actor = this._menu.actor;
        // A resize, candidate pager button, or another modal owns its own grab.
        // Leave those events, all keyboard input, and native GTK popups to Shell.
        if (global.stage.get_grab_actor() !== actor) return Clutter.EVENT_PROPAGATE;
        const focus = global.stage.get_key_focus();
        if (!(focus instanceof Clutter.Text) || !focus.get_editable() || !actor.contains(focus))
            return Clutter.EVENT_PROPAGATE;
        const popup = candidatePopup();
        const target = global.stage.get_event_actor(event);
        if (
            !popup?.visible ||
            !popup.mapped ||
            !target ||
            actor.contains(target) ||
            !popup.contains(target)
        )
            return Clutter.EVENT_PROPAGATE;

        // With a menu grab, Mutter delivers outside events only to the menu.
        // Reproduce its reactive-ancestor capture/bubble path within the candidate
        // popup, so labels reach their item and scrolling reaches CandidateArea.
        const path = [];
        for (let current = target; current; current = current.get_parent()) {
            if (current.reactive) path.push(current);
            if (current === popup) break;
        }
        this._forwarding = true;
        try {
            for (let i = path.length - 1; i >= 0; i--)
                if (path[i].event(event, true)) return Clutter.EVENT_STOP;
            for (const current of path) if (current.event(event, false)) return Clutter.EVENT_STOP;
        } finally {
            this._forwarding = false;
        }
        // Candidate boxes act on release, so even an unhandled press must not
        // reach PopupMenuManager's outside-click handler and close the editor.
        return Clutter.EVENT_STOP;
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._menu.disconnect(this._openSignal);
        this._menu.actor.disconnect(this._captureSignal);
    }
};
