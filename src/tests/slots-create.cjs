const assert = require('node:assert/strict');
const { slotRequest } = require('../services/slotsService.js');
let posts = [];
global.document = { querySelector: () => ({ content: 'csrf' }) };
global.fetch = async (url, options) => {
    if (options.method === 'POST') {
        posts.push(options);
        return { ok: true, json: async () => ({ status: posts.length !== 2 ? 200 : 422 }) };
    }
    return { ok: true, json: async () => [] };
};
(async () => {
    const payload = [0, 1, 2, 3, 4].map((i) => ({
        begin: new Date(Date.now() + 3600000 * (i + 1)).toISOString(),
        end: new Date(Date.now() + 3600000 * (i + 1) + 1800000).toISOString(),
    }));
    // Keep endpoints exactly 30 minutes apart even across a millisecond boundary.
    for (const slot of payload) slot.end = new Date(Date.parse(slot.begin) + 1800000).toISOString();
    const result = await slotRequest('create-5', [], payload);
    assert.equal(posts.length, 5);
    assert.equal(result.created, 4);
    assert.match(result.error, /1 slot/);
    assert.equal(posts[0].headers['X-CSRF-Token'], 'csrf');
    assert.equal(new URLSearchParams(posts[0].body).get('slot[begin_at]'), payload[0].begin);
    await assert.rejects(() => slotRequest('create-5', [], Array(21).fill(payload[0])), /Invalid/);
    document.querySelector = () => null;
    await assert.rejects(() => slotRequest('create-5', [], payload), /expired/);
    console.log(
        'PASS: five-slot POST payloads, CSRF, partial failure count, bounded schedule and expired session'
    );
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
