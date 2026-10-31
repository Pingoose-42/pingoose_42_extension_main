const Themes = imports.misc.extensionUtils.getCurrentExtension().imports.models.themes;

// Preserve viewport sizing styles while applying the shared transparency setting
// to chat surfaces. Actor opacity belongs to animations, text and image pixels.
var Controller = class Controller {
    constructor(settings) {
        this.settings = settings;
        this.records = new Map();
        this.signals = ['theme', 'panel-transparency'].map((key) =>
            settings.connect(`changed::${key}`, () => this.sync())
        );
    }

    track(actor, role) {
        if (!actor || this.records.has(actor)) return;
        const record = {
            actor,
            role,
            applying: false,
            originalBackground: this._declarations(actor).filter((part) =>
                this._isBackground(part)
            ),
        };
        record.signals = [
            actor.connect('style-changed', () => this._apply(record)),
            actor.connect('destroy', () => this.records.delete(actor)),
        ];
        this.records.set(actor, record);
        this._apply(record);
    }

    _declarations(actor) {
        return (actor.get_style() || '')
            .split(';')
            .map((part) => part.trim())
            .filter(Boolean);
    }

    _isBackground(part) {
        return /^background-color\s*:/i.test(part);
    }

    _setBackground(record, background) {
        const actor = record.actor;
        const other = this._declarations(actor).filter((part) => !this._isBackground(part));
        const style = [...other, ...background].join('; ');
        const next = style ? style + ';' : null;
        if ((actor.get_style() || null) === next) return;
        record.applying = true;
        try {
            actor.set_style(next);
        } finally {
            record.applying = false;
        }
    }

    _apply(record) {
        if (record.applying) return;
        const actor = record.actor;
        const hasState = (state) => actor.has_style_pseudo_class(state);
        const state =
            record.role !== 'entry'
                ? ''
                : hasState('insensitive')
                  ? 'Disabled'
                  : hasState('focus') || hasState('hover')
                    ? 'Active'
                    : '';
        const background = Themes.chatBackgroundStyle(
            this.settings.get_string('theme'),
            this.settings.get_int('panel-transparency'),
            record.role,
            state
        );
        this._setBackground(
            record,
            background ? [background.replace(/;$/, '')] : record.originalBackground
        );
    }

    sync() {
        for (const record of this.records.values()) this._apply(record);
    }

    destroy() {
        for (const id of this.signals) this.settings.disconnect(id);
        this.signals = [];
        for (const record of this.records.values()) {
            for (const id of record.signals) record.actor.disconnect(id);
            this._setBackground(record, record.originalBackground);
        }
        this.records.clear();
    }
};
