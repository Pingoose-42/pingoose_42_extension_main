const { GObject, St } = imports.gi;

// GNOME 42's scrollable StViewport can report only its content size as the
// paint volume, excluding padding that still contains visible controls. Keep
// its native origin/scroll correction and include this panel's allocation.
var Panel = GObject.registerClass(
    { GTypeName: 'PingoosePanelContent' },
    class Panel extends St.BoxLayout {
        vfunc_get_paint_volume(volume) {
            if (!super.vfunc_get_paint_volume(volume)) return false;
            volume.set_width(Math.max(volume.get_width(), this.width));
            volume.set_height(Math.max(volume.get_height(), this.height));
            return true;
        }
    }
);
