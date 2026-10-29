const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
const files = new Map();
const api = vm.runInNewContext(
    fs.readFileSync('src/services/profileCampusCache.js', 'utf8') + '\n({read,write})',
    {
        imports: {
            byteArray: { fromString: (s) => s, toString: (s) => s },
            gi: {
                GLib: {},
                Gio: {
                    Credentials: class {
                        get_unix_user() {
                            return 1000;
                        }
                    },
                    FileQueryInfoFlags: { NOFOLLOW_SYMLINKS: 1 },
                    FileType: { REGULAR: 1 },
                    FileCreateFlags: { PRIVATE: 1, REPLACE_DESTINATION: 2 },
                    File: {
                        new_for_path: (path) => ({
                            query_info() {
                                if (!files.has(path)) throw Error();
                                return {
                                    get_file_type: () => 1,
                                    get_size: () => files.get(path).length,
                                    get_attribute_uint32: (key) =>
                                        key === 'unix::uid' ? 1000 : 0o600,
                                };
                            },
                            load_contents: () => [true, files.get(path)],
                            replace_contents: (body) => files.set(path, body),
                        }),
                    },
                },
            },
        },
    }
);
const user = { login: 'alice', subject: 'account-1' };
assert.equal(api.read('/state', user), null);
api.write('/state', user, 'paris');
assert.equal(api.read('/state', user), 'paris');
assert.equal(api.read('/state', { ...user, subject: 'another-account' }), null);
assert.equal(api.read('/state', { ...user, login: 'bob' }), null);
files.set('/state/profile-campus-alice.json', 'broken');
assert.equal(api.read('/state', user), null);
api.write('/state', user, '');
assert.equal(api.read('/state', user), null);
console.log('PASS: campus cache restores only the same account and ignores malformed data');
