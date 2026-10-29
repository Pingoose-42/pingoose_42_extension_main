const assert = require('node:assert/strict'),
    M = require('../models/maintenance.js');
const s = M.parse(
    'Scheduled Maintenance Notice On Wednesday 04/11/2026, 22:00 - 23:00 UTC (23:00 - 00:00 Paris)'
);
assert.equal(new Date(s.start).toISOString(), '2026-11-04T22:00:00.000Z');
assert.equal(M.active(s, s.start - 1), false);
assert(M.active(s, s.start));
assert(!M.active(s, s.end));
assert.equal(M.parse('Scheduled Maintenance 31/02/2026, 22:00 - 23:00 UTC'), null);
assert.equal(M.parse('Scheduled Maintenance 04/11/2026, 22:00 - 23:00 Paris'), null);
assert.equal(
    M.parse('Scheduled Maintenance 04/11/2026, 23:00 - 01:00 UTC').end - s.start,
    3 * 3600000
);
process.env.TZ = 'Asia/Seoul';
assert.match(M.label(s), /05/);
console.log(
    'PASS: maintenance UTC parsing, local next-day display, boundaries and invalid notices'
);
