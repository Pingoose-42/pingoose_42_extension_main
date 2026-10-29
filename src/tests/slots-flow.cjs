const assert = require('node:assert/strict');
const { slotRequest } = require('../services/slotsService.js');
const one = {
    id: 1,
    ids: '1,2',
    title: 'Available',
    start: '2026-10-18T12:00:00+09:00',
    end: '2026-10-18T13:00:00+09:00',
};
let rows, posts, fail;
global.document = { querySelector: () => ({ content: 'fixture-csrf' }) };
global.fetch = async (url, options) => {
    if (options.method === 'POST') {
        posts.push({ url, options });
        if (fail) return { status: 403 };
        rows = rows.filter((row) => `/slots/${row.id}.json` !== url);
        return { status: 204 };
    }
    return { ok: true, json: async () => rows };
};
(async () => {
    rows = [one, { ...one, id: 3, title: 'Booked' }];
    posts = [];
    let result = await slotRequest('list', []);
    assert.equal(result.rows.length, 1);
    assert.equal(posts.length, 0);
    const snapshot = result.rows;
    result = await slotRequest('close', snapshot);
    assert.equal(posts.length, 1);
    assert.equal(result.rows.length, 0);
    assert.equal(posts[0].url, '/slots/1.json');
    assert.equal(new URLSearchParams(posts[0].options.body).get('ids'), '1,2');
    rows = [{ ...one, ids: '1,2,4' }];
    posts = [];
    result = await slotRequest('close', snapshot);
    assert.equal(posts.length, 0);
    assert.ok(result.error);
    rows = [one, { ...one, id: 4, ids: '4' }];
    posts = [];
    result = await slotRequest('all', snapshot);
    assert.equal(posts.length, 2);
    assert.equal(result.rows.length, 0);
    rows = [one];
    posts = [];
    fail = true;
    result = await slotRequest('close', snapshot);
    assert.ok(result.error);
    assert.equal(result.rows.length, 1);
    global.document.querySelector = () => null;
    await assert.rejects(() => slotRequest('all', snapshot), /expired/);
    console.log(
        'PASS: read-only list; individual close; grouped ids; fresh availability check; Close All includes fresh available slots missing from displayed snapshot; partial failure; missing CSRF'
    );
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
