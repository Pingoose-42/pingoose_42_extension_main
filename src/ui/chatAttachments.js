// Decode files outside Shell; only bounded raw thumbnails become Clutter content.
const { Clutter, Cogl, Gio, GLib, Pango, St } = imports.gi;
const { PopupAnimation } = imports.ui.boxpointer;
const Main = imports.ui.main;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Helper = Me.imports.services.chatImageHelper;
const Image = Me.imports.models.chatImage;

function sizeLabel(size) {
    if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    if (size >= 1024) return `${Math.ceil(size / 1024)} KB`;
    return `${size} B`;
}

function wrapped(text, style_class) {
    const label = new St.Label({ text, style_class });
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

var Controller = class Controller {
    constructor({ menu, getTarget, onPreviewReady, appearance = null }) {
        this.menu = menu;
        this.getTarget = getTarget;
        this.onPreviewReady = onPreviewReady;
        this.appearance = appearance;
        this.pending = null;
        this._closingForChooser = null;
        this._destroyed = false;
        this._visible = false;
        this._records = new Set();
        this._queue = [];
        this._running = 0;
        this.clearCache();
        this.icon = new St.Icon({ icon_name: 'image-x-generic-symbolic', icon_size: 16 });
        this.button = new St.Button({
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: `Send image (up to ${Image.MAX_BYTES / (1024 * 1024)} MB)`,
            style_class: 'pingoose-chat-add pingoose-chat-attach',
            child: this.icon,
        });
        this.feedback = wrapped('', 'pingoose-chat-system pingoose-chat-image-feedback');
        this.feedback.visible = false;
        this._buttonSignal = this.button.connect('clicked', () => {
            if (this.pending) this.cancel('Image selection cancelled.');
            else this.choose();
        });
        this.refresh();
    }

    // The close intent survives delayed menu-closed emissions. Opening the menu
    // again ends that exception, so a subsequent user close cancels the chooser.
    get suspendingMenu() {
        return !!this.pending && this._closingForChooser === this.pending;
    }

    onMenuState(open) {
        if (open) this._closingForChooser = null;
        else if (!this.suspendingMenu) this.cancel('Image selection cancelled.');
    }

    _report(text, error = false) {
        if (this._destroyed) return;
        this.feedback.text = text;
        this.feedback.visible = !!text;
        this.feedback.style_class =
            'pingoose-chat-image-feedback ' +
            (error ? 'pingoose-chat-connect-error' : 'pingoose-chat-system');
        // The native chooser leaves our menu closed. Surface its failure without
        // reopening Shell or including file paths/raw data in a notification.
        if (error && !this.menu.isOpen) Main.notify('Pingoose', text);
    }

    _sameTarget(request) {
        const current = this.getTarget();
        return (
            current.available &&
            current.service === request.service &&
            current.key === request.key &&
            current.peer === request.peer &&
            current.peer?.scope === request.scope &&
            current.peer?.login === request.login
        );
    }

    _status(target) {
        return target.available && target.peer
            ? target.service.imageSendStatus(target.key)
            : 'unavailable';
    }

    _failure(status) {
        if (status === 'unsupported')
            return 'This peer does not support images. Update both extensions to send images.';
        if (status === 'busy') return 'An image is already waiting to send. Try again shortly.';
        return 'This chat is unavailable. Reconnect before sending an image.';
    }

    refresh() {
        if (this._destroyed) return;
        if (this.pending && !this.pending.cancelled && !this.pending.sending) {
            if (!this._sameTarget(this.pending))
                this.cancel('The chat changed. The image was not sent.', true);
            else if (this._status(this.pending) !== 'ready')
                this.cancel(this._failure(this._status(this.pending)), true);
        }
        const busy = !!this.pending;
        const target = this.getTarget();
        this.button.reactive = busy || !!(target.available && target.peer);
        this.button.can_focus = this.button.reactive;
        this.icon.icon_name = busy ? 'process-stop-symbolic' : 'image-x-generic-symbolic';
        this.button.accessible_name = busy
            ? 'Cancel image selection'
            : `Send image (up to ${Image.MAX_BYTES / (1024 * 1024)} MB)`;
    }

    async choose() {
        if (this._destroyed || this.pending) return;
        const target = this.getTarget();
        const status = this._status(target);
        if (status !== 'ready') {
            this._report(this._failure(status), true);
            return;
        }
        const request = {
            ...target,
            scope: target.peer.scope,
            login: target.peer.login,
            cancellable: new Gio.Cancellable(),
            cancelled: false,
        };
        this.pending = this._closingForChooser = request;
        const timestamp = global.get_current_time();
        this._report(
            `Choosing an image for ${request.login || request.key} (up to ${Image.MAX_BYTES / (1024 * 1024)} MB)…`
        );
        this.refresh();
        try {
            // Release Shell's modal grab before showing a native Gtk chooser.
            // Do not reopen the menu or move focus when that chooser finishes.
            this.menu.close(PopupAnimation.NONE);
            const result = await Helper.choose(timestamp, request.cancellable);
            if (this._destroyed || request.cancelled || this.pending !== request) return;
            if (!result) {
                this._report('Image selection cancelled.');
                return;
            }
            if (!this._sameTarget(request)) {
                this._report('The chat changed. The image was not sent.', true);
                return;
            }
            const currentStatus = this._status(request);
            if (currentStatus !== 'ready') {
                this._report(this._failure(currentStatus), true);
                return;
            }
            // sendImage emits its history entry synchronously. Reuse the preview
            // that the chooser already decoded, even if validation copies metadata.
            this._primed = result;
            request.sending = true;
            const sent = request.service.sendImage(request.key, result.image);
            this._report(
                sent
                    ? `Image queued for ${request.login || request.key}.`
                    : 'The image could not be queued. Check the connection and try again.',
                !sent
            );
        } catch (error) {
            if (!this._destroyed && !request.cancelled && this.pending === request)
                this._report(Helper.failure(error?.code).message, error?.code !== 'cancelled');
        } finally {
            this._primed = null;
            if (this.pending === request) {
                this.pending = null;
                this._closingForChooser = null;
            }
            this.refresh();
        }
    }

    cancel(message = '', error = false) {
        if (!this.pending || this.pending.cancelled) return;
        this.pending.cancelled = true;
        this.pending.cancellable.cancel();
        this._report(message, error);
        // Keep the request until its child exits, preventing concurrent choosers.
    }

    clearCache() {
        this._cache = new WeakMap();
        this._cacheCount = 0;
    }

    _remember(image, preview) {
        if (this._cacheCount >= 32) this.clearCache();
        if (!this._cache.has(image)) this._cacheCount++;
        this._cache.set(image, preview);
    }

    preview(entry) {
        const box = new St.BoxLayout({ vertical: true, style_class: 'pingoose-chat-image' });
        // Reserve the same space while loading, after failure and after eviction.
        const frame = new St.Bin({
            width: Image.PREVIEW_WIDTH,
            height: Image.PREVIEW_HEIGHT,
            clip_to_allocation: true,
            style_class: 'pingoose-chat-image-preview',
        });
        const record = { entry, frame, ready: false, disposed: false, job: null, queued: false };
        this.appearance?.track(frame, 'preview');
        this._records.add(record);
        frame.connect('destroy', () => {
            record.disposed = true;
            record.job?.cancellable.cancel();
            this._records.delete(record);
            this._queue = this._queue.filter((queued) => queued !== record);
        });
        this._placeholder(
            record,
            entry.image ? 'Loading image…' : 'Image no longer kept in memory'
        );
        box.add_child(frame);
        const caption = new St.Label({
            text: entry.image?.name || entry.text.replace(/^\[Image[^\]]*\]\s*/, ''),
            style_class: 'pingoose-chat-image-caption',
        });
        caption.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(caption);
        if (entry.image)
            box.add_child(
                new St.Label({
                    text: sizeLabel(entry.image.size),
                    style_class: 'pingoose-chat-time',
                })
            );
        if (!entry.image) record.ready = true;
        else {
            if (
                this._primed?.image.data === entry.image.data &&
                this._primed.image.mime === entry.image.mime
            )
                this._remember(entry.image, this._primed.preview);
            const cached = this._cache.get(entry.image);
            if (cached) this._display(record, cached);
            else this._enqueue(record);
        }
        return box;
    }

    _placeholder(record, text) {
        record.frame.get_child()?.destroy();
        record.frame.set_child(wrapped(text, 'pingoose-chat-image-placeholder'));
    }

    _display(record, preview) {
        if (record.disposed || this._destroyed) return;
        try {
            // Validate again at the C boundary before handing any bytes to Cogl.
            const value = Helper.validatePreview(preview);
            if (!value) throw new Error('Invalid preview');
            const pixels = GLib.base64_decode(value.data);
            const content = new Clutter.Image();
            content.set_data(
                pixels,
                value.alpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                value.width,
                value.height,
                value.rowstride
            );
            const actor = new St.Widget({
                content,
                width: value.width,
                height: value.height,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            record.frame.get_child()?.destroy();
            record.frame.set_child(actor);
            this._remember(record.entry.image, value);
        } catch (_) {
            this._placeholder(record, 'Image preview unavailable');
        }
        record.ready = true;
        this.onPreviewReady?.();
    }

    _enqueue(record) {
        if (this._destroyed || record.ready || record.disposed || record.job || record.queued)
            return;
        record.queued = true;
        this._queue.push(record);
        this._drain();
    }

    _drain() {
        while (!this._destroyed && this._visible && this._running < 2 && this._queue.length) {
            const record = this._queue.shift();
            record.queued = false;
            if (record.disposed || record.ready || !record.entry.image) continue;
            const job = { cancellable: new Gio.Cancellable() };
            record.job = job;
            this._running++;
            Helper.preview(record.entry.image, job.cancellable)
                .then((preview) => {
                    if (!job.cancellable.is_cancelled() && !record.disposed && record.entry.image)
                        this._display(record, preview);
                })
                .catch(() => {
                    if (!this._destroyed && !record.disposed && !job.cancellable.is_cancelled()) {
                        record.ready = true;
                        this._placeholder(record, 'Image preview unavailable');
                        this.onPreviewReady?.();
                    }
                })
                .finally(() => {
                    record.job = null;
                    this._running--;
                    if (!this._destroyed && !record.disposed && !record.ready)
                        this._enqueue(record);
                    this._drain();
                });
        }
    }

    setVisible(visible) {
        if (this._destroyed) return;
        this._visible = !!visible;
        if (!visible) {
            for (const record of this._records) record.job?.cancellable.cancel();
        } else this._drain();
    }

    prune() {
        this.clearCache();
        for (const record of this._records) {
            if (record.entry.image) continue;
            record.job?.cancellable.cancel();
            record.ready = true;
            this._placeholder(record, 'Image no longer kept in memory');
        }
    }

    reset() {
        this.cancel();
        this.setVisible(false);
        this.clearCache();
        this._report('');
    }

    destroy() {
        if (this._destroyed) return;
        this.cancel();
        this._destroyed = true;
        this.button.disconnect(this._buttonSignal);
        for (const record of this._records) record.job?.cancellable.cancel();
        this._records.clear();
        this._queue = [];
        this.clearCache();
    }
};
