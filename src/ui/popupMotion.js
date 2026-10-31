const { Clutter } = imports.gi;
const { PopupAnimation } = imports.ui.boxpointer;
const { adjustAnimationTime } = imports.ui.environment;
const MotionPreferences =
    imports.misc.extensionUtils.getCurrentExtension().imports.ui.motionPreferences;

// Leave popup grabs, focus, input muting and menu-closed signals with Shell.
// Only translate the transparent host's columns; never stretch its contents.
var Controller = class Controller {
    constructor(menu, columns, fromBottom) {
        this.menu = menu;
        this.columns = columns;
        this.open = menu.open;
        this.close = menu.close;
        const reset = () => {
            columns.remove_transition('translation-y');
            columns.translation_y = 0;
        };
        this.closedSignal = menu.connect('menu-closed', reset);
        this.preferences = new MotionPreferences.Controller(() => {
            reset();
            // Finish Shell's fade too; its completion owns input and visibility.
            if (menu.isOpen) menu._boxPointer.open(PopupAnimation.NONE);
            else this.close.call(menu, PopupAnimation.NONE);
        });
        const retime = () => {
            const fade = menu.actor.get_transition('opacity');
            if (fade) fade.set_duration(adjustAnimationTime(this.preferences.duration));
        };
        const animate = (value) => value !== PopupAnimation.NONE && this.preferences.enabled;
        menu.open = (animation) => {
            if (menu.isOpen) return;
            const enabled = animate(animation);
            if (!menu.actor.visible) columns.translation_y = fromBottom() ? 12 : -12;
            columns.remove_transition('translation-y');
            this.open.call(menu, enabled ? PopupAnimation.FADE : PopupAnimation.NONE);
            if (enabled)
                columns.ease({
                    translation_y: 0,
                    duration: this.preferences.duration,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            else reset();
            if (enabled) retime();
        };
        menu.close = (animation) => {
            const enabled = menu.isOpen && animate(animation);
            columns.remove_transition('translation-y');
            if (enabled)
                columns.ease({
                    translation_y: fromBottom() ? 12 : -12,
                    duration: this.preferences.duration,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            else reset();
            this.close.call(menu, enabled ? PopupAnimation.FADE : PopupAnimation.NONE);
            if (enabled) retime();
        };
    }

    destroy() {
        this.menu.disconnect(this.closedSignal);
        this.preferences.destroy();
        this.columns.remove_transition('translation-y');
        this.columns.translation_y = 0;
        this.menu.open = this.open;
        this.menu.close = this.close;
        this.close.call(this.menu, PopupAnimation.NONE);
    }
};
