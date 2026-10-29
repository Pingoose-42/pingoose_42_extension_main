const assert = require('node:assert/strict'),
    { slotRequest } = require('../services/slotsService.js');
const base = Date.now() + 3600000,
    iso = (minutes) => new Date(base + minutes * 60000).toISOString();
const slot = (id, begin, end, reserved = false) => ({
    id,
    ids: String(id),
    title: reserved ? 'Evaluation' : 'Available',
    className: reserved ? ['reserved'] : [],
    start: iso(begin),
    end: iso(end),
});
let rows = [slot(1, 0, 180), slot(2, 180, 210, true), slot(3, 210, 300)],
    deleted = [];
global.document = { querySelector: () => ({ content: 'test' }) };
global.fetch = async (url, options) => {
    if (options.method === 'POST') {
        const id = Number(url.match(/slots\/(\d+)/)[1]);
        deleted.push(id);
        rows = rows.filter((row) => row.id !== id);
        return { status: 204 };
    }
    return { ok: true, json: async () => rows };
};
(async () => {
    const list = await slotRequest('list', []);
    assert.equal(list.rows.length, 3);
    assert.equal(list.rows[1].matched, true);
    const closed = await slotRequest('all', list.rows);
    assert.deepEqual(deleted, [1, 3]);
    assert.equal(closed.rows.length, 1);
    assert.equal(closed.rows[0].matched, true);
    assert.equal(closed.error, null);
    const stale = { ...list.rows[0] };
    rows = [{ ...slot(1, 0, 180, true) }];
    deleted = [];
    const race = await slotRequest('close', [stale]);
    assert.equal(deleted.length, 0);
    assert(race.error);
    console.log(
        'PASS: split availability plus reserved evaluation; bulk close preserves reservation; stale close cannot delete newly matched slot'
    );
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
