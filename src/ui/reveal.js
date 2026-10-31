const { Clutter, GObject, St } = imports.gi;
const MotionPreferences =
    imports.misc.extensionUtils.getCurrentExtension().imports.ui.motionPreferences;

// Keep the child at its natural size while revealing its allocation. Text and
// scroll adjustments must not be squeezed or rescaled during the transition.
var Reveal = GObject.registerClass(
    {
        GTypeName: 'PingooseReveal',
        Properties: {
            progress: GObject.ParamSpec.double(
                'progress',
                'progress',
                'Revealed fraction',
                GObject.ParamFlags.READWRITE,
                0,
                1,
                0
            ),
        },
    },
    class Reveal extends St.Widget {
        _init(child, horizontal = false) {
            super._init({
                visible: false,
                clip_to_allocation: true,
                x_expand: !horizontal,
                request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
            });
            this.childActor = child;
            this.horizontal = horizontal;
            this.expanded = false;
            this._progress = 0;
            this._generation = 0;
            this.add_child(child);
            child.show();
            this._preferences = new MotionPreferences.Controller(() => this.finish());
            this.connect('notify::mapped', () => {
                if (!this.mapped) this.finish(false);
            });
            this.connect('captured-event', () =>
                this.expanded ? Clutter.EVENT_PROPAGATE : Clutter.EVENT_STOP
            );
            this.connect('destroy', () => {
                this._generation++;
                this.remove_transition('progress');
                this._preferences.destroy();
            });
        }

        get progress() {
            return this._progress || 0;
        }
        set progress(value) {
            this._progress = value;
            this.queue_relayout();
            this.notify('progress');
        }

        setExpanded(expanded, animate = true) {
            expanded = !!expanded;
            if (expanded === this.expanded) {
                if (!animate) this.finish();
                return;
            }
            this.expanded = expanded;
            const generation = ++this._generation;
            this.remove_transition('progress');
            // A hidden parent means restoration, not a user-visible toggle.
            if (!animate || !this.get_parent()?.mapped || !this._preferences.enabled) {
                this.finish();
                return;
            }
            this.show();
            this.ease_property('progress', expanded ? 1 : 0, {
                duration: this._preferences.duration * Math.abs((expanded ? 1 : 0) - this.progress),
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => {
                    if (generation === this._generation) this.finish();
                },
            });
        }

        finish(syncVisibility = true) {
            this._generation++;
            this.remove_transition('progress');
            this.progress = this.expanded ? 1 : 0;
            this.visible = this.expanded && (syncVisibility || this.visible);
        }

        // BoxPointer floors its stage position. Fractional requested sizes
        // otherwise move the right-anchored main panel by a pixel on each frame.
        vfunc_get_preferred_width(forHeight) {
            const sizes = this.childActor.get_preferred_width(forHeight);
            return this.horizontal ? sizes.map((size) => Math.round(size * this.progress)) : sizes;
        }

        vfunc_get_preferred_height(forWidth) {
            const width = this.horizontal ? this.childActor.get_preferred_width(-1)[1] : forWidth;
            const sizes = this.childActor.get_preferred_height(width);
            return this.horizontal ? sizes : sizes.map((size) => Math.round(size * this.progress));
        }

        vfunc_allocate(box) {
            this.set_allocation(box);
            const width = box.get_width();
            const height = box.get_height();
            const fullWidth = this.horizontal ? this.childActor.get_preferred_width(-1)[1] : width;
            const fullHeight =
                this.horizontal || this.progress === 1
                    ? height
                    : this.childActor.get_preferred_height(width)[1];
            const childBox = new Clutter.ActorBox();
            // The entire side card moves with the reveal's left edge. Its
            // remaining width is clipped behind the main panel, not wiped in place.
            childBox.x1 = 0;
            childBox.x2 = childBox.x1 + fullWidth;
            childBox.y1 = 0;
            childBox.y2 = fullHeight;
            this.childActor.allocate(childBox);
        }
    }
);
