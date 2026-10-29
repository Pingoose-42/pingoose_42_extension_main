const assert = require('node:assert/strict');
const Sites = require('../models/serviceSites.js');
assert.deepEqual(
    Sites.readSites({ get_string: () => '' }).map((s) => s.name),
    ['SUBAK', 'PeerFinder']
);
assert.equal(Sites.normalizeSite('Bad', 'javascript:alert(1)'), null);
assert.equal(Sites.normalizeSite('Bad', 'https://user:password@example.org/'), null);
assert.equal(Sites.normalizeSite('Bad', 'file:///tmp/secret'), null);
assert.equal(Sites.normalizeSite('Name', 'https://example.org/path?q=1').name, 'Name');
assert.deepEqual(Sites.readSites({ get_string: () => '[]' }), []);
assert.equal(
    Sites.readSites({
        get_string: () => JSON.stringify([{ name: 'Custom', url: 'https://example.org/' }]),
    })[0].name,
    'Custom'
);
console.log('PASS: defaults, custom catalogue, removal, HTTPS-only URL validation');
