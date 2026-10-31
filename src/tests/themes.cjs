const assert = require('node:assert/strict');
const fs = require('node:fs');
const { controller: loadController, moduleExport } = require('./helpers.cjs');

const themes = moduleExport(
    'models/themes.js',
    '({ choices, normalize, styleClasses, backgroundStyle, applyClasses })'
);
const ids = themes.choices.map(([id]) => id);
const schemes = { dark: 'dark', light: 'light', pink: 'light', halloween: 'dark', neon: 'dark' };
const actor = {
    classes: new Set(['popup-menu', 'pingoose-panel-host']),
    opacity: 173,
    add_style_class_name(name) {
        this.classes.add(name);
    },
    remove_style_class_name(name) {
        this.classes.delete(name);
    },
};
for (const previous of ids) {
    for (const next of ids) {
        themes.applyClasses(actor, previous);
        themes.applyClasses(actor, next);
        assert.deepEqual(
            actor.classes,
            new Set([
                'popup-menu',
                'pingoose-panel-host',
                `pingoose-${schemes[next]}`,
                `pingoose-${next}`,
            ]),
            `${previous} → ${next} must remove the old palette and keep the correct base scheme`
        );
    }
}
assert.equal(actor.opacity, 173, 'palette changes must not interfere with actor animations');
for (const invalid of ['', 'unknown', '__proto__', null]) {
    assert.equal(themes.normalize(invalid), 'dark');
    themes.applyClasses(actor, invalid);
    assert.deepEqual(
        actor.classes,
        new Set(['popup-menu', 'pingoose-panel-host', 'pingoose-dark'])
    );
}
console.log('PASS: all theme transitions replace palette classes and preserve layout classes');

const colors = {
    dark: [35, 39, 45],
    light: [246, 247, 249],
    pink: [255, 241, 246],
    halloween: [33, 26, 38],
    neon: [16, 27, 36],
};
for (const id of ids) {
    for (const [percent, alpha] of [
        [0, '1.00'],
        [35, '0.65'],
        [80, '0.20'],
    ]) {
        assert.equal(
            themes.backgroundStyle(id, percent),
            `background-color: rgba(${colors[id].join(', ')}, ${alpha});`
        );
    }
}
for (const value of [-10, NaN, undefined, Infinity])
    assert.equal(themes.backgroundStyle('light', value), themes.backgroundStyle('light', 0));
assert.equal(themes.backgroundStyle('pink', 120), themes.backgroundStyle('pink', 80));
assert.equal(themes.backgroundStyle('missing', 30), themes.backgroundStyle('dark', 30));
console.log(
    'PASS: solid default, independent palette backgrounds, transparency bounds and fallback'
);

const Settings = loadController('ui/settings.js', {
    imports: {
        misc: {
            extensionUtils: { getCurrentExtension: () => ({ imports: { models: { themes } } }) },
        },
    },
});
const controller = Object.create(Settings.prototype);
let theme = 'dark';
let transparency = 0;
let background;
controller._indicator = { menu: { actor } };
controller._settings = {
    get_string: (key) => {
        assert.equal(key, 'theme');
        return theme;
    },
    get_int: (key) => {
        assert.equal(key, 'panel-transparency');
        return transparency;
    },
};
controller._layout = {
    applyPanelAppearance: (value) => {
        background = value;
    },
};
for (const id of ids) {
    theme = id;
    transparency = 42;
    controller._applyTheme();
    assert.equal(background, themes.backgroundStyle(id, 42));
    assert.ok(actor.classes.has(`pingoose-${id}`));
    assert.equal(actor.opacity, 173);
    transparency = 0;
    controller._applyTheme();
    assert.equal(background, themes.backgroundStyle(id, 0));
}
console.log(
    'PASS: settings applies palette and background transparency together without fading content'
);

