const vm = require('node:vm'),
    fs = require('node:fs'),
    assert = require('node:assert/strict');
const ctx = { imports: { gi: { GLib: { markup_escape_text: (s) => s } } } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('src/ui/countLabel.js', 'utf8'), ctx);
let markup;
const label = { set_markup: (s) => (markup = s) };
ctx.update(label, 'Agenda', 2, false, 3);
assert.equal(
    markup,
    'Agenda · <span foreground="#85d6cb">2</span> · <span foreground="#ef6464">3</span>'
);
ctx.update(label, 'Agenda', 0, true, 3);
assert.equal(markup, 'Agenda · <span foreground="#ef6464">3</span>');
ctx.update(label, 'Agenda', 2, true, 0);
assert.equal(markup, 'Agenda · 2');
ctx.update(label, 'Agenda', 0, false, 0);
assert.equal(markup, 'Agenda');
console.log('PASS: separate feedback count, expanded colors and zero suppression');
