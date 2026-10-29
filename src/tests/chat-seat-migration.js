const { GLib } = imports.gi;
imports.searchPath.unshift(GLib.build_filenamev([GLib.get_current_dir(), 'src']));
const Chat = imports.services.chat,
    service = new Chat.ChatService();
service._connect = () => {}; // Verify state transitions without contacting any seat.
const expires = Date.now() + 600000,
    session = { id: 'evaluation', login: 'peer', expires };
const policy = (seat) => ({
    active: true,
    general: false,
    login: 'local',
    sessions: [session],
    grants: seat ? [{ ...session, seat }] : [],
});
service.configure(policy('c1r1s1'));
service.open('c1r1s1', 'evaluation', false, 'peer');
if (service.peer('c1r1s1').login !== 'peer') throw Error('Evaluation nickname missing');
service.peer('c1r1s1').history.push({ dir: 'in', text: 'Keep this conversation' });
service.configure(policy('c1r1s2'));
if (service.peer('c1r1s1') || service.peer('c1r1s2').history[0].text !== 'Keep this conversation')
    throw Error('Direct move lost history');
if (service.peer('c1r1s2').login !== 'peer') throw Error('Seat migration lost nickname');
service.configure(policy(null));
if (service.peers.length || service._evaluationChats.size !== 1)
    throw Error('Unavailable seat is not suspended');
service.configure(policy('c2r3s4'));
if (service.peer('c2r3s4').history[0].text !== 'Keep this conversation')
    throw Error('Resume lost history');
service.close('c2r3s4');
service.configure(policy('c2r3s4'));
if (service.peers.length || service._evaluationChats.size) throw Error('Explicit close revived');
service.open('c2r3s4', 'evaluation');
service.configure(policy(null));
service.configure({ ...policy(null), sessions: [] });
if (service._evaluationChats.size) throw Error('Expired/missing evaluation retained history');
service.destroy();
print('PASS: direct seat move, offline suspension/resume, manual close and expiry cleanup');
