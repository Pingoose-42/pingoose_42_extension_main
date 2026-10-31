const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Signals, controller, moduleExport } = require('./helpers.cjs');
const themes = moduleExport('models/themes.js', '({ choices, styleClasses, chatBackgroundStyle })');
const Appearance = controller('ui/chatAppearance.js', {
    imports: {
        misc: {
            extensionUtils: { getCurrentExtension: () => ({ imports: { models: { themes } } }) },
        },
    },
});
class Surface extends Signals {
    constructor(style = null) {
        super();
        this.style = style;
        this.states = new Set();
        this.opacity = 187;
        this.writes = 0;
    }
    get_style() {
        return this.style;
    }
    set_style(style) {
        this.style = style;
        this.writes++;
        assert.ok(this.writes < 100, 'style changes must not recursively rewrite themselves');
        this.emit('style-changed');
    }
    has_style_pseudo_class(state) {
        return this.states.has(state);
    }
    state(...states) {
        this.states = new Set(states);
        this.emit('style-changed');
    }
    destroy() {
        this.emit('destroy');
        this.signals.clear();
    }
}
const settings = Object.assign(new Signals(), {
    theme: 'neon',
    transparency: 50,
    get_string() {
        return this.theme;
    },
    get_int() {
        return this.transparency;
    },
});
const appearance = new Appearance(settings);
const log = new Surface('min-height: 0; max-height: 4096px;');
const entry = new Surface();
const bubble = new Surface();
const preview = new Surface();
for (const [surface, role] of [
    [log, 'log'],
    [entry, 'entry'],
    [bubble, 'outgoing'],
    [preview, 'preview'],
])
    appearance.track(surface, role);
assert.match(log.style, /rgba\(11, 21, 30, 0.500\)/);
assert.match(log.style, /min-height: 0; max-height: 4096px;/);
entry.state('hover');
assert.match(entry.style, /rgba\(19, 38, 51, 0.500\)/);
entry.state('focus');
assert.match(entry.style, /rgba\(19, 38, 51, 0.500\)/);
entry.state('focus', 'hover', 'insensitive');
assert.match(entry.style, /rgba\(36, 59, 73, 0.500\)/);

// Resizing may replace the ScrollView inline style with a cached style.
log.set_style('min-height: 0; max-height: 4096px; background-color: rgba(0, 0, 0, 0.1);');
assert.match(log.style, /rgba\(11, 21, 30, 0.500\)/);
assert.match(log.style, /max-height: 4096px/);
settings.theme = 'pink';
settings.emit('changed::theme');
assert.match(log.style, /rgba\(246, 223, 233, 0.500\)/);
assert.match(entry.style, /rgba\(238, 216, 226, 0.500\)/);
assert.match(bubble.style, /rgba\(158, 49, 95, 0.500\)/);
assert.match(preview.style, /rgba\(246, 223, 233, 0.500\)/);
const writes = log.writes;
appearance.sync();
assert.equal(log.writes, writes, 'unchanged appearance does not queue another relayout');
for (const surface of [log, entry, bubble, preview]) assert.equal(surface.opacity, 187);

// Returning to opaque mode releases backgrounds back to normal CSS state rules.
settings.transparency = 0;
settings.emit('changed::panel-transparency');
assert.equal(log.style, 'min-height: 0; max-height: 4096px;');
assert.equal(entry.style, null);
assert.equal(bubble.style, null);
const custom = new Surface('padding: 4px; background-color: #123456;');
appearance.track(custom, 'incoming');
settings.transparency = 80;
settings.emit('changed::panel-transparency');
assert.match(custom.style, /rgba\(255, 255, 255, 0.200\)/);
const beforeDestroy = appearance.records.size;
bubble.destroy();
assert.equal(appearance.records.size, beforeDestroy - 1, 'removed chat rows release records');
appearance.destroy();
assert.equal(custom.style, 'padding: 4px; background-color: #123456;');
assert.equal(settings.signals.size, 0);
assert.equal(entry.signals.size, 0);
assert.equal(appearance.records.size, 0);
console.log(
    'PASS: live chat transparency retains input states, sizing, text/image opacity and cleanup'
);

// Palette values must match the actual normal CSS backgrounds, including alpha.
const css = fs.readFileSync('src/stylesheet.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)].flatMap(([, selectors, body], index) => {
    const match = body.match(/(?:^|;)\s*background-color\s*:\s*([^;]+);/);
    return match
        ? selectors
              .split(',')
              .map((selector) => ({ selector: selector.trim(), color: match[1].trim(), index }))
        : [];
});
function parseColor(value) {
    if (/^#[0-9a-f]{6}$/i.test(value))
        return [...[1, 3, 5].map((n) => parseInt(value.slice(n, n + 2), 16)), 1];
    return value.match(/[\d.]+/g).map(Number);
}
const roles = {
    log: '.pingoose-chat-scroll',
    incoming: '.pingoose-chat-bubble-in',
    outgoing: '.pingoose-chat-bubble-out',
    preview: '.pingoose-chat-image-preview',
    entry: 'StEntry',
};
for (const [id] of themes.choices) {
    const classes = Array.from(themes.styleClasses(id));
    const scopes = ['', `.${classes[0]} `, `.${classes.join('.')} `];
    for (const [role, target] of Object.entries(roles)) {
        for (const [state, pseudo] of role === 'entry'
            ? [
                  ['', ''],
                  ['Active', ':focus'],
                  ['Disabled', ':insensitive'],
              ]
            : [['', '']]) {
            const selectors = new Set(
                scopes.flatMap((scope) => [scope + target, scope + target + pseudo])
            );
            const matching = rules.filter((rule) => selectors.has(rule.selector));
            matching.sort(
                (a, b) =>
                    (a.selector.match(/[.:]/g) || []).length -
                        (b.selector.match(/[.:]/g) || []).length || a.index - b.index
            );
            const original = parseColor(matching.at(-1).color);
            const actual = parseColor(themes.chatBackgroundStyle(id, 50, role, state));
            assert.deepEqual(
                actual.slice(0, 3),
                original.slice(0, 3),
                `${id} ${role} ${state} keeps its CSS hue`
            );
            assert.ok(Math.abs(actual[3] - original[3] * 0.5) < 0.001);
        }
        assert.equal(themes.chatBackgroundStyle(id, 0, role), '');
        assert.equal(
            themes.chatBackgroundStyle(id, 81, role),
            themes.chatBackgroundStyle(id, 80, role)
        );
    }
}
console.log(
    'PASS: all five chat palettes preserve CSS hues and base alpha while following the setting'
);
