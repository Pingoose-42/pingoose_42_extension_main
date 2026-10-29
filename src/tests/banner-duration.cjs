const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
let seconds = 4,
    changed,
    disconnected = false;
const settings = {
    get_int: () => seconds,
    connect: (_, fn) => {
        changed = fn;
        return 1;
    },
    disconnect: () => {
        disconnected = true;
    },
};
const tray = {
    _notification: { pingooseBanner: true, urgency: 1 },
    _showNotificationCompleted() {
        this._updateNotificationTimeout(4000);
    },
    _updateNotificationTimeout(ms) {
        this.timeout = ms;
    },
    _updateState() {
        this.closed =
            this.removed ||
            this.explicitClose ||
            (this.timeout === 0 && this._notification.urgency !== 3);
    },
};
const originalState = tray._updateState,
    originalCompleted = tray._showNotificationCompleted;
const Controller = vm.runInNewContext(
    fs.readFileSync('src/services/bannerDuration.js', 'utf8') + '\nController',
    {
        imports: { ui: { main: { messageTray: tray }, messageTray: { Urgency: { CRITICAL: 3 } } } },
    }
);
const controller = new Controller(settings);
tray._showNotificationCompleted();
assert.equal(tray.timeout, 4000);
seconds = 12;
changed();
assert.equal(tray.timeout, 12000);
tray._showNotificationCompleted();
assert.equal(tray.timeout, 12000);
seconds = 0;
changed();
tray._updateState();
assert.equal(tray.closed, false);
assert.equal(tray._notification.urgency, 1);
tray.explicitClose = true;
tray._updateState();
assert.equal(tray.closed, true);
tray.explicitClose = false;
tray.removed = true;
tray._updateState();
assert.equal(tray.closed, true);
tray.removed = false;
tray._notification = { urgency: 1 };
tray._updateState();
assert.equal(tray.closed, true);
tray._showNotificationCompleted();
assert.equal(tray.timeout, 4000);
tray._notification.pingooseBanner = true;
controller.destroy();
assert.equal(tray._updateState, originalState);
assert.equal(tray._showNotificationCompleted, originalCompleted);
assert.equal(tray.timeout, 4000);
assert.ok(disconnected);
console.log('PASS: banner duration, sticky dismissal, unrelated banners and hook cleanup');
