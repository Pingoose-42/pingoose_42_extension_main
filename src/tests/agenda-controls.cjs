const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
class Actor {
    constructor(props = {}) {
        Object.assign(this, props);
        this.children = [];
        this.clutter_text = {};
    }
    add_child(child) {
        this.children.push(child);
    }
    remove_all_children() {
        this.children = [];
    }
    set_style() {}
    connect(name, cb) {
        this[name] = cb;
    }
}
const menus = [];
class Menu {
    constructor() {
        this.actor = { hide() {} };
        this.actions = [];
        menus.push(this);
    }
    addAction(label, clicked) {
        this.actions.push({ label, clicked });
    }
    toggle() {
        this.open = !this.open;
    }
    close() {
        this.open = false;
    }
    destroy() {}
}
const ctx = {
    imports: {
        gi: {
            Meta: { LaterType: { BEFORE_REDRAW: 1 }, later_remove() {} },
            GLib: { SOURCE_REMOVE: false },
            Clutter: {
                RequestMode: { HEIGHT_FOR_WIDTH: 0 },
                ActorAlign: { END: 1, CENTER: 2, START: 3 },
            },
            Pango: { EllipsizeMode: { NONE: 0 }, WrapMode: { WORD_CHAR: 1 } },
            St: { Side: { TOP: 0 }, BoxLayout: Actor, Label: Actor, Button: Actor },
        },
        ui: {
            main: { uiGroup: { add_child() {} } },
            popupMenu: { PopupBaseMenuItem: Actor, PopupMenu: Menu },
        },
    },
};
ctx.imports.misc = {
    extensionUtils: {
        getCurrentExtension: () => ({
            imports: { models: { agenda: require('../models/agenda.js') } },
        }),
    },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('src/ui/agenda.js', 'utf8'), ctx);
const p = Object.create(ctx.Controller.prototype),
    section = {
        items: [],
        removeAll() {
            this.items = [];
        },
        addMenuItem(item) {
            this.items.push(item);
        },
    };
p._indicator = {
    agenda: section,
    menu: {
        connect() {
            return 1;
        },
        disconnect() {},
    },
};
p._optionsManager = { addMenu() {}, removeMenu() {} };
p._syncOptionalSections = () => {};
p._bridge = { send: (command) => (p.sent = command) };
const row = {
    id: '1',
    name: 'Event',
    begin: new Date().toISOString(),
    end: new Date().toISOString(),
};
p._agenda = [row];
p._agendaAll = [row];
function all(actor) {
    return [actor, ...(actor.children || []).flatMap(all)];
}
function click(label) {
    const button = section.items.flatMap(all).find((actor) => actor.label === label);
    assert(button, label);
    button.clicked();
}

let saved = [];
p._settings = { set_strv: (_key, ids) => (saved = [...ids]), get_strv: () => saved };
function hide() {
    click('⋮');
    const menu = menus.at(-1);
    assert.equal(menu.open, true);
    menu.actions.find((a) => a.label === 'Hide Agenda').clicked();
}
p._renderAgenda();
hide();
assert.equal(p._agenda.length, 0);
assert.deepEqual(saved, ['1']);
assert.equal(section.items.length, 0, 'no title or footer after last deletion');
// Replay the actual incoming server snapshot handler, including a restart.
const handle = p.onAgendaMessage;
p._onSnapshot = () => {};
p._dismissedAgendaIds = new Set(saved);
for (let i = 0; i < 3; i++) {
    handle.call(p, { type: 'agenda', rows: [row] });
    assert.equal(p._agenda.length, 0, 'server refresh cannot restore acknowledged agenda');
}
p._restoreAgenda();
assert.equal(p._agenda.length, 1);
assert.equal(saved.length, 0);
const testRow = { ...row, id: 'test:agenda', devTest: true };
p._agenda = [testRow];
p._agendaAll = [row, testRow];
p._renderAgenda();
hide();
handle.call(p, { type: 'agenda', rows: [row] });
assert(!p._agenda.some((item) => item.devTest), 'test agenda remains dismissed on refresh');
for (let i = 0; i < 3; i++) {
    p._restoreAgenda();
    handle.call(p, { type: 'agenda', rows: [row] });
    assert(!p._agenda.some((item) => item.devTest), 'reset must not restore deleted test cards');
    assert.equal(p._agenda[0].id, row.id, 'server agenda still restored');
}
assert(!section.items.flatMap(all).some((actor) => actor.label === 'Refresh'));
console.log(
    'PASS: options popup → Hide Agenda; persisted dismissal survives server refresh/restart; explicit reset restores cards; no footer Refresh'
);
const detail = {
    ...row,
    kind: 'exam',
    begin: new Date(Date.now() + 86400000).toISOString(),
    end: new Date(Date.now() + 90000000).toISOString(),
    description: 'Details from Intra',
    subscribers: 5,
    capacity: 100,
    subscribed: false,
};
p._agenda = [detail];
p._agendaAll = [detail];
p._renderAgenda();
const detailsBox = section.items
    .flatMap(all)
    .find((actor) => actor.style_class === 'pingoose-agenda-details');
