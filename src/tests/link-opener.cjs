const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

let launched = [];
const context = {
    imports: {
        gi: {
            Gio: {
                AppInfo: {
                    launch_default_for_uri(url) {
                        launched.push(url);
                    },
                },
            },
        },
    },
    module: {},
};

vm.createContext(context);
vm.runInContext(fs.readFileSync('src/services/linkOpener.js', 'utf8'), context);
const { openLink, openProject } = context.module.exports;

// Test 1: open-in-browser is disabled (false) -> sends to bridge
let bridgeSent = [];
const mockBridge = {
    send(command) {
        bridgeSent.push(command);
    },
};
const mockSettingsDisabled = {
    get_boolean(key) {
        if (key === 'open-in-browser') return false;
        return false;
    },
};

openLink(mockSettingsDisabled, mockBridge, { name: '42 Intra', url: 'https://profile.intra.42.fr/' });
assert.equal(launched.length, 0);
assert.equal(bridgeSent.length, 1);
assert.match(bridgeSent[0], /^service:open:/);
assert.match(bridgeSent[0], /profile\.intra\.42\.fr/);

openProject(mockSettingsDisabled, mockBridge, { slug: 'libft', login: 'cadet' });
assert.equal(launched.length, 0);
assert.equal(bridgeSent.length, 2);
assert.match(bridgeSent[1], /^project:open:/);

// Test 2: open-in-browser is enabled (true) -> launches default browser directly
launched = [];
bridgeSent = [];
const mockSettingsEnabled = {
    get_boolean(key) {
        if (key === 'open-in-browser') return true;
        return false;
    },
};

openLink(mockSettingsEnabled, mockBridge, { name: '42 Intra', url: 'https://profile.intra.42.fr/' });
assert.equal(launched.length, 1);
assert.equal(launched[0], 'https://profile.intra.42.fr/');
assert.equal(bridgeSent.length, 0, 'Must not send IPC when opened in default browser');

openProject(mockSettingsEnabled, mockBridge, { slug: 'libft', login: 'cadet' });
assert.equal(launched.length, 2);
assert.equal(launched[1], 'https://projects.intra.42.fr/libft/cadet');
assert.equal(bridgeSent.length, 0);

console.log('PASS: open-in-browser setting correctly routes links to default browser or webview IPC');
