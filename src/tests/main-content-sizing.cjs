const assert = require('node:assert/strict');
const { moduleExport } = require('./helpers.cjs');
const Size = moduleExport('models/panelSize.js', '({ MINIMUM_VIEWPORT })');
const { Controller, distribute } = moduleExport(
    'ui/mainContentSizer.js',
    '({ Controller, distribute })',
    {
        imports: {
            gi: { St: { Side: { TOP: 0, BOTTOM: 1 } } },
            misc: {
                extensionUtils: {
                    getCurrentExtension: () => ({ imports: { models: { panelSize: Size } } }),
                },
            },
        },
    }
);

assert.deepEqual(Array.from(distribute([30, 700], [30, 64], 500)), [30, 470]);
assert.deepEqual(Array.from(distribute([400, 700], [64, 64], 50)), [64, 64]);
assert.deepEqual(Array.from(distribute([], [], 300)), []);

function fixture(heights = [1280]) {
    const content = { visible: true };
    const actor = {
        width: 460,
        get_theme_node: () => ({
            adjust_for_width: (width) => width - 24,
            adjust_preferred_height: (minimum, natural) => [minimum + 20, natural + 20],
        }),
    };
    const sections = heights.map((natural, index) => {
        const sectionContent = {
            natural,
            get_preferred_height(width) {
                this.lastWidth = width;
                return [this.natural, this.natural];
            },
        };
        const area = { visible: true, get_parent: () => content };
        const scroll = {
            width: 436,
            explicit: -1,
            writes: 0,
            cap: [266, 190, 280, 480][index] || 266,
            padding: 0,
            border: 0,
            margin_top: 0,
            margin_bottom: 0,
            overlay_scrollbars: false,
            get height() {
                return this.explicit;
            },
            set height(value) {
                this.explicit = value;
                this.writes++;
            },
            get_vscroll_bar: () => ({ get_preferred_width: () => [8, 8] }),
            get_theme_node() {
                return {
                    adjust_for_width: (width) => width - 2 * (this.padding + this.border),
                    // This is how the old CSS cap can accidentally leak back
                    // into a supposedly uncapped natural-height measurement.
                    adjust_preferred_height: (minimum, naturalHeight) => [
                        Math.min(this.cap, minimum),
                        Math.min(this.cap, naturalHeight),
                    ],
                    get_padding: () => this.padding,
                    get_border_width: () => this.border,
                };
            },
            preferredHeight() {
                return (
                    (this.explicit >= 0
                        ? this.explicit
                        : Math.min(this.cap, sectionContent.natural)) +
                    this.margin_top +
                    this.margin_bottom
                );
            },
        };
        const reveal = {
            width: 436,
            visible: true,
            expanded: true,
            progress: 1,
            get_parent: () => area,
            get_preferred_height() {
                const height = Math.round(scroll.preferredHeight() * this.progress);
                return [height, height];
            },
        };
        return { content: sectionContent, scroll, reveal, area };
    });
    content.get_preferred_height = () => {
        const height = sections.reduce(
            (sum, { reveal, area }) =>
                sum + (reveal.visible && area.visible ? reveal.get_preferred_height()[1] : 0),
            200
        );
        return [height, height];
    };
    return { actor, content, sections, sizer: new Controller(actor, content, sections) };
}

const single = fixture();
assert.equal(single.sizer.naturalHeight(), 1500, 'actual rows bypass the old 266px CSS cap');
assert.equal(single.sizer.minimumHeight(), 284, 'fixed chrome plus a readable list is minimum');
single.sizer.fit(700);
assert.equal(single.sections[0].scroll.height, 480, 'remaining work area expands the list');
assert.equal(single.sizer.naturalHeight(), 1500, 'assigned height does not become natural height');
single.sizer.fit(850);
assert.equal(single.sections[0].scroll.height, 630, 'larger work area shows more rows');
const writes = single.sections[0].scroll.writes;
single.sizer.fit(850);
assert.equal(single.sections[0].scroll.writes, writes, 'stable layout does not rewrite heights');
assert.equal(
    single.sections[0].content.lastWidth,
    428,
    'measure wrapped rows with scrollbar space'
);

single.sizer.fit(350);
assert.equal(single.sections[0].scroll.height, 130, 'manual shrinking reduces the inner viewport');
single.sizer.fit(250);
assert.equal(single.sections[0].scroll.height, 64, 'tiny work areas use outer scrolling fallback');
single.sizer.fit(700);
assert.equal(single.sections[0].scroll.height, 480, 'larger monitor restores usable list space');

const Viewport = moduleExport('ui/panelViewport.js', 'Viewport', {
    imports: {
        gi: {},
        misc: {
            util: {},
            extensionUtils: {
                getCurrentExtension: () => ({ imports: { models: { panelSize: Size } } }),
            },
        },
    },
});
const viewport = new Viewport(single.actor, null, null, single.content, single.sizer);
assert.equal(viewport.naturalHeight(), 1500);
assert.equal(viewport.dynamicHeight(), 1500);
assert.equal(viewport.minimumHeight(), 284);
viewport.prepare(500);
assert.equal(single.sections[0].scroll.height, 280);
assert.equal(viewport.dynamicHeight(), 1500, 'manual baseline tracks content, not its fitted cap');

const many = fixture([1280, 700, 120, 60]);
many.sizer.fit(700);
assert.deepEqual(
    many.sections.map(({ scroll }) => scroll.height),
    [150, 150, 120, 60]
);
assert.equal(many.content.get_preferred_height()[1] + 20, 700);
assert.equal(many.sizer.naturalHeight(), 2380);
assert.equal(many.sizer.minimumHeight(), 472);
many.sections[1].area.visible = false;
many.sections[2].reveal.visible = false;
many.sections[3].reveal.progress = 0;
many.sizer.fit(700);
assert.equal(many.sections[0].scroll.height, 480, 'closed or hidden lists return their space');

const animated = fixture();
for (const progress of [0, 0.1, 0.25, 0.5, 1, 0.75, 0.25, 0, 0.5, 1]) {
    animated.sections[0].reveal.progress = progress;
    const natural = Math.ceil(220 + 1280 * progress);
    assert.equal(animated.sizer.naturalHeight(), natural);
    animated.sizer.fit(Math.min(700, natural));
    assert.equal(
        animated.sizer.naturalHeight(),
        natural,
        'reveal progress does not accumulate growth'
    );
    assert.ok(animated.content.get_preferred_height()[1] + 20 <= 700);
}

const decorated = fixture([100]);
const decoratedScroll = decorated.sections[0].scroll;
decoratedScroll.padding = 4;
decoratedScroll.border = 1;
decoratedScroll.margin_top = 6;
assert.equal(decorated.sizer.naturalHeight(), 336, 'decoration and margin are counted once');
assert.equal(decorated.sizer.minimumHeight(), 290);
decorated.sizer.fit(336);
assert.equal(decoratedScroll.height, 110, 'actor height includes decoration but excludes margin');
assert.equal(decorated.sections[0].content.lastWidth, 418);
decorated.sizer.destroy();
assert.equal(decoratedScroll.height, -1, 'teardown restores CSS height ownership');
decorated.sizer.destroy();

console.log(
    'PASS: uncapped section content, fair space sharing, manual size, work area fallback, reveal reversal, stable relayout and decoration'
);
