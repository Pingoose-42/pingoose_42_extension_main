// Shared order for preferences and the Shell menu. The overview is one two-column row.
var sections = [
    ['profile', 'Profile', ['profile']],
    ['overview', 'My Projects & Logtime', ['projects', 'logtime']],
    ['slots', 'Evaluation Slots', ['slots']],
    ['evaluations', 'Evaluation Info', ['evaluations']],
    ['agenda', 'Agenda', ['agenda']],
    ['notifications', 'Notifications', ['notifications']],
    ['chat', 'Cluster Chat', ['chat']],
    ['services', '42 Services', ['services']],
];
function normalize(values) {
    const defaults = sections.map((section) => section[0]);
    return [...new Set([...values.filter((value) => defaults.includes(value)), ...defaults])];
}
function read(settings) {
    return normalize(settings.get_strv('section-order'));
}
