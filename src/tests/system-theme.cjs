const assert = require('node:assert/strict');
const { controller, Actor } = require('./helpers.cjs');
const Settings = controller('ui/settings.js', {
    imports: {
        gi: {},
        misc: { extensionUtils: { getCurrentExtension: () => ({}) } },
    },
});
const p = Object.create(Settings.prototype);
const actor = new Actor();
let selected = 'system', scheme = 'prefer-dark', gtk = 'Adwaita';
p._indicator = { menu: { actor } };
p._settings = { get_string: () => selected };
p._systemTheme = { get_string: key => key === 'color-scheme' ? scheme : gtk };
function expect(theme) {
    p._applyTheme();
    assert(actor.style_class.includes('pingoose-' + theme));
    assert(!actor.style_class.includes('pingoose-' + (theme === 'dark' ? 'light' : 'dark')));
}
expect('dark');
scheme = 'prefer-light'; gtk = 'Adwaita-dark'; expect('light');
scheme = 'default'; expect('dark');
gtk = 'Adwaita'; expect('light');
selected = 'dark'; expect('dark');
selected = 'light'; scheme = 'prefer-dark'; expect('light');
selected = 'system'; p._systemTheme = null; expect('light');
console.log('PASS: system theme resolution, GTK fallback and explicit overrides');
