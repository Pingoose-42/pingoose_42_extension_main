const { GLib } = imports.gi;
imports.searchPath.unshift(GLib.build_filenamev([GLib.get_current_dir(), 'src']));
const Store = imports.services.cardStore;
if (!GLib.get_user_state_dir().startsWith('/tmp/')) throw Error('Use a temporary XDG_STATE_HOME');
const notifications = Array.from({ length: 12 }, (_, i) => ({
    id: String(i),
    body: 'Saved notification',
    unread: i === 0,
}));
Store.write({
    notifications,
    received: notifications.map((row) => row.id),
    tests: [{ id: 'dev-evaluation-test', devTest: true, begin: new Date().toISOString() }],
});
let restored = Store.read();
if (
    restored.notifications.length !== 12 ||
    !restored.notifications[0].unread ||
    restored.tests.length !== 1
)
    throw Error('Roundtrip failed');
Store.write({ ...restored, notifications: restored.notifications.slice(1) });
restored = Store.read();
if (restored.notifications.length !== 11 || restored.received.length !== 12)
    throw Error('Dismissal must retain dedup history');
Store.write({ ...restored, notifications: [], tests: [] });
if (Store.read().notifications.length) throw Error('Clear All failed');
print(
    'PASS: persistent cards beyond five, unread state, test cards, deletion and independent dedup history'
);
