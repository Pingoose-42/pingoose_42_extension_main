const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
const source = fs.readFileSync('src/ui/notifications.js', 'utf8');
let shown;
const context = {
    MessageTray: {
        Notification: class {
            constructor(_source, title, body) {
                this.title = title;
                this.body = body;
            }
            setTransient() {}
            connect() {}
        },
    },
};
const Probe = vm.runInNewContext(
    '(class {' +
        source.slice(source.indexOf('    _showBanner('), source.indexOf('    _flashScreen(')) +
        '})',
    context
);
const panel = new Probe();
panel._bannerSource = { showNotification: (notice) => (shown = notice) };
panel._showBanner({
    id: 'intrapy:1',
    body: 'You have been matched with someone.\nEvaluator · 10/23 14:00 · Libft',
});
assert.equal(shown.title, 'New Evaluation Matched');
assert.equal(shown.body, 'Evaluator · 10/23 14:00 · Libft');
panel._showBanner({
    id: 'agenda:1',
    category: 'agenda',
    body: 'New agenda event · Career Fair\n23/10/2026, 14:00',
});
assert.equal(shown.title, 'New Agenda Event');
assert.match(shown.body, /^Career Fair\n/);
console.log('PASS: banners show event type and actual project/time or agenda details');
