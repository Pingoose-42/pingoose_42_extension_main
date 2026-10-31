const assert = require('node:assert/strict');
const { Signals, controller: loadController } = require('./helpers.cjs');

class Actor extends Signals {
    constructor(name, reactive = true) {
        super();
        Object.assign(this, {
            name,
            reactive,
            visible: true,
            mapped: true,
            children: [],
            calls: [],
        });
    }
    add_child(actor) {
        actor.parent = this;
        this.children.push(actor);
        return actor;
    }
    get_parent() {
        return this.parent || null;
    }
    contains(actor) {
        for (let current = actor; current; current = current.parent)
            if (current === this) return true;
        return false;
    }
    set_child_below_sibling(actor, sibling) {
        this.children.splice(this.children.indexOf(actor), 1);
        this.children.splice(this.children.indexOf(sibling), 0, actor);
    }
    raise(actor) {
        this.children.splice(this.children.indexOf(actor), 1);
        this.children.push(actor);
    }
    event(event, capture) {
        const phase = capture ? 'capture' : 'bubble';
        this.calls.push([event.type(), phase]);
        event.path.push(`${this.name}:${phase}`);
        if (this.handler?.(event, capture)) return true;
        for (const signal of [...this.signals.values()]) {
            if (signal.name === (capture ? 'captured-event' : 'event')) {
                if (signal.callback(this, event)) return true;
            }
        }
        return false;
    }
}
class Text extends Actor {
    constructor(name, editable = true) {
        super(name);
        this.editable = editable;
    }
    get_editable() {
        return this.editable;
    }
}
const Clutter = {
    Text,
    EVENT_STOP: true,
    EVENT_PROPAGATE: false,
    EventType: {
        BUTTON_PRESS: 1,
        BUTTON_RELEASE: 2,
        SCROLL: 3,
        KEY_PRESS: 4,
        KEY_RELEASE: 5,
        MOTION: 6,
        ENTER: 7,
        LEAVE: 8,
    },
};
const event = (type, target) => ({ type: () => Clutter.EventType[type], target, path: [] });

function fixture(options = {}) {
    const group = new Actor('uiGroup');
    const windows = group.add_child(new Actor('windows'));
    const chrome = group.add_child(new Actor('chrome'));
    const top = group.add_child(new Actor('nativePopups'));
    const modal = group.add_child(new Actor('modal'));
    const keyboard = group.add_child(new Actor('keyboard'));
    const popup = group.add_child(new Actor('candidate', false));
    const screenshot = group.add_child(new Actor('screenshot'));
    const menu = Object.assign(new Signals(), {
        isOpen: false,
        actor: group.add_child(new Actor('menu')),
    });
    const focus = menu.actor.add_child(new Text('editor'));
    const area = popup.add_child(new Actor('area'));
    const item = area.add_child(new Actor('item'));
    const label = item.add_child(new Actor('label', false));
    const pager = area.add_child(new Actor('pager'));
    const pagerLabel = pager.add_child(new Actor('pagerLabel', false));
    const stage = {
        focus,
        grab: menu.actor,
        get_key_focus() {
            return this.focus;
        },
        get_grab_actor() {
            return this.grab;
        },
        get_event_actor: (event) => event.target,
    };
    const manager = { _candidatePopup: popup };
    const misc = options.misc || { ibusManager: { getIBusManager: () => manager } };
    const globals = { stage, top_window_group: top };
    const layoutManager = { keyboardBox: keyboard };
    const Controller = loadController('ui/inputMethodPopup.js', {
        imports: { gi: { Clutter }, misc, ui: { main: { layoutManager } } },
        global: globals,
    });
    const controller = new Controller(menu);
    let outsidePresses = 0;
    // Shell installs this after Layout constructs the input-method controller.
    menu.actor.connect('captured-event', (_actor, event) => {
        if (event.type() === Clutter.EventType.BUTTON_PRESS && !menu.actor.contains(event.target))
            outsidePresses++;
        return false;
    });
    const open = () => {
        menu.isOpen = true;
        group.raise(menu.actor); // PopupMenu.open's built-in stacking behavior.
        menu.emit('open-state-changed', true);
    };
    // Match Mutter's grab-root routing: outside the grab's tree, only the
    // grabbed actor receives capture/bubble. Inside it, dispatch ancestry.
    const dispatch = (event) => {
        const root = stage.grab;
        if (!root.contains(event.target)) {
            if (root.event(event, true)) return true;
            return root.event(event, false);
        }
        const path = [];
        for (let current = event.target; current; current = current.parent) {
            if (current.reactive) path.push(current);
            if (current === root) break;
        }
        for (let i = path.length - 1; i >= 0; i--) if (path[i].event(event, true)) return true;
        for (const actor of path) if (actor.event(event, false)) return true;
        return false;
    };
    return {
        group,
        windows,
        chrome,
        top,
        modal,
        keyboard,
        popup,
        screenshot,
        menu,
        focus,
        area,
        item,
        label,
        pager,
        pagerLabel,
        stage,
        manager,
        misc,
        globals,
        layoutManager,
        controller,
        open,
        dispatch,
        outsidePresses: () => outsidePresses,
    };
}

