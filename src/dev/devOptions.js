// Development actions are exposed only through the hidden feature gate.
const PopupMenu = imports.ui.popupMenu;
let evaluationSequence = 0;
function addOptions(settings, sendTest, addEvaluation, preferences, addAgenda, testMaintenance) {
    const menu = new PopupMenu.PopupSubMenuMenuItem('Dev Options');
    const test = new PopupMenu.PopupMenuItem('Send Test Notification');
    test.activate = () => sendTest();
    menu.menu.addMenuItem(test);
    const evaluation = new PopupMenu.PopupMenuItem('Create Test Evaluation');
    evaluation.activate = () =>
        addEvaluation({
            id: `dev-evaluation-${Date.now()}-${++evaluationSequence}`,
            devTest: true,
            project: `Test Evaluation ${evaluationSequence}`,
            slug: 'libft',
            kind: preferences?.get_string('dev-evaluation-role') || 'evaluated',
            users: ['test-user'],
            seats: { 'test-user': 'Test seat' },
            begin: new Date(
                Date.now() +
                    (preferences ? preferences.get_int('dev-evaluation-offset-minutes') : -1) *
                        60000
            ).toISOString(),
        });
    menu.menu.addMenuItem(evaluation);
    if (addAgenda) {
        const agenda = new PopupMenu.PopupMenuItem('Create Test Agenda');
        agenda.activate = () =>
            addAgenda({
                id: `dev-agenda-${Date.now()}-${++evaluationSequence}`,
                devTest: true,
                name: 'Test Agenda',
                location: 'Test location',
                begin: new Date(Date.now()).toISOString(),
                end: new Date(Date.now() + 3600000).toISOString(),
                feedback: false,
            });
        menu.menu.addMenuItem(agenda);
    }
    if (testMaintenance) {
        const maintenance = new PopupMenu.PopupMenuItem('Test Maintenance (1 minute)');
        maintenance.activate = () => testMaintenance();
        menu.menu.addMenuItem(maintenance);
    }
    settings.addMenuItem(menu);
    return menu;
}
