const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
const { snapshot } = vm.runInNewContext(
    fs.readFileSync('src/models/clusterSeats.js', 'utf8') + '\n({snapshot})'
);
const result = snapshot(
    [
        { login: 'local', host: 'c2r3s4.42gyeongsan.kr', campus_id: 69, end_at: null },
        { login: 'ended', host: 'c1r1s1', campus_id: 69, end_at: '2026-10-24' },
        { login: 'other', host: 'c1r1s1', campus_id: 1, end_at: null },
    ],
    '69'
);
assert.equal(result.seats.local, 'c2r3s4');
assert.equal(result.seats.ended, undefined);
assert.equal(result.seats.other, undefined);
assert.equal(Object.keys(snapshot([], '69').seats).length, 0);
assert.throws(() => snapshot({}, '69'));
assert.equal(snapshot([], '1').campus, '1');
assert.throws(() => snapshot([], 'unknown'));
assert.throws(() => snapshot([{}], '69'));
console.log('PASS: cluster snapshot filters campus and ended seats and rejects invalid data');

let requests = [],
    emitted = [],
    statusCode = 200;
const Worker = vm.runInNewContext(
    fs.readFileSync('src/worker/clusters.js', 'utf8') + '\nController',
    {
        imports: {
            gi: {
                GLib: { timeout_add_seconds: () => 1, source_remove() {} },
                Soup: {
                    MessageFlags: { NO_REDIRECT: 1 },
                    Message: {
                        new: (_verb, uri) => ({
                            uri,
                            set_flags() {},
                            request_headers: {
                                append(name, value) {
                                    assert.equal(name, 'Cookie');
                                    assert.equal(value, 'meta-session');
                                },
                            },
                        }),
                    },
                },
            },
            models: { featureFlags: { enabled: () => true }, clusterSeats: { snapshot } },
        },
    }
);
const identity = { subject: 'test' };
const worker = new Worker({ current: () => identity, emit: (value) => emitted.push(value) });
worker.context = {
    get_cookie_manager: () => ({
        get_cookies(uri, _cancel, done) {
            assert.ok(uri.startsWith('https://meta.intra.42.fr/'));
            done({ get_cookies_finish: () => [{ to_cookie_header: () => 'meta-session' }] }, {});
        },
    }),
};
worker.session = {
    queue_message(message, done) {
        requests.push(message.uri);
        const body = message.uri.endsWith('.json')
            ? '[{"login":"friend","campus_id":1,"host":"c1r1s1","end_at":null}]'
            : '<div id="cluster-map" data-campus-id="1"></div>';
        done(null, { status_code: statusCode, response_body: { length: body.length, data: body } });
    },
};
worker.lookup({ request: '1' });
assert.equal(emitted[0].seats.friend, 'c1r1s1');
assert.equal(requests.length, 2);
worker.lookup({ request: '2' });
assert.equal(requests.length, 3);
statusCode = 302;
worker.lookup({ request: '3' });
assert.ok(emitted[2].error);
console.log(
    'PASS: Meta HTML supplies campus; direct scoped JSON refresh avoids DOM timing and does not follow auth redirects'
);