// Verify the literal palette declarations, not a simulated St renderer. This
// catches CSS/model drift and unreadable field colors without a Shell session.
const css = fs.readFileSync('src/stylesheet.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1].split(',').map((selector) => selector.trim()),
    values: Object.fromEntries(
        [...match[2].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(([, property, value]) => [
            property,
            value.trim(),
        ])
    ),
}));
function declarations(selector) {
    return Object.assign(
        {},
        ...rules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.values)
    );
}
function rgb(hex) {
    assert.match(hex, /^#[0-9a-f]{6}$/i, 'explicit opaque field colors are required');
    return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
}
function luminance(hex) {
    return rgb(hex)
        .map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
function readable(foreground, background, label) {
    const a = luminance(foreground),
        b = luminance(background);
    const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    assert.ok(contrast >= 4.5, `${label}: ${contrast.toFixed(2)}:1 must be at least 4.5:1`);
}
for (const id of ids) {
    const scope = '.' + Array.from(themes.styleClasses(id)).join('.');
    const panel = declarations(`${scope} .popup-menu-content`);
    const side = declarations(`${scope} .pingoose-chat-panel`);
    assert.deepEqual(
        rgb(panel['background-color']),
        colors[id],
        `${id}: main CSS/runtime palette matches`
    );
    assert.deepEqual(
        rgb(side['background-color']),
        colors[id],
        `${id}: side CSS/runtime palette matches`
    );
    const field = declarations(`${scope} StEntry`);
    const hint = declarations(`${scope} StEntry StLabel.hint-text`);
    for (const state of ['', ':hover', ':focus', ':insensitive']) {
        const current = { ...field, ...declarations(`${scope} StEntry${state}`) };
        readable(current.color, current['background-color'], `${id} ${state} field text`);
        const hintColor =
            declarations(`${scope} StEntry${state} StLabel.hint-text`).color || hint.color;
        readable(hintColor, current['background-color'], `${id} ${state} hint`);
        if (schemes[id] === 'light')
            assert.ok(
                luminance(current['background-color']) > 0.65,
                `${id} must retain a light field`
            );
    }
    readable(
        field['selected-color'],
        field['selection-background-color'],
        `${id} selected entry text`
    );
    const message = declarations(`${scope} .pingoose-chat-text`);
    readable(
        message['selected-color'],
        message['selection-background-color'],
        `${id} selected message text`
    );
}
console.log(
    'PASS: CSS/runtime background colors match; field, hint and selected text retain contrast'
);

// Resolve our stylesheet's type/class/pseudo selectors, including descendant
// and child relationships. Source order alone misses selected-state rules that
// outrank a later hover/disabled declaration. This checks the static cascade;
// it does not pretend to render St or include the user's system stylesheet.
function compoundMatches(selector, node) {
    assert.match(selector, /^(?:[\w-]+)?(?:[.:][\w-]+)*$/);
    const type = selector.match(/^[\w-]+/)?.[0];
    return (
        (!type || type === node.type) &&
        [...selector.matchAll(/([.:])([\w-]+)/g)].every(([, kind, name]) =>
            (kind === '.' ? node.classes : node.states).includes(name)
        )
    );
}
function selectorMatches(selector, nodes) {
    const parts = selector.split(/\s+/);
    function matches(part, node) {
        if (node < 0 || !compoundMatches(parts[part], nodes[node])) return false;
        if (part === 0) return true;
        if (parts[part - 1] === '>') return matches(part - 2, node - 1);
        for (let parent = node - 1; parent >= 0; parent--)
            if (matches(part - 1, parent)) return true;
        return false;
    }
    return matches(parts.length - 1, nodes.length - 1);
}
function buttonColors(id, classes, states) {
    const nodes = [
        { type: 'StBoxLayout', classes: Array.from(themes.styleClasses(id)), states: [] },
        { type: 'StBoxLayout', classes: ['pingoose-chat-panel'], states: [] },
        { type: 'StButton', classes, states },
    ];
    const values = {},
        priorities = {};
    for (const rule of rules) {
        for (const selector of rule.selectors) {
            if (!selectorMatches(selector, nodes)) continue;
            const priority = [
                (selector.match(/[.:][\w-]+/g) || []).length,
                (selector.match(/(?:^|\s)[A-Za-z][\w-]*/g) || []).length,
            ];
            for (const [property, value] of Object.entries(rule.values)) {
                const previous = priorities[property];
                if (
                    !previous ||
                    priority[0] > previous[0] ||
                    (priority[0] === previous[0] && priority[1] >= previous[1])
                ) {
                    values[property] = value;
                    priorities[property] = priority;
                }
            }
        }
    }
    return values;
}
const controlColors = {
    dark: ['#315a56', '#3d6c65', '#edf0f4', '#85d6cb', '#173c36', '#2d343c', '#aab6c2'],
    light: ['#c5e5df', '#a8d8cf', '#174e45', '#16796b', '#ffffff', '#e2e7eb', '#596673'],
    pink: ['#eab9ce', '#dc97b6', '#452538', '#9e315f', '#ffffff', '#eed8e2', '#79556a'],
    halloween: ['#65462e', '#79573a', '#fff0df', '#ffb86b', '#27150a', '#3c3042', '#c9b5cd'],
    neon: ['#1d5e60', '#286f73', '#e2faff', '#64f4da', '#09252a', '#243b49', '#aac6d1'],
};
const controlClasses = [
    'pingoose-dismiss',
    'pingoose-chat-chip-close',
    'pingoose-chat-add', // Favorites star, new-chat button and favorites panel X.
    'pingoose-favorite-action',
];
for (const id of ids) {
    const [hover, pressed, foreground, accent, accentText, disabled, disabledText] =
        controlColors[id];
    for (const control of controlClasses) {
        const toggle = ['pingoose-chat-add', 'pingoose-favorite-action'].includes(control);
        for (const selected of toggle ? [false, true] : [false]) {
            const classes = [control, ...(selected ? ['pingoose-toggle-active'] : [])];
            // Include overlapping pointer/key states, not only isolated :hover.
            for (let mask = 0; mask < 8; mask++) {
                const states = ['hover', 'focus', 'active'].filter((_, bit) => mask & (1 << bit));
                const label = `${id} ${classes.join('.')} ${states.join(':')}`;
                if (selected || states.length) {
                    const current = buttonColors(id, classes, states);
                    const active = states.includes('active');
                    const expected =
                        active && selected
                            ? accent
                            : active || (selected && mask)
                              ? pressed
                              : hover;
                    const text = active && selected ? accentText : foreground;
                    assert.equal(current['background-color'], expected, `${label} background`);
                    assert.equal(current.color, text, `${label} foreground`);
                    readable(text, expected, label);
                }
                const insensitive = buttonColors(id, classes, [...states, 'insensitive']);
                assert.equal(
                    insensitive['background-color'],
                    disabled,
                    `${label} disabled background`
                );
                assert.equal(insensitive.color, disabledText, `${label} disabled foreground`);
                readable(disabledText, disabled, `${label} disabled`);
            }
        }
    }
}
console.log(
    'PASS: all five close/favorite palettes resolve hover, focus, active, selected and disabled combinations'
);

const warningColors = {
    dark: ['#ef6464', '#ff6464', '#d94141', '#e5484d'],
    light: ['#b62343', '#c92c36', '#d94141', '#e5484d'],
    pink: ['#b62343', '#b62343', '#b62343', '#b62343'],
    halloween: ['#ff9696', '#ff9696', '#ff9696', '#ff9696'],
    neon: ['#ff9db4', '#ff9db4', '#ff9db4', '#ff9db4'],
};
for (const id of ids) {
    const [unsubscribe, error, failure, badge] = warningColors[id];
    for (const states of [[], ['hover'], ['focus'], ['active'], ['hover', 'focus', 'active']]) {
        assert.equal(
            buttonColors(id, ['pingoose-clear-button', 'pingoose-agenda-unsubscribe'], states)
                .color,
            unsubscribe
        );
        assert.equal(
            buttonColors(id, ['pingoose-chat-status', 'pingoose-chat-status-err'], states).color,
            error
        );
        assert.equal(
            buttonColors(id, ['pingoose-maintenance-failure'], states)['background-color'],
            failure
        );
        assert.equal(buttonColors(id, ['pingoose-chat-badge'], states)['background-color'], badge);
    }
}
console.log(
    'PASS: unsubscribe, error, maintenance failure and unread badge retain their warning colors'
);
