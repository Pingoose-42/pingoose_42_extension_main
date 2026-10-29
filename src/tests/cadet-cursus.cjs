const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
const source = fs.readFileSync('src/worker/profile.js', 'utf8');
(async () => {
    for (const rows of [
        [
            { id: 9, slug: 'c-piscine' },
            { id: 21, slug: '42cursus' },
        ],
        [{ id: 9, slug: 'c-piscine' }],
        [
            { id: 21, slug: '42cursus' },
            { id: 9, slug: 'c-piscine' },
        ],
    ]) {
        const context = {
            window: { fetch: async () => new Response(JSON.stringify(rows)) },
            URL,
            Response,
            location: { href: 'https://profile-v3.intra.42.fr/' },
        };
        vm.createContext(context);
        vm.runInContext(source + ';preferCadetCursus();', context);
        const result = await (
            await context.window.fetch('https://intrapy.intra.42.fr/api/v1/users/123/cursus')
        ).json();
        assert.equal(result[0].id, rows.some((r) => r.id === 21) ? 21 : 9);
        assert.equal(result.length, rows.length);
        const unrelated = await (
            await context.window.fetch('https://intrapy.intra.42.fr/api/v1/users/123/events')
        ).json();
        assert.deepEqual(unrelated, rows);
    }
    console.log('PASS: cadet preferred, piscine-only preserved, unrelated responses unchanged');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
