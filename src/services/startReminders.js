const Me = imports.misc.extensionUtils.getCurrentExtension();
const Model = Me.imports.models.startReminders;
var Controller = class Controller {
    constructor(settings, deliver) { this.settings = settings; this.deliver = deliver; }
    tick(evaluations, agenda) {
        const sent = new Set(this.settings.get_strv('start-reminders-sent'));
        let changed = false;
        for (const [category, rows] of [['evaluation', evaluations], ['agenda', agenda]]) {
            if (!this.settings.get_boolean(`notify-${category}-reminder-enabled`) ||
                !this.settings.get_boolean(category === 'agenda' ? 'notify-agenda' : 'notify-evaluations')) continue;
            for (const message of Model.due(rows, category, this.settings.get_int(`${category}-reminder-minutes`))) {
                if (sent.has(message.id)) continue;
                sent.add(message.id); changed = true;
                this.deliver(message);
            }
        }
        if (changed) this.settings.set_strv('start-reminders-sent', [...sent].slice(-2000));
    }
};
