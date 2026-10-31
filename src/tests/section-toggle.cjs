const assert = require('node:assert/strict'),
    fs = require('node:fs'),
    vm = require('node:vm');
class Actor {
    constructor(props) {
        Object.assign(this, props);
    }
    set_child(child) {
        this.child = child;
    }
    get_child() {
        return this.child;
    }
    connect(name, fn) {
        this[name] = fn;
    }
}
const source = fs.readFileSync('src/ui/indicator.js', 'utf8');
const CountLabel = {
    update(label, title, count) {
        label.text = title + (count ? ' · ' + count : '');
    },
};
const context = {
    CountLabel,
    imports: {
        misc: {
            extensionUtils: { getSettings: () => ({ get_boolean: () => true, set_boolean() {} }) },
        },
    },
    St: { Button: Actor, Label: Actor },
    Clutter: { ActorAlign: { CENTER: 0 } },
};
vm.createContext(context);
vm.runInContext(
    'var Probe=class {' +
        source.slice(source.indexOf('    _sectionToggle('), source.indexOf('    _initFlapIcon()')) +
        '}',
    context
);
for (const title of ['Agenda', 'Evaluation Info', 'Notifications']) {
    const content = {
            visible: true,
            setExpanded(value) {
                this.visible = value;
            },
        },
        button = new context.Probe()._sectionToggle(title, content);
    button.updateCount(3);
    assert.equal(button.get_child().text, title + ' · 3');
    assert.match(button.style_class, /pingoose-toggle-active/);
    button.clicked();
    assert.equal(content.visible, false);
    assert(!button.style_class.includes('pingoose-toggle-active'));
    button.updateCount(5);
    assert.equal(content.visible, false);
    assert.equal(button.get_child().text, title + ' · 5');
    button.clicked();
    assert.equal(content.visible, true);
    button.updateCount(0);
    assert.equal(button.get_child().text, title);
}
console.log('PASS: section counts update without reopening collapsed sections; zero count omitted');