assert.equal(detailsBox.visible, false);
const originalCard = section.items[0];
click('Details');
assert.equal(detailsBox.visible, true);
assert.equal(section.items[0], originalCard, 'toggling preserves card actors and focus');
assert(section.items.flatMap(all).some((actor) => actor.text === 'Details from Intra'));
assert(section.items.flatMap(all).some((actor) => actor.text === 'Registered: 5 / 100'));
click('Subscribe');
assert.equal(p.sent, 'agenda:subscribe:1');
assert.equal(p._agendaBusy, '1');
p._renderAgenda();
assert(section.items.flatMap(all).some((actor) => actor.label === 'Details'));
console.log(
    'PASS: details expand in card, show capacity/body, retain expansion and dispatch explicit subscription action'
);

p._agenda = [{ ...detail, subscribed: true }];
p._renderAgenda();
assert(section.items.flatMap(all).some((actor) => actor.text === 'Registered'));
assert(!section.items.flatMap(all).some((actor) => /You are .*subscribed/.test(actor.text || '')));
const body = section.items.flatMap(all).find((actor) => actor.text === 'Details from Intra');
assert.equal(body.clutter_text.ellipsize, 0);
assert(!section.items.flatMap(all).some((actor) => ['See more', 'See less'].includes(actor.label)));
assert.equal(body.height, undefined, 'full body has no preview height limit');
console.log('PASS: full description without preview controls or clipping');
p._agenda = [{ ...detail, subscribed: true, feedback: true }];
p._renderAgenda();
assert(section.items.flatMap(all).some((actor) => actor.text === 'Feedback required'));
assert(!section.items.flatMap(all).some((actor) => actor.text === 'Registered'));

let pending;
ctx.imports.gi.Meta.later_add = (_type, callback) => {
    pending = callback;
    return 1;
};
const adjustment = { value: 140, lower: 0, upper: 600, page_size: 280 };
p._indicator.agendaScroll = {
    get_vscroll_bar: () => ({ get_adjustment: () => adjustment }),
    grab_key_focus() {},
};
p._renderAgenda();
adjustment.value = 0;
pending();
assert.equal(adjustment.value, 140);
p._renderAgenda();
adjustment.upper = 320;
adjustment.value = 0;
pending();
assert.equal(adjustment.value, 40);
console.log('PASS: feedback badge priority and scroll restoration/clamping after rebuild');

assert(!section.items.flatMap(all).some((actor) => actor.label === 'Open in Intra'));
p._agenda = [{ ...detail, subscribed: true, subscriptionId: '99' }];
p._agendaBusy = null;
p._renderAgenda();
const footer = section.items
    .flatMap(all)
    .find((actor) => actor.style_class === 'pingoose-agenda-actions');
assert(footer);
assert(footer.children.some((actor) => actor.label === 'Unsubscribe'));
assert.equal(footer.y_expand, false);

p._agenda = [{ ...detail, description: 'Long exam description '.repeat(250) }];
p._renderAgenda();
const wrapped = section.items
    .flatMap(all)
    .filter((actor) => actor.clutter_text?.line_wrap && actor.text?.includes('Long exam'));
assert.equal(wrapped.length, 1);
assert.equal(wrapped[0].width, 392);
assert.equal(wrapped[0].request_mode, 0);
assert.equal(wrapped[0].y_expand, false);

let closed = 0;
p._indicator.menu.close = () => closed++;
for (const kind of ['event', 'exam']) {
    const pending = { ...detail, kind, feedback: true, name: 'Long agenda title '.repeat(10) };
    p._agenda = [pending];
    p._agendaExpanded.clear();
    p._renderAgenda();
    const actors = section.items.flatMap(all);
    const details = actors.find((actor) => actor.style_class === 'pingoose-agenda-details');
    const feedback = actors.find((actor) => actor.label === 'Write Feedback');
    assert(feedback, 'pending feedback needs a visible action, not only a badge');
    assert.equal(feedback.can_focus, true);
    assert.equal(details.visible, false);
    assert(!all(details).includes(feedback), 'feedback action must not be hidden inside Details');
    assert(!actors.some((actor) => actor.label === 'Visit Agenda Page'));
    click('Write Feedback');
    assert.match(p.sent, /^service:open:/);
    const page = JSON.parse(p.sent.slice('service:open:'.length));
    assert.equal(page.url, 'https://projects.intra.42.fr/events/1/feedbacks/new');
    assert(page.name.length <= 80, 'long agenda titles must fit the service window limit');
    assert.equal(p._agenda[0].feedback, true, 'opening the page must not mark feedback complete');
}
assert.equal(closed, 2);
handle.call(p, { type: 'agenda', rows: [{ ...detail, feedback: false }] });
assert(!section.items.flatMap(all).some((actor) => actor.label === 'Write Feedback'));
p._agenda = [{ ...detail, id: '1/../../other', feedback: true }];
p._renderAgenda();
assert(!section.items.flatMap(all).some((actor) => actor.label === 'Write Feedback'));
console.log(
    'PASS: visible feedback action opens the Intra feedback form; only server completion removes it'
);
