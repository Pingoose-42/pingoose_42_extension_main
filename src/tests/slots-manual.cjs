const assert = require('node:assert/strict');
const { manual, build } = require('../models/slotSchedule.js');
const { slotRequest } = require('../services/slotsService.js');
const now = Date.now(),
    slot = build(now, 2, 1, 1)[0];
const fmt = (value) => {
    const d = new Date(value),
        p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
assert.deepEqual(manual(fmt(slot.begin), fmt(slot.end), now), slot);
for (const hours of [4, 5, 24, 48]) {
    const end = new Date(Date.parse(slot.begin) + hours * 3600000).toISOString();
    assert.equal(manual(fmt(slot.begin), fmt(end), now).end, end);
}
assert.throws(() => manual('2026-02-30 12:00', '2026-03-01 12:30', 0), /valid/);
assert.throws(() => manual(fmt(slot.begin).replace(/\d\d$/, '13'), fmt(slot.end), now), /minutes/);
assert.throws(() => manual(fmt(slot.begin), fmt(slot.end), Date.parse(slot.begin)), /30 minutes/);
assert.throws(() => manual(fmt(slot.end), fmt(slot.begin), now), /length/);
global.document = { querySelector: () => ({ content: 'csrf' }) };
(async () => {
    let posts = 0,
        reads = 0;
    let rows = [{ id: 1, title: 'Available', start: slot.begin, end: slot.end }];
    global.fetch = async (url, options) => {
        if (options.method === 'POST') {
            posts++;
            rows = [
                {
                    id: 1,
                    ids: '1,2',
                    title: 'Available',
                    start: slot.begin,
                    end: new Date(Date.parse(slot.end) + 1800000).toISOString(),
                },
            ];
            return { ok: true, json: async () => ({ status: 200 }) };
        }
        reads++;
        return { ok: true, json: async () => rows };
    };
    const conflict = await slotRequest('create', [], slot);
    assert.match(conflict.error, /Overlaps/);
    assert.equal(posts, 0);
    const adjacent = {
        begin: slot.end,
        end: new Date(Date.parse(slot.end) + 1800000).toISOString(),
    };
    const result = await slotRequest('create', [], adjacent);
    assert.equal(posts, 1);
    assert.equal(result.created, 1);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].ids, '1,2');
    assert.equal(result.rows[0].end, adjacent.end);
    assert.equal(reads, 3);
    const long = {
        begin: new Date(Date.parse(slot.end) + 86400000).toISOString(),
        end: new Date(Date.parse(slot.end) + 2 * 86400000).toISOString(),
    };
    const longResult = await slotRequest('create', [], long);
    assert.equal(longResult.created, 1);
    assert.equal(posts, 2);
    const invalid = await slotRequest('create', [], {
        begin: new Date(now).toISOString(),
        end: new Date(now + 1800000).toISOString(),
    });
    assert.match(invalid.error, /30 minutes/);
    assert.equal(posts, 2);
    console.log(
        'PASS: manual date/grid/lead-time validation, fresh-server overlap rejection, adjacency and merged range refresh'
    );
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
