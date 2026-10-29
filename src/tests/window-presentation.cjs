const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
const Sender = vm.runInNewContext(
    fs.readFileSync('src/services/workerBridge.js', 'utf8') + '\nWorkerBridge',
    {
        global: { get_current_time: () => 123456 },
        imports: { gi: {}, misc: { extensionUtils: { getCurrentExtension: () => ({}) } } },
    }
);
const sender = new Sender();
Object.assign(sender, { _process: {}, _writeNext() {} });
sender.send('show');
sender.send('project:open:{"slug":"libft"}');
sender.send('slots:list');
assert.equal(sender._commands[0], 'present:123456:show');
assert.equal(sender._commands[1], 'present:123456:project:open:{"slug":"libft"}');
assert.equal(sender._commands[2], 'slots:list');
const { controller, moduleExport } = require('./helpers.cjs');
const Router = moduleExport('worker/commands.js', 'Router');
const opened = [];
const Windows = controller('worker/windows.js', {
    imports: {
        worker: {
            serviceBrowser: {
                open(_context, _name, url, project, timestamp) {
                    opened.push({ url, project, timestamp });
                    return { connect() {} };
                },
            },
        },
    },
});
const windows = new Windows({ canBrowse: () => true, canOpenProject: () => true, login: 'me' });
const router = new Router({
    show: (timestamp) =>
        windows.open({ name: '42 Intra', url: 'https://profile.intra.42.fr/' }, timestamp),
});
router.dispatch(sender._commands[0]);
assert.deepEqual(opened, [
    { url: 'https://profile.intra.42.fr/', project: false, timestamp: 123456 },
]);
router.dispatch('present:4294967296:show');
assert.equal(opened.length, 1);
console.log('PASS: presentation timestamps survive routing and invalid timestamps are rejected');
