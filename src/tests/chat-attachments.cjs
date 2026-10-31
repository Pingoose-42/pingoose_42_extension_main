const assert = require('node:assert/strict');
const { Actor, Signals, moduleExport } = require('./helpers.cjs');
const Image = require('../models/chatImage.js');

class Widget extends Actor {
    get_child() {
        return this.children[0] || null;
    }
    set_child(child) {
        for (const previous of this.get_children()) previous.destroy();
        this.add_child(child);
    }
    destroy() {
        if (this.destroyed) return;
        this.emit('destroy');
        super.destroy();
    }
}
class Cancellable {
    cancel() {
        this.cancelled = true;
    }
    is_cancelled() {
        return !!this.cancelled;
    }
}
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};
const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
};
const raw = (width = 32, height = 20, alpha = true) => ({
    width,
    height,
    alpha,
    rowstride: width * (alpha ? 4 : 3),
    data: Buffer.alloc(width * height * (alpha ? 4 : 3), 255).toString('base64'),
});
const image = (name = 'photo.png') => ({ mime: 'image/png', data: 'iVBORw0KGgo=', size: 8, name });
const entry = (name) => ({
    kind: 'image',
    image: image(name),
    text: `[Image] ${name}`,
    dir: 'in',
    time: '10:00',
});
const GLib = {
    base64_decode: (text) => new Uint8Array(Buffer.from(text, 'base64')),
    base64_encode: (bytes) => Buffer.from(bytes).toString('base64'),
};
const { validatePreview, failure } = moduleExport(
    'services/chatImageHelper.js',
    '({ validatePreview, failure })',
    {
        imports: {
            gi: { GLib },
            misc: {
                extensionUtils: {
                    getCurrentExtension: () => ({ imports: { models: { chatImage: Image } } }),
                },
            },
        },
    }
);

function fixture({ autoClose = true } = {}) {
    const chooser = [],
        previews = [],
        uploads = [],
        actions = [],
        sends = [],
        notifications = [];
    const helper = {
        validatePreview,
        failure,
        choose(timestamp, cancellable) {
            actions.push('chooser');
            assert.equal(menu.isOpen, false, 'Shell menu must release its grab first');
            const call = { ...deferred(), timestamp, cancellable };
            chooser.push(call);
            return call.promise;
        },
        preview(payload, cancellable) {
            const call = { ...deferred(), payload, cancellable };
            previews.push(call);
            return call.promise;
        },
    };
    const service = {
        status: 'ready',
        imageSendStatus() {
            return this.status;
        },
        sendImage(key, payload) {
            sends.push({ key, payload });
            this.onSend?.(payload);
            this.status = 'busy';
            controller.refresh();
            return this.sendResult !== false;
        },
    };
    let target = {
        service,
        key: 'c1r1s1',
        peer: { scope: 'general', login: 'peer' },
        available: true,
    };
    const menu = new Signals();
    menu.isOpen = true;
    menu.close = (animation) => {
        actions.push('close');
        assert.equal(animation, 0);
        menu.isOpen = false;
        controller.onMenuState(false);
        if (autoClose) panel.close();
    };
    menu.open = () => {
        actions.push('open');
        menu.isOpen = true;
        controller.onMenuState(true);
    };
    const Me = {
        imports: {
            models: { chatImage: Image, featureFlags: {}, chatPolicy: {} },
            services: { chatImageHelper: helper, chat: {} },
            ui: { countLabel: {} },
        },
    };
    const imports = {
        gi: {
            GLib,
            Gio: { Cancellable },
            Pango: { WrapMode: { WORD_CHAR: 1 }, EllipsizeMode: { NONE: 0, END: 1 } },
            St: {
                Icon: Widget,
                Button: Widget,
                Label: Widget,
                BoxLayout: Widget,
                Bin: Widget,
                Widget,
            },
            Cogl: { PixelFormat: { RGBA_8888: 4, RGB_888: 3 } },
            Clutter: {
                ActorAlign: { CENTER: 0 },
                Image: class {
                    set_data(...args) {
                        uploads.push(args);
                    }
                },
            },
        },
        ui: {
            boxpointer: { PopupAnimation: { NONE: 0 } },
            main: { notify: (...args) => notifications.push(args) },
        },
        misc: { extensionUtils: { getCurrentExtension: () => Me } },
    };
    const Controller = moduleExport('ui/chatAttachments.js', 'Controller', {
        imports,
        global: { get_current_time: () => 42 },
    });
    const Panel = moduleExport('ui/chatPanel.js', 'ChatPanel', { imports });
    const panel = Object.create(Panel.prototype);
    panel._expanded = true;
    panel._chatUi = {
        entry: { text: 'unsent draft' },
        stick: true,
        adjustment: { lower: 0, upper: 1000, page_size: 100, value: 600 },
    };
    const controller = new Controller({
        menu,
        getTarget: () => target,
        onPreviewReady: () => panel._followChatBottom(),
    });
    panel._attachments = controller;
    panel.sync = () => {
        controller.refresh();
        controller.setVisible(menu.isOpen && panel._expanded);
    };
    panel.sync();
    return {
        controller,
        panel,
        menu,
        service,
        chooser,
        previews,
        uploads,
        actions,
        sends,
        notifications,
        target: () => target,
        setTarget: (value) => {
            target = value;
        },
    };
}

