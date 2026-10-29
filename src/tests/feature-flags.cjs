const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
const c = {};
vm.createContext(c);
vm.runInContext(fs.readFileSync('src/models/featureFlags.js', 'utf8'), c);
const values = new Map();
const s = {
    get_user_value: (key) => (values.has(key) ? {} : null),
    get_boolean: (key) => values.get(key) ?? false,
    set_boolean: (key, value) => values.set(key, value),
};
for (const development of [false, true]) {
    values.clear();
    c.HIDDEN_OPTIONS = development;
    c.DEVELOPMENT_DEFAULTS = development;
    assert.equal(c.unlocked(s), development);
    assert.equal(c.enabled(s, 'hidden-cluster-chat'), development);
    assert.equal(c.unlock(s, 'wrong'), false);
    assert.equal(c.unlock(s, 'pingoose-hidden'), false);
    assert.equal(c.unlock(s, '  Pingoose-Hidden-On  '), true);
    assert.equal(c.unlocked(s), true);
    s.set_boolean('hidden-cluster-chat', true);
    assert.equal(c.enabled(s, 'hidden-cluster-chat'), true);
    assert.equal(c.unlock(s, 'pingoose-hidden-off'), true);
    assert.equal(c.unlocked(s), false);
    assert.equal(c.enabled(s, 'hidden-cluster-chat'), false);
    assert.equal(c.enabled(s, 'hidden-dev-options'), false);
    assert.equal(c.enabled(s, 'hidden-auto-slots'), false);
    c.unlock(s, 'pingoose-hidden-on');
    assert.equal(c.enabled(s, 'hidden-cluster-chat'), true);
    values.clear();
    assert.equal(c.unlocked(s), development);
}
console.log(
    'PASS: on/off, invalid/old phrases, dev override, retained preferences and reset defaults'
);
c.unlock(s, 'pingoose-hidden-on');
s.set_boolean('hidden-dev-options', true);
assert.equal(
    c.enabled(s, 'hidden-dev-options'),
    true,
    'developer actions can be enabled after unlocking'
);
c.unlock(s, 'pingoose-hidden-off');
assert.equal(
    c.enabled(s, 'hidden-dev-options'),
    false,
    'locking hidden options disables developer actions'
);
console.log('PASS: developer actions require both unlock and feature toggle');
