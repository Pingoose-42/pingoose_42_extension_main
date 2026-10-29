const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
const source = fs.readFileSync('src/services/chat.js', 'utf8');
const context = { peerKey: (seat) => seat.toLowerCase() };
vm.createContext(context);
const Probe = vm.runInContext(
    '(class {' +
        source.slice(source.indexOf('    isBlocked('), source.indexOf('    start()')) +
        '})',
    context
);
const p = new Probe(),
    closed = [];
p.peers = [{ key: 'c2r3s4' }, { key: 'c20r3s4' }, { key: 'c3r4s5' }];
p.close = (seat) => closed.push(seat);
p.peer = (key) => p.peers.find((peer) => peer.key === key);
p.setBlocked(['c2', 'c3r4', 'c4r5s6']);
assert(p.isBlocked('c2r9s8'));
assert(!p.isBlocked('c20r9s8'));
assert(p.isBlocked('c3r4s9'));
assert(!p.isBlocked('c3r40s9'));
assert(p.isBlocked('c4r5s6'));
assert(!p.isBlocked('c4r5s60'));
assert.deepEqual(closed, ['c2r3s4', 'c3r4s5']);
p.setBlocked([]);
assert(!p.isBlocked('c2r3s4'));
console.log('PASS: cluster/row/seat boundaries, immediate disconnection and unblock');

p.peers[0].login = 'example';
p.setBlocked(['@example']);
assert(p.isBlocked('c2r3s4'));
assert(!p.isBlocked('c20r3s4'));
