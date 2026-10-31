// Keep the persisted dark/light identifiers compatible with existing settings.
var choices = [
    ['dark', 'Dark'],
    ['light', 'Light'],
    ['pink', 'Pink'],
    ['halloween', 'Halloween'],
    ['neon', 'Neon'],
];

const palettes = {
    dark: { scheme: 'dark', background: [35, 39, 45] },
    light: { scheme: 'light', background: [246, 247, 249] },
    pink: { scheme: 'light', background: [255, 241, 246] },
    halloween: { scheme: 'dark', background: [33, 26, 38] },
    neon: { scheme: 'dark', background: [16, 27, 36] },
};

function normalize(value) {
    return choices.some(([id]) => id === value) ? value : 'dark';
}

function styleClasses(value) {
    const id = normalize(value);
    return [...new Set([`pingoose-${palettes[id].scheme}`, `pingoose-${id}`])];
}

function backgroundStyle(value, transparency) {
    const percent = Number.isFinite(transparency) ? Math.max(0, Math.min(80, transparency)) : 0;
    const alpha = (1 - percent / 100).toFixed(2);
    return `background-color: rgba(${palettes[normalize(value)].background.join(', ')}, ${alpha});`;
}

function applyClasses(actor, value) {
    for (const [id] of choices) actor.remove_style_class_name(`pingoose-${id}`);
    for (const name of styleClasses(value)) actor.add_style_class_name(name);
}