(async () => {
    {
        const f = fixture();
        const done = f.controller.choose();
        assert.deepEqual(f.actions, ['close', 'chooser']);
        assert.equal(f.chooser[0].timestamp, 42);
        assert.match(f.controller.feedback.text, /10 MB/);
        assert.equal(f.controller.icon.icon_name, 'process-stop-symbolic');
        // settings.js can close panels immediately and again on delayed menu-closed.
        f.panel.close();
        assert.equal(f.chooser[0].cancellable.is_cancelled(), false);
        assert.equal(f.panel._chatUi.entry.text, 'unsent draft');
        await f.controller.choose();
        assert.equal(f.chooser.length, 1);
        f.chooser[0].resolve({ image: image(), preview: raw() });
        await done;
        assert.equal(f.sends.length, 1);
        assert.equal(f.sends[0].key, 'c1r1s1');
        assert.match(f.controller.feedback.text, /Image queued for peer/);
        assert.equal(f.notifications.length, 0);
        assert.equal(f.controller.pending, null);
        assert.equal(f.menu.isOpen, false, 'completion must not steal focus by reopening Shell');
        assert.equal(f.panel._chatUi.entry.text, 'unsent draft');
    }
    for (const autoClose of [true, false]) {
        const f = fixture({ autoClose });
        const done = f.controller.choose();
        f.menu.open();
        assert.equal(f.controller.suspendingMenu, false);
        f.menu.close(0);
        assert.equal(f.chooser[0].cancellable.is_cancelled(), true);
        f.chooser[0].resolve({ image: image(), preview: raw() });
        await done;
        assert.equal(f.sends.length, 0);
        assert.equal(f.notifications.length, 0, 'closing the menu is user cancellation');
    }
    for (const mutate of [
        (f) => f.setTarget({ ...f.target(), key: 'c1r1s2' }),
        (f) => f.setTarget({ ...f.target(), service: { imageSendStatus: () => 'ready' } }),
        (f) => f.setTarget({ ...f.target(), peer: { ...f.target().peer } }),
        (f) => {
            f.target().peer.scope = 'evaluation';
        },
        (f) => {
            f.target().peer.login = 'someone-else';
        },
        (f) => f.setTarget({ ...f.target(), available: false }),
        (f) => {
            f.service.status = 'unavailable';
        },
    ]) {
        const f = fixture();
        const done = f.controller.choose();
        mutate(f);
        f.controller.refresh();
        assert.equal(f.chooser[0].cancellable.is_cancelled(), true);
        f.chooser[0].resolve({ image: image(), preview: raw() });
        await done;
        assert.equal(f.sends.length, 0);
        f.controller.refresh();
        assert.equal(f.notifications.length, 1, 'a lost target/policy reports once while closed');
    }
    // A policy change is also checked at completion without relying on UI signals.
    {
        const f = fixture();
        const done = f.controller.choose();
        f.service.status = 'unsupported';
        f.chooser[0].resolve({ image: image(), preview: raw() });
        await done;
        assert.equal(f.sends.length, 0);
        assert.match(f.controller.feedback.text, /Update both extensions/);
        assert.equal(f.notifications.length, 1);
    }
    for (const status of ['unavailable', 'unsupported', 'busy']) {
        const f = fixture();
        f.service.status = status;
        await f.controller.choose();
        assert.equal(f.chooser.length, 0);
        assert.equal(f.controller.feedback.visible, true);
        assert.equal(f.notifications.length, 0, 'open menus keep errors inline');
    }
    {
        const f = fixture();
        f.setTarget({ ...f.target(), peer: null });
        f.controller.refresh();
        await f.controller.choose();
        assert.equal(f.controller.button.reactive, false);
        assert.equal(f.chooser.length, 0);
    }
    for (const mode of [
        'chooser-cancel',
        'button-cancel',
        'error',
        'destroy',
        'reset',
        'send-failed',
    ]) {
        const f = fixture();
        const done = f.controller.choose();
        if (mode === 'button-cancel') f.controller.button.emit('clicked');
        if (mode === 'destroy') f.controller.destroy();
        if (mode === 'reset') f.controller.reset();
        if (mode === 'send-failed') f.service.sendResult = false;
        if (mode === 'error') f.chooser[0].reject(failure('too-large'));
        else
            f.chooser[0].resolve(
                mode === 'chooser-cancel' ? null : { image: image(), preview: raw() }
            );
        await done;
        assert.equal(f.sends.length, mode === 'send-failed' ? 1 : 0);
        if (mode === 'error') assert.match(f.controller.feedback.text, /10 MB/);
        if (mode === 'send-failed') assert.match(f.controller.feedback.text, /could not be queued/);
        if (mode === 'chooser-cancel' || mode === 'button-cancel')
            assert.match(f.controller.feedback.text, /cancelled/);
        assert.equal(f.notifications.length, ['error', 'send-failed'].includes(mode) ? 1 : 0);
    }
    for (const open of [false, true]) {
        for (const code of [
            'too-large',
            'invalid-image',
            'read-failed',
            'timeout',
            'unknown',
            'cancelled',
        ]) {
            const f = fixture();
            const done = f.controller.choose();
            if (open) f.menu.open();
            // Even unexpected exceptions cannot leak an original path or payload.
            f.chooser[0].reject(
                Object.assign(new Error('/home/private/image.png: RAW_BASE64'), { code })
            );
            await done;
            assert.equal(f.notifications.length, !open && code !== 'cancelled' ? 1 : 0);
            assert.equal(f.controller.feedback.text, failure(code).message);
            assert.doesNotMatch(f.controller.feedback.text, /private|RAW_BASE64/);
            if (f.notifications.length)
                assert.deepEqual(f.notifications[0], ['Pingoose', failure(code).message]);
            assert.equal(f.actions.filter((action) => action === 'open').length, open ? 1 : 0);
        }
    }
    console.log(
        'PASS: chooser releases modal before launch, preserves drafts, survives delayed auto-close, never reopens; target/policy guards, cancellation and failures'
    );

    {
        const f = fixture();
        const one = f.controller.preview(entry('<b>plain filename</b>.png'));
        const two = f.controller.preview(entry('rgb.jpg'));
        const three = f.controller.preview(entry('last.png'));
        const frame = one.get_child();
        assert.equal(frame.width, 256);
        assert.equal(frame.height, 192);
        assert.match(frame.get_child().text, /Loading/);
        assert.equal(one.get_children()[1].text, '<b>plain filename</b>.png');
        assert.equal(f.previews.length, 2, 'decode concurrency must stay bounded');
        f.panel._chatUi.stick = false;
        f.previews[0].resolve(raw(32, 20));
        await flush();
        assert.equal(f.previews.length, 3);
        assert.equal(frame.get_child().width, 32, 'small images must not upscale');
        assert.equal(frame.get_child().height, 20);
        assert.equal(frame.width, 256);
        assert.equal(frame.height, 192);
        assert.equal(f.uploads[0][0].length, 32 * 20 * 4);
        assert.equal(f.uploads[0][1], 4);
        assert.equal(
            f.panel._chatUi.adjustment.value,
            600,
            'preview must not move a reader away from older messages'
        );
        f.panel._chatUi.stick = true;
        f.previews[1].resolve(raw(12, 8, false));
        await flush();
        assert.equal(f.uploads[1][1], 3);
        assert.equal(f.panel._chatUi.adjustment.value, 900);
        f.previews[2].reject(new Error('Invalid format'));
        await flush();
        assert.match(three.get_child().get_child().text, /unavailable/);
        assert.equal(three.get_child().height, 192);
        one.destroy();
        two.destroy();
        three.destroy();
        assert.equal(f.controller._records.size, 0);
    }
    for (const invalid of [
        { ...raw(), width: 257 },
        { ...raw(), rowstride: 1 },
        { ...raw(), data: 'AAAA' },
        { ...raw(), alpha: 'yes' },
    ]) {
        const f = fixture();
        const box = f.controller.preview(entry('broken.png'));
        f.previews[0].resolve(invalid);
        await flush();
        assert.equal(f.uploads.length, 0, 'invalid raw bytes cannot cross into Clutter/Cogl');
        assert.match(box.get_child().get_child().text, /unavailable/);
    }
    {
        const f = fixture();
        const first = f.controller.preview(entry('first.png'));
        const second = f.controller.preview(entry('second.png'));
        const third = f.controller.preview(entry('third.png'));
        f.controller.setVisible(false);
        assert(f.previews.every((job) => job.cancellable.is_cancelled()));
        // Ignore stale successful results after cancellation, then retry on reopen.
        f.previews[0].resolve(raw());
        f.previews[1].resolve(raw());
        await flush();
        assert.equal(f.uploads.length, 0);
        assert.equal(f.previews.length, 2);
        first.destroy();
        f.controller.setVisible(true);
        assert.equal(f.previews.length, 4);
        assert(f.previews.slice(2).every((job) => job.payload.name !== 'first.png'));
        second.destroy();
        third.destroy();
        assert(f.previews.slice(2).every((job) => job.cancellable.is_cancelled()));
        f.previews[2].resolve(raw());
        f.previews[3].resolve(raw());
        await flush();
        assert.equal(f.uploads.length, 0);
        assert.equal(f.controller._records.size, 0);
    }
    {
        const f = fixture();
        const kept = entry('evicted.png');
        const box = f.controller.preview(kept);
        kept.image = null;
        f.controller.prune();
        assert.equal(f.previews[0].cancellable.is_cancelled(), true);
        assert.match(box.get_child().get_child().text, /no longer kept/);
        f.previews[0].resolve(raw());
        await flush();
        assert.equal(f.uploads.length, 0);
        f.controller.preview({ ...kept });
        assert.equal(f.previews.length, 1);
    }
    {
        const f = fixture();
        let box;
        f.service.onSend = (payload) => {
            box = f.controller.preview({
                kind: 'image',
                image: { ...payload },
                text: '[Image] photo.png',
            });
        };
        const done = f.controller.choose();
        f.chooser[0].resolve({ image: image(), preview: raw(16, 10) });
        await done;
        assert.equal(f.previews.length, 0, 'reuse the chooser preview without decoding again');
        assert.equal(box.get_child().get_child().width, 16);
        assert.equal(f.uploads.length, 1);
    }
    {
        const f = fixture();
        const box = f.controller.preview(entry('late.png'));
        f.controller.destroy();
        assert.equal(f.previews[0].cancellable.is_cancelled(), true);
        f.previews[0].resolve(raw());
        await flush();
        assert.equal(f.uploads.length, 0);
        assert.equal(box.get_child().get_child().text, 'Loading image…');
    }
    console.log(
        'PASS: bounded raw thumbnail upload, fixed frames/no upscale, plain captions, reader scroll preservation, queue cancellation/retry, history eviction and chooser cache reuse'
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
