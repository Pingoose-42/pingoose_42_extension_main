const assert = require('node:assert/strict');
const { Actor, Signals, controller } = require('./helpers.cjs');
class Item extends Actor {
    remove_all_children() {
        this.children = [];
    }
}
const shown = [];
let archive = null;
let flashes = 0;
const settings = { 'notify-agenda': true, 'notify-agenda-immediate': false };
const Controller = controller('ui/notifications.js', {
    Clutter: { ActorAlign: { CENTER: 0, END: 1 } },
    GLib: { DateTime: { new_now_local: () => ({ format: () => '12:00' }) } },
    Pango: { WrapMode: { WORD_CHAR: 0 }, EllipsizeMode: { NONE: 0 } },
    St: { BoxLayout: Actor, Label: Actor, Button: Actor },
    PopupMenu: { PopupBaseMenuItem: Item },
    MessageTray: {
        Notification: class extends Signals {
            constructor(_source, title, body) {
                super();
                this.title = title;
                this.body = body;
                this.actions = [];
            }
            setTransient() {}
            addAction(label, callback) {
                this.actions.push({ label, callback });
            }
        },
    },
    imports: {
        misc: {
            extensionUtils: {
                getCurrentExtension: () => ({
                    imports: {
                        models: {
                            startReminders: require('../models/startReminders.js'),
                            agenda: require('../models/agenda.js'),
                        },
                        services: {
                            cardStore: {
                                read: () => archive,
                                write: (data) => (archive = JSON.parse(JSON.stringify(data))),
                            },
                        },
                        ui: {
                            screenFlash: {
                                Controller: class {
                                    show() {
                                        flashes++;
                                    }
                                },
                            },
                        },
                    },
                }),
            },
        },
    },
});
const commands = [];
let opened = 0;
let closed = 0;
const indicator = {
    menu: { isOpen: false, open: () => opened++, close: () => closed++ },
    cards: { removeAll() {}, addMenuItem() {} },
    count: {},
};
const panel = new Controller(
    indicator,
    { on: () => () => {}, send: (command) => commands.push(command) },
    { get_boolean: (key) => settings[key] === true },
    { notificationSettings: {} }
);
panel._bannerSource = { showNotification: (notice) => shown.push(notice) };
panel._showBanner({
    id: 'intrapy:1',
    body: 'You have been matched with someone.\nEvaluator · 10/23 14:00 · Libft',
});
assert.equal(shown.at(-1).title, 'New Evaluation Matched');
assert.equal(shown.at(-1).body, 'Evaluator · 10/23 14:00 · Libft');
panel._showBanner({
    id: 'agenda:1',
    category: 'agenda',
    body: 'New agenda event · Career Fair\n23/10/2026, 14:00',
});
assert.equal(shown.at(-1).title, 'New Agenda Event');
assert.match(shown.at(-1).body, /^Career Fair\n/);
assert.equal(shown.at(-1).actions.length, 0);
shown.at(-1).emit('activated');
assert.equal(opened, 1, 'ordinary banners still open the menu');

const feedback = {
    type: 'notification',
    id: 'agenda-feedback:1',
    category: 'agenda',
    title: 'Agenda feedback required',
    body: 'Feedback required · Career Fair\nPlease submit your feedback on Intra.',
};
panel.onNotificationMessage(feedback);
assert.equal(shown.length, 3, 'feedback banners do not depend on the new-agenda toggle');
assert.equal(shown.at(-1).title, 'Agenda feedback required');
assert.equal(shown.at(-1).body, feedback.body);
assert.equal(flashes, 1);
assert.equal(archive.notifications[0].title, feedback.title);
let card;
panel._renderNotificationCard(panel.notifications[0], {
    cards: { addMenuItem: (item) => (card = item) },
});
const actors = (actor) => [actor, ...actor.children.flatMap(actors)];
assert(actors(card).some((actor) => actor.text === '42 · Agenda feedback required'));
const feedbackButton = actors(card).find((actor) => actor.label === 'Write Feedback');
assert(feedbackButton, 'stored feedback cards need a direct action');
assert.equal(feedbackButton.can_focus, true);
assert.equal(shown.at(-1).actions.length, 1);
assert.equal(shown.at(-1).actions[0].label, 'Write Feedback');
shown.at(-1).actions[0].callback();
shown.at(-1).emit('activated');
feedbackButton.emit('clicked');
assert.equal(commands.length, 3);
assert.equal(closed, 3);
for (const command of commands) {
    assert.match(command, /^service:open:/);
    assert.equal(
        JSON.parse(command.slice('service:open:'.length)).url,
        'https://projects.intra.42.fr/events/1/feedbacks/new'
    );
}
assert.equal(panel.notifications.length, 1, 'opening feedback must not dismiss the card');
panel.onNotificationMessage(feedback);
assert.equal(shown.length, 3);
panel.clear();
panel.restoreCardState();
panel.onNotificationMessage(feedback);
assert.equal(shown.length, 3, 'restored feedback cards must not redisplay a banner');
assert.equal(panel.notifications.length, 1);

settings['notify-agenda'] = false;
panel.onNotificationMessage({ ...feedback, id: 'agenda-feedback:2' });
assert.equal(panel.notifications.length, 2, 'muting system notifications still saves the card');
assert.equal(shown.length, 3);
assert.equal(flashes, 1);
settings['notify-agenda'] = true;
panel.onNotificationMessage({
    type: 'notification',
    id: 'agenda:3',
    category: 'agenda',
    body: 'New agenda event · Another event',
});
assert.equal(panel.notifications.length, 3);
assert.equal(shown.length, 3, 'the new-agenda toggle still suppresses new-event banners');
panel.clear();
panel.restoreCardState();
const restored = panel.notifications.find(
    (notification) => notification.id === 'agenda-feedback:2'
);
panel._renderNotificationCard(restored, { cards: { addMenuItem: (item) => (card = item) } });
actors(card)
    .find((actor) => actor.label === 'Write Feedback')
    .emit('clicked');
assert.equal(
    JSON.parse(commands.at(-1).slice('service:open:'.length)).url,
    'https://projects.intra.42.fr/events/2/feedbacks/new'
);

// Old routing metadata must not send restored feedback back to an agenda detail page.
const legacy = { ...feedback, agendaKind: 'exam' };
panel._renderNotificationCard(legacy, { cards: { addMenuItem: (item) => (card = item) } });
actors(card)
    .find((actor) => actor.label === 'Write Feedback')
    .emit('clicked');
assert.equal(
    JSON.parse(commands.at(-1).slice('service:open:'.length)).url,
    'https://projects.intra.42.fr/events/1/feedbacks/new'
);
for (const invalid of [
    { ...feedback, id: 'agenda-feedback:1/../../other' },
    { ...feedback, id: `agenda-feedback:${'1'.repeat(129)}` },
    { ...feedback, category: 'evaluation' },
    { ...feedback, id: 'agenda:1' },
]) {
    panel._renderNotificationCard(invalid, { cards: { addMenuItem: (item) => (card = item) } });
    assert(!actors(card).some((actor) => actor.label === 'Write Feedback'));
    panel._showBanner(invalid);
    assert.equal(shown.at(-1).actions.length, 0);
}
console.log(
    'PASS: feedback buttons and banner activation open the form directly; restored links, validation, mute and dedup preserved'
);