const f = fixture();
const foreignOrder = f.group.children.filter((actor) => actor !== f.menu.actor);
for (let reopen = 0; reopen < 2; reopen++) {
    f.open();
    assert.equal(f.group.children.indexOf(f.menu.actor) + 1, f.group.children.indexOf(f.top));
    assert.deepEqual(
        f.group.children.filter((actor) => actor !== f.menu.actor),
        foreignOrder
    );
    assert.ok(f.group.children.indexOf(f.menu.actor) > f.group.children.indexOf(f.windows));
    f.menu.isOpen = false;
    f.menu.emit('open-state-changed', false);
}
f.globals.top_window_group = new Actor('unrelatedTop');
f.open();
assert.equal(f.group.children.indexOf(f.menu.actor) + 1, f.group.children.indexOf(f.keyboard));
f.layoutManager.keyboardBox = new Actor('unrelatedKeyboard');
f.open();
assert.equal(f.group.children.at(-1), f.menu.actor, 'unrelated parents are never reordered');
delete f.globals.top_window_group;
delete f.layoutManager.keyboardBox;
assert.doesNotThrow(f.open, 'missing Shell anchors are harmless');
console.log(
    'PASS: popup layer restored on reopen, native popup precedence, fallback and parent guards'
);

let selected = 0;
f.item.handler = (event, capture) => {
    if (!capture && event.type() === Clutter.EventType.BUTTON_RELEASE) selected++;
    return false; // GNOME's candidate item handler propagates.
};
const press = event('BUTTON_PRESS', f.label);
assert.equal(f.dispatch(press), true);
assert.equal(f.outsidePresses(), 0, 'candidate press never reaches outside-click dismissal');
assert.deepEqual(press.path, [
    'menu:capture',
    'area:capture',
    'item:capture',
    'item:bubble',
    'area:bubble',
]);
assert.equal(f.dispatch(event('BUTTON_RELEASE', f.label)), true);
assert.equal(selected, 1, 'candidate label reaches item exactly once');
let scrolled = 0;
f.area.handler = (event, capture) => {
    if (!capture && event.type() === Clutter.EventType.SCROLL) scrolled++;
    return false;
};
assert.equal(f.dispatch(event('SCROLL', f.label)), true);
assert.equal(scrolled, 1, 'candidate scroll bubbles to CandidateArea exactly once');
f.area.handler = (_event, capture) => capture;
const captured = event('BUTTON_RELEASE', f.label);
assert.equal(f.dispatch(captured), true);
assert.deepEqual(captured.path, ['menu:capture', 'area:capture']);
assert.equal(selected, 1, 'capture stop prevents item activation');
f.area.handler = null;
console.log(
    'PASS: candidate capture/bubble path delivers label clicks and ancestor scroll exactly once'
);

