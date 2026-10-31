const assert = require('node:assert/strict');
const { moduleExport } = require('./helpers.cjs');

const normalOrder = [
    'session',
    'reset',
    'updater',
    'settingsMenu',
    'calendarPrompt',
    'calendar',
    'maintenance',
    'shortcut',
    'scrollbars',
    'bannerDuration',
    'projects',
    'services',
    'chat',
    'notifications',
    'agenda',
    'evaluations',
    'slots',
    'layout',
    'bridge',
    'indicator',
];

function fixture(options = {}) {
    const failure = new Error('enable fixture failure');
    const created = [],
        cleanup = [],
        errors = [],
        live = new Set(),
        timers = new Set(),
        listeners = new Set();
    let nextTimer = 0,
        subscribeCount = 0,
        hooked = false,
        running = false;
    const recordCleanup = (name) => {
        cleanup.push(name);
        if (options.throwCleanup?.includes(name)) throw new Error(`cleanup ${name}`);
    };
    const component = (name, setup = () => {}) =>
        class {
            constructor(...args) {
                if (options.failConstruct === name) throw failure;
                created.push(name);
                live.add(name);
                setup.call(this, ...args);
            }
            destroy() {
                live.delete(name);
                if (name === 'bridge') running = false;
                recordCleanup(name);
            }
        };
    const ui = {
        indicator: {
            Indicator: component('indicator', function () {
                this.menu = { actor: {}, close() {}, toggle() {} };
                this.loginOnly = false;
            }),
        },
        autoHideScrollbars: { Controller: component('scrollbars') },
        layout: { LayoutManager: component('layout') },
        chatPanel: { ChatPanel: component('chat') },
        servicePanel: { ServicePanel: component('services') },
        projectPanel: { ProjectPanel: component('projects') },
        slots: { SlotManager: component('slots') },
        evaluations: {
            EvaluationManager: component('evaluations', function () {
                this.renderEvaluations = () => {};
            }),
        },
        agenda: { AgendaManager: component('agenda') },
        notifications: {
            NotificationManager: component('notifications', function () {
                this.restoreCardState = () => {};
                this.renderCards = () => {};
            }),
        },
        visibility: { VisibilityManager: class {} },
        maintenance: { Controller: component('maintenance') },
        settings: { Controller: component('settingsMenu') },
    };
    const services = {
        workerBridge: {
            WorkerBridge: component('bridge', function () {
                this.on = (name) => {
                    if (++subscribeCount === options.failSubscribe) throw failure;
                    listeners.add(name);
                    return () => {
                        listeners.delete(name);
                        recordCleanup(`listener:${name}`);
                    };
                };
                this.start = () => (running = true);
            }),
        },
        bannerDuration: { Controller: component('bannerDuration') },
        calendarPrompt: { Controller: component('calendarPrompt') },
        agendaCalendar: { Controller: component('calendar') },
        startReminders: { Controller: class {} },
        updater: { Updater: component('updater') },
        reset: {
            Controller: component('reset', function () {
                this.request = () => {
                    if (options.failLate) throw failure;
                };
            }),
        },
        session: { Controller: component('session') },
        panelShortcut: { Binding: component('shortcut') },
        systemSessionHook: {
            SystemSessionHook: class {
                enable() {
                    hooked = true;
                    if (options.failHook) throw failure;
                }
                disable() {
                    hooked = false;
                    recordCleanup('hook');
                }
            },
        },
    };
    const init = moduleExport('extension.js', 'init', {
        imports: {
            gi: {
                Gio: { Settings: class {} },
                GLib: {
                    timeout_add_seconds() {
                        if (++nextTimer === options.failTimer) throw failure;
                        timers.add(nextTimer);
                        return nextTimer;
                    },
                    source_remove(id) {
                        timers.delete(id);
                        recordCleanup(`timer:${id}`);
                    },
                },
            },
            ui: {
                main: { panel: { addToStatusArea() {} } },
                popupMenu: { PopupMenuManager: class {} },
            },
            misc: {
                extensionUtils: {
                    getSettings: () => ({}),
                    getCurrentExtension: () => ({ imports: { ui, services } }),
                },
            },
        },
        logError(error) {
            errors.push(error);
            if (options.throwLogger) throw new Error('logger failure');
        },
    });
    return {
        extension: init(),
        failure,
        created,
        cleanup,
        errors,
        assertEmpty() {
            assert.equal(live.size, 0, 'every constructed component receives cleanup');
            assert.equal(timers.size, 0, 'every registered timer is removed');
            assert.equal(listeners.size, 0, 'every registered listener is removed');
            assert.equal(hooked, false, 'the system session hook is restored');
            assert.equal(running, false, 'the worker bridge is stopped');
            assert.equal(this.extension._components.length, 0);
            assert.equal(this.extension._timers.length, 0);
            assert.equal(this.extension._listeners.length, 0);
            assert.equal(this.extension._sessionHook, null);
        },
    };
}

const expectedNormalCleanup = [
    'timer:1',
    'timer:2',
    'hook',
    'listener:favorite-clusters',
    'listener:chat-lookup',
    ...normalOrder,
];
const normal = fixture();
normal.extension.enable();
assert.equal(normal.cleanup.length, 0, 'successful enable must not dispose live components');
normal.extension.disable();
assert.deepEqual(normal.cleanup, expectedNormalCleanup, 'preserve the established disposal order');
normal.assertEmpty();
normal.extension.disable();
assert.deepEqual(normal.cleanup, expectedNormalCleanup, 'disable is idempotent');

for (const options of [
    { failConstruct: 'projects' },
    { failSubscribe: 2 },
    { failHook: true },
    { failTimer: 2 },
    { failLate: true },
]) {
    const test = fixture(options);
    assert.throws(
        () => test.extension.enable(),
        (error) => error === test.failure
    );
    test.assertEmpty();
    const expectedComponents = options.failLate ? normalOrder : [...test.created].reverse();
    assert.deepEqual(
        test.cleanup.filter((name) => normalOrder.includes(name)),
        expectedComponents,
        'partial assembly unwinds dependencies; completed assembly retains the normal order'
    );
    const count = test.cleanup.length;
    test.extension.disable();
    assert.equal(test.cleanup.length, count, 'failed enable must not leave cleanup to run twice');
}

const throwing = fixture({
    throwCleanup: ['timer:1', 'hook', 'listener:favorite-clusters', 'reset', 'layout'],
});
throwing.extension.enable();
assert.doesNotThrow(() => throwing.extension.disable());
assert.deepEqual(throwing.cleanup, expectedNormalCleanup, 'one failure cannot skip later cleanup');
assert.equal(throwing.errors.length, 5);
throwing.assertEmpty();
throwing.extension.disable();
assert.deepEqual(throwing.cleanup, expectedNormalCleanup);

const rollback = fixture({
    failConstruct: 'projects',
    throwCleanup: ['chat'],
    throwLogger: true,
});
assert.throws(
    () => rollback.extension.enable(),
    (error) => error === rollback.failure
);
rollback.assertEmpty();
assert.equal(rollback.errors.length, 1, 'cleanup failure is logged without masking enable failure');
console.log(
    'PASS: extension enable rollback, timer/listener/hook cleanup, normal disposal order and idempotent best-effort disable'
);
