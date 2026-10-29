const assert = require('node:assert/strict');
const { slotRequest } = require('../services/slotsService.js');
process.env.TZ = 'Asia/Seoul';
const RealDate = Date;
global.Date = class extends RealDate {
    constructor(...args) {
        super(...(args.length ? args : ['2026-10-19T15:30:00+09:00']));
    }
};
let writes = 0;
const rows = ['16:00', '17:15', '18:30', '19:45', '21:00'].map((time, i) => ({
    id: i + 1,
    ids: String(i + 1),
    title: 'Available',
    start: `2026-10-19T${time}:00+09:00`,
    end: new Date(Date.parse(`2026-10-19T${time}:00+09:00`) + 3600000).toISOString(),
}));
global.document = { querySelector: () => ({ content: 'fixture' }) };
global.fetch = async (url, options) => {
    if (options.method === 'POST') {
        writes++;
        return { status: 204 };
    }
    const query = new URL(url, 'https://profile.intra.42.fr').searchParams;
    assert.equal(query.get('start'), '2026-10-18T15:00:00.000Z');
    assert.equal(query.get('end'), '2026-10-26T15:00:00.000Z');
    assert.equal(options.cache, 'no-store');
    return { ok: true, json: async () => rows };
};
(async () => {
    const listed = await slotRequest('list', []);
    assert.equal(listed.rows.length, 5);
    const closed = await slotRequest('all', listed.rows);
    assert.equal(writes, 5);
    assert.match(closed.error, /5 slot/, 'HTTP success with retained slots must report failure');
    assert.equal(closed.closed, 0);
    console.log(
        'PASS: timezone-explicit complete day, uncached five-slot refresh and retained-slot deletion failure'
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
