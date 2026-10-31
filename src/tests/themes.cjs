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
