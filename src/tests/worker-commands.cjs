const assert = require('node:assert/strict');
const { moduleExport, controller } = require('./helpers.cjs');
const Router = moduleExport('worker/commands.js', 'Router');
const calls = [];
const actions = new Proxy(
    {},
    {
        get:
            (_target, name) =>
            (...args) =>
                calls.push([name, ...args]),
    }
);
const router = new Router(actions);
router.dispatch('present:123:login');
router.dispatch('agenda:subscribe:42');
router.dispatch('slots:close:123');
router.dispatch('slots:open-30m');
router.dispatch('slots:create:{"begin":"future"}');
router.dispatch('feedback:42');
assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['login', 123],
    ['subscription', '42', 'subscribe'],
    ['slots', 'close', '123'],
    ['autoSlots', true],
    ['createSlots', { begin: 'future' }, 0],
    ['feedback', '42'],
]);
for (const payload of ['null', '[]', '3', '"x"', '{']) router.dispatch('project:open:' + payload);
assert.equal(calls.filter((row) => row[0] === 'invalid').length, 5);
const length = calls.length;
for (const command of [
    'unknown',
    'present:4294967296:show',
    'x'.repeat(4097),
    null,
    'slots:close:bad',
])
    router.dispatch(command);
assert.equal(calls.length, length);

let identity = {},
    result,
    runs = 0,
    closes = 0;
const slotEvents = [];
class SlotsService {
    run(action, id, done, payload) {
        runs++;
        result = done;
        this.last = { action, id, payload };
    }
    close() {
        closes++;
    }
}
const Slots = controller('worker/slots.js', {
    imports: {
        services: { slotsService: { SlotsService } },
        models: {
            featureFlags: { enabled: () => false },
        },
    },
});
const slots = new Slots({ current: () => identity, emit: (value) => slotEvents.push(value) });
slots.request('list');
slots.service.busy = true;
slots.request('list');
slots.request('create');
assert.equal(runs, 1);
assert.match(slotEvents.at(-1).error, /already running/);
identity = {};
result({ rows: [1] });
assert.equal(slotEvents.length, 1, 'old session responses cannot repopulate slots');
slots.clear();
slots.clear();
assert.equal(closes, 1);
identity = null;
slots.request('list');
assert.match(slotEvents.at(-1).error, /Log in/);
slots.automatic(false);
assert.match(slotEvents.at(-1).error, /disabled/);

const windows = [],
    errors = [];
let allowed = true;
const Windows = controller('worker/windows.js', {
    imports: {
        worker: {
            serviceBrowser: {
                open(...args) {
                    const item = {
                        args,
                        connect(_signal, callback) {
                            this.closed = callback;
                        },
                        destroy() {
                            this.closed();
                        },
                    };
                    windows.push(item);
                    return item;
                },
            },
        },
    },
});
const browser = new Windows({
    login: 'me',
    canBrowse: () => allowed,
    canOpenProject: () => allowed,
    onError: () => errors.push(true),
});
browser.project({ slug: '../unsafe', login: 'me' });
browser.project({ slug: 'libft', login: 'other' });
assert.equal(windows.length, 0);
browser.project({ name: 'Libft', slug: 'libft', login: 'me' }, 12);
assert.equal(windows[0].args[2], 'https://projects.intra.42.fr/libft/me');
assert.equal(windows[0].args[4], 12);
for (let i = 0; i < 6; i++) browser.open({ name: 'Intra', url: 'https://profile.intra.42.fr/' });
assert.equal(windows.length, 6, 'five service windows plus one project');
browser.closeServices();
assert.equal(browser.services.size, 0);
assert.equal(browser.projects.size, 1);
browser.clear();
browser.clear();
assert.equal(browser.projects.size, 0);
allowed = false;
browser.open({});
assert.equal(windows.length, 6);
console.log(
    'PASS: command validation/routing, session-scoped slot results and bounded window lifecycle'
);
