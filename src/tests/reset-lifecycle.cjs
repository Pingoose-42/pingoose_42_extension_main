const assert = require('node:assert/strict');
const { controller } = require('./helpers.cjs');
let defaults = 0,
    cleared = 0,
    prepared = 0,
    refreshed = 0,
    updaterStops = 0,
    starts = 0;
const listeners = new Map();
const bridge = {
    isRunning: true,
    on(type, callback) {
        listeners.set(type, callback);
        return () => listeners.delete(type);
    },
    send(cmd) {
        assert.equal(cmd, 'reset-all');
    },
    start() {
        starts++;
    },
};
const values = { 'reset-request': 'request' };
const settings = {
    get_string: (key) => values[key],
    set_string: (key, value) => (values[key] = value),
    connect: () => 1,
    disconnect() {},
};
const Reset = controller('services/reset.js', {
    imports: {
        gi: { Gio: { Settings: { sync() {} } } },
        misc: {
            extensionUtils: {
                getCurrentExtension: () => ({
                    imports: {
                        services: {
                            resetData: {
                                clearAll() {
                                    cleared++;
                                },
                            },
                        },
                        models: {
                            settingsDefaults: {
                                restore() {
                                    defaults++;
                                },
                            },
                        },
                    },
                }),
            },
        },
    },
    logError: (err) => {
        throw err;
    },
});
const reset = new Reset(bridge, settings, {
    prepare() {
        prepared++;
    },
    clear() {},
    refresh() {
        refreshed++;
    },
    updater: {
        destroy() {
            updaterStops++;
        },
    },
});
reset.request();
reset.request();
assert.equal(prepared, 1);
assert.equal(updaterStops, 1);
assert.equal(reset.active, true);
listeners.get('reset-ready')();
assert.equal(cleared, 0);
listeners.get('process-exited')();
assert.equal(cleared, 1);
assert.equal(defaults, 1);
assert.equal(refreshed, 1);
assert.equal(starts, 1);
assert.equal(values['reset-status'], 'done');
assert.equal(reset.active, false);
values['reset-request'] = 'second';
reset.request();
listeners.get('reset-error')();
assert.equal(reset.active, false);
reset.request();
listeners.get('process-exited')();
assert.equal(values['reset-status'], 'error');
assert.equal(reset.active, false);
reset.destroy();
assert.equal(listeners.size, 0);
console.log(
    'PASS: reset is single-flight, waits for final acknowledgement and exit, reports failure and removes listeners'
);
