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

// Match the CSS surfaces; only their backgrounds fade, never text or images.
const chatSurfaces = {
    dark: {
        log: [0, 0, 0, 0.18],
        incoming: [127, 127, 127, 0.24],
        outgoing: [47, 127, 116],
        preview: [23, 27, 32],
        entry: [23, 27, 32],
        entryActive: [32, 41, 48],
        entryDisabled: [45, 52, 60],
    },
    light: {
        log: [231, 236, 239],
        incoming: [255, 255, 255],
        outgoing: [22, 121, 107],
        preview: [231, 236, 239],
        entry: [255, 255, 255],
        entryActive: [255, 255, 255],
        entryDisabled: [226, 231, 235],
    },
    pink: {
        log: [246, 223, 233],
        incoming: [255, 255, 255],
        outgoing: [158, 49, 95],
        preview: [246, 223, 233],
        entry: [255, 255, 255],
        entryActive: [255, 248, 251],
        entryDisabled: [238, 216, 226],
    },
    halloween: {
        log: [24, 19, 30],
        incoming: [64, 48, 71],
        outgoing: [245, 160, 78],
        preview: [24, 19, 30],
        entry: [23, 18, 29],
        entryActive: [43, 32, 49],
        entryDisabled: [60, 48, 66],
    },
    neon: {
        log: [11, 21, 30],
        incoming: [32, 56, 70],
        outgoing: [93, 231, 210],
        preview: [11, 21, 30],
        entry: [11, 20, 28],
        entryActive: [19, 38, 51],
        entryDisabled: [36, 59, 73],
    },
};

function chatBackgroundStyle(value, transparency, role, state = '') {
    const percent = Number.isFinite(transparency) ? Math.max(0, Math.min(80, transparency)) : 0;
    // At zero, let the original CSS own all normal/hover/focus/disabled states.
    if (!percent) return '';
    const surface = role === 'entry' && state ? `entry${state}` : role;
    const color = chatSurfaces[normalize(value)][surface];
    if (!color) return '';
    const alpha = ((color[3] ?? 1) * (1 - percent / 100)).toFixed(3);
    return `background-color: rgba(${color.slice(0, 3).join(', ')}, ${alpha});`;
}

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
