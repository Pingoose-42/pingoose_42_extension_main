const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('src/ui/indicator.js', 'utf8');
const Indicator = vm.runInNewContext(source + '\nIndicator', {
    imports: {
        gi: { GObject: { registerClass: (value) => value } },
        ui: { panelMenu: { Button: class {} } },
        misc: {
            extensionUtils: { getCurrentExtension: () => ({ imports: { ui: { reveal: {} } } }) },
        },
    },
});
const indicator = Object.create(Indicator.prototype);
indicator.icon = {};
indicator.count = {};
let transitions = 0;
indicator.onLoginStateChanged = () => transitions++;
indicator.setLoginOnly(true);
assert.equal(transitions, 1);
indicator.setLoginOnly(false);
assert.equal(transitions, 2);
for (let i = 0; i < 10; i++) indicator.setLoginOnly(false);
assert.equal(transitions, 2, 'periodic watching status must not close options');
indicator.setLoginOnly(true);
assert.equal(transitions, 3, 'actual logout still closes options');
assert.equal(indicator.count.text, 'Login Required');
console.log(
    'PASS: repeated login status does not trigger menu closure; real transitions still notify'
);