let pagerClicks = 0;
f.pager.handler = (event, capture) => {
    if (capture) return false;
    if (event.type() === Clutter.EventType.BUTTON_PRESS) {
        f.stage.grab = f.pager;
        return true;
    }
    if (event.type() === Clutter.EventType.BUTTON_RELEASE) {
        pagerClicks++;
        f.stage.grab = f.menu.actor;
        return true;
    }
    return false;
};
assert.equal(f.dispatch(event('BUTTON_PRESS', f.pagerLabel)), true);
assert.equal(f.stage.grab, f.pager);
assert.equal(f.controller._capture(event('BUTTON_RELEASE', f.pagerLabel)), false);
assert.equal(f.dispatch(event('BUTTON_RELEASE', f.pagerLabel)), true);
assert.equal(pagerClicks, 1);
assert.equal(f.stage.grab, f.menu.actor, 'native pager release restores the existing menu grab');

f.item.handler = (event, capture) => {
    if (!capture) assert.equal(f.controller._capture(event), false, 'forwarding cannot recurse');
    return !capture;
};
const consumed = event('BUTTON_RELEASE', f.label);
assert.equal(f.dispatch(consumed), true);
assert.deepEqual(consumed.path, ['menu:capture', 'area:capture', 'item:capture', 'item:bubble']);
console.log(
    'PASS: candidate button grabs remain native; handled events and reentry do not duplicate'
);

const propagate = (type, target = f.label) => {
    const e = event(type, target);
    assert.equal(f.controller._capture(e), false);
    assert.deepEqual(e.path, [], 'ignored events are not forwarded');
};
for (const type of ['KEY_PRESS', 'KEY_RELEASE', 'MOTION', 'ENTER', 'LEAVE']) propagate(type);
propagate('BUTTON_PRESS', f.screenshot);
propagate('SCROLL', f.focus);
assert.equal(f.dispatch(event('BUTTON_PRESS', f.chrome)), false);
assert.equal(f.outsidePresses(), 1, 'outside dismissal remains owned by PopupMenuManager');
for (const focus of [null, new Text('external'), f.menu.actor, new Text('readonly', false)]) {
    if (focus?.name === 'readonly') f.menu.actor.add_child(focus);
    f.stage.focus = focus;
    propagate('BUTTON_RELEASE');
}
f.stage.focus = f.focus;
for (const grab of [null, new Actor('resize'), new Actor('otherModal')]) {
    f.stage.grab = grab;
    propagate('BUTTON_RELEASE');
}
f.stage.grab = f.menu.actor;
f.popup.visible = false;
propagate('BUTTON_RELEASE');
f.popup.visible = true;
f.popup.mapped = false;
propagate('SCROLL');
f.popup.mapped = true;
f.menu.isOpen = false;
propagate('BUTTON_RELEASE');
f.menu.isOpen = true;
f.manager._candidatePopup = new Actor('replacement');
propagate('BUTTON_RELEASE');
f.manager._candidatePopup = null;
propagate('BUTTON_RELEASE');
for (const misc of [
    {},
    {
        ibusManager: {
            getIBusManager() {
                throw Error('IBus unavailable');
            },
        },
    },
]) {
    const absent = fixture({ misc });
    absent.open();
    assert.equal(absent.controller._capture(event('BUTTON_PRESS', absent.label)), false);
    absent.controller.destroy();
}
console.log(
    'PASS: editor focus, current grab, candidate visibility/identity and optional IBus are guarded'
);

const candidateSignals = f.popup.signals.size;
f.controller.destroy();
f.controller.destroy();
assert.equal(f.menu.signals.size, 0);
assert.equal(f.menu.actor.signals.size, 1, 'only the controller capture handler is disconnected');
assert.equal(f.popup.signals.size, candidateSignals, 'no Shell candidate signals are modified');
f.globals.top_window_group = f.top;
f.layoutManager.keyboardBox = f.keyboard;
f.open();
assert.equal(f.group.children.at(-1), f.menu.actor, 'destroyed controller no longer restacks');
propagate('BUTTON_RELEASE');
console.log('PASS: teardown removes only owned handlers and is safe to repeat');
