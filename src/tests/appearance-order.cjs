const assert = require('node:assert/strict');
const fs = require('node:fs'),
    vm = require('node:vm');
const model = {};
vm.createContext(model);
vm.runInContext(fs.readFileSync('src/models/appearance.js', 'utf8'), model);
const order = Array.from(model.normalize(['chat', 'chat', 'invalid', 'profile']));
assert.equal(order[0], 'chat');
assert.equal(order[1], 'profile');
assert.equal(order.length, 8);
const box = {
    children: [],
    get_child_at_index(i) {
        return this.children[i];
    },
    set_child_at_index(actor, index) {
        this.children.splice(this.children.indexOf(actor), 1);
        this.children.splice(index, 0, actor);
    },
};
const actor = () => ({ visible: true, get_parent: () => box });
const names = [
    'profileItem',
    'profileSeparator',
    'overviewItem',
    'overviewSeparator',
    'slotsButtonItem',
    'slotsItem',
    'evaluationItem',
    'agendaItem',
    'notificationItem',
];
const indicator = { menu: { box } };
for (const name of names) indicator[name] = actor();
const toolbar = actor(),
    welcome = actor(),
    chat = actor(),
    services = actor();
indicator.toolbarItem = toolbar;
indicator.menu.moveMenuItem = (item, index) => box.set_child_at_index(item.actor || item, index);
box.children = [toolbar, ...names.map((name) => indicator[name]), chat, services, welcome];
const context = {
    imports: {
        misc: {
            extensionUtils: {
                getCurrentExtension: () => ({ imports: { models: { appearance: model } } }),
            },
        },
    },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('src/ui/visibility.js', 'utf8'), context);
const controller = new context.Controller();
Object.assign(controller, {
    _indicator: indicator,
    _settings: { get_strv: () => ['chat', 'slots', 'profile'] },
    _chatPanel: { _chatUi: { item: chat } },
    _servicePanel: { item: services },
});
controller._applySectionOrder();
assert.equal(box.children[0], toolbar);
assert.equal(box.children[1], chat);
assert.equal(box.children[2], indicator.slotsButtonItem);
assert.equal(box.children[3], indicator.slotsItem);
assert.equal(box.children.at(-1), welcome);
indicator.profileItem.visible = false;
controller._applySectionOrder();
assert.equal(indicator.profileSeparator.visible, false);
const snapshot = [...box.children];
controller._applySectionOrder();
assert.deepEqual(box.children, snapshot);
console.log(
    'PASS: order normalization, grouped slots, fixed toolbar, hidden separators, stable repeated updates'
);

// Exercise the real refresh entry point, not just the reorder helper.
for (const name of names) indicator[name].actor = indicator[name];
indicator.projectsColumn = {};
indicator.studyColumn = {};
controller._chatPanel.sync = () => {};
controller._servicePanel.sync = () => {};
controller._updatePanelLabel = () => {};
let layoutUpdates = 0;
controller._layoutManager = { applyPanelLayout: () => layoutUpdates++ };
controller._settings = {
    get_strv: () => ['services', 'slots', 'profile'],
    get_boolean: () => true,
};
controller._syncOptionalSections();
assert.equal(box.children[1], services, 'refresh must apply saved order');
assert.equal(box.children[2], indicator.slotsButtonItem);
assert.equal(box.children[3], indicator.slotsItem);
assert.equal(layoutUpdates, 1, 'refresh must also update panel spacing');
console.log('PASS: main-page refresh invokes ordering and spacing updates');
