const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/ui/chatPanel.js', 'utf8');
const Probe = vm.runInNewContext(
    '(class {' +
        source.slice(source.indexOf('    _isViewingChat('), source.indexOf('    _notifyChat(')) +
        '})'
);
function fixture() {
    const panel = new Probe(),
        read = [],
        banners = [];
    Object.assign(panel, {
        _indicator: { menu: { isOpen: true }, loginOnly: false },
        _expanded: true,
        _chatActive: 'c1r1s1',
        _chatUi: { visible: true, root: { mapped: true } },
        _chat: { markRead: (key) => read.push(key) },
        _renderChat() {},
        _appendChatEntry() {},
        _renderChatChips() {},
        _updatePanelLabel() {},
        _notifyChat: (key, text) => banners.push({ key, text }),
    });
    return { panel, read, banners };
}
let { panel, read, banners } = fixture();
panel._chatMessage('c1r1s1', { dir: 'in', text: 'Visible message' });
assert.deepEqual(read, ['c1r1s1']);
assert.equal(banners.length, 0, 'viewed conversation does not notify');
panel._chatMessage('c1r1s2', { dir: 'in', text: 'Other conversation' });
assert.equal(banners.length, 1, 'another conversation still notifies');
assert.equal(read.length, 1, 'another conversation remains unread');
for (const hide of [
    (p) => {
        p._indicator.menu.isOpen = false;
    },
    (p) => {
        p._expanded = false;
    },
    (p) => {
        p._chatUi.visible = false;
    },
    (p) => {
        p._chatUi.root.mapped = false;
    },
]) {
    ({ panel, read, banners } = fixture());
    hide(panel);
    panel._chatMessage('c1r1s1', { dir: 'in', text: 'Not being viewed' });
    assert.equal(read.length, 0);
    assert.equal(banners.length, 1, 'hidden conversation still notifies');
    panel._chatMessage('c1r1s1', { dir: 'out', text: 'My message' });
    panel._chatMessage('c1r1s1', { dir: 'sys', text: 'Status' });
    assert.equal(banners.length, 1, 'only incoming user messages notify');
}
console.log(
    'PASS: viewed chat stays quiet/read; other rooms and hidden panels notify; outgoing/system messages do not'
);
let title;
const BannerProbe = vm.runInNewContext(
    '(class {' +
        source.slice(source.indexOf('    _notifyChat('), source.indexOf('    _selectChat(')) +
        '})',
    {
        GLib: { get_monotonic_time: () => 10000000 },
        MessageTray: {
            Notification: class {
                constructor(_source, value) {
                    title = value;
                }
                setTransient() {}
                connect() {}
            },
        },
    }
);
const bannerPanel = new BannerProbe();
bannerPanel._settings = { get_boolean: () => true };
bannerPanel._chatBannerSource = { showNotification() {} };
bannerPanel._chat = { peer: () => ({ login: 'fixture', key: 'c1r1s1' }) };
bannerPanel._notifyChat('c1r1s1', 'Hello');
assert.equal(title, 'Cluster Chat · fixture (c1r1s1)');
bannerPanel._lastChatBanner = 0;
bannerPanel._chat.peer = () => ({ key: 'c1r1s1' });
bannerPanel._notifyChat('c1r1s1', 'Hello');
assert.equal(title, 'Cluster Chat · c1r1s1');
console.log('PASS: chat banner includes login and seat, with seat-only fallback');
