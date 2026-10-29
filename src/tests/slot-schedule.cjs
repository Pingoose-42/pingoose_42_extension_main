const assert = require('node:assert/strict'),
    { build } = require('../models/slotSchedule.js');
const now = Date.parse('2026-10-18T00:01:00Z');
const slots = build(now, 3, 4, 3);
assert.equal(slots[0].begin, '2026-10-18T00:45:00.000Z');
assert.equal(Date.parse(slots[0].end) - Date.parse(slots[0].begin), 45 * 60000);
assert.equal(Date.parse(slots[1].begin) - Date.parse(slots[0].end), 60 * 60000);
assert.equal(slots.length, 3);
const shortGap = build(now, 2, 1, 2);
assert.equal(shortGap[0].end, '2026-10-18T01:15:00.000Z');
assert.equal(shortGap[1].begin, '2026-10-18T01:30:00.000Z');
assert.equal(shortGap[1].end, '2026-10-18T02:00:00.000Z');
assert.throws(() => build(now, 2, 0, 3));
assert.throws(() => build(now, 1.5, 2, 3));
assert.throws(() => build(now, 1, 2, 21));
assert.throws(() => build(now, 1, 96, 20), /7 days/);
console.log(
    'PASS: earliest slot boundary, 15-minute units, count, end-to-start gap and date bounds'
);
