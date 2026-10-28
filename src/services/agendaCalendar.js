// Dedicated read-only Evolution Data Server source, also consumed by Shell's calendar.
// Only complete authenticated agenda snapshots reach observe(); failures preserve the file.
const {Gio, GLib} = imports.gi;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Model = Me.imports.models.agendaCalendar;
const ByteArray = imports.byteArray;
var Controller = class Controller {
    constructor(settings, refresh, confirmEnable = null) {
        this.settings = settings;
        this.confirmEnable = confirmEnable;
        this.enableApproved = false;
        this.refresh = refresh;
        this.snapshot = null;
        this.directory = GLib.build_filenamev([GLib.get_user_data_dir(), 'pingoose', 'calendar']);
        this.calendarPath = GLib.build_filenamev([this.directory, 'agenda.ics']);
        this.historyPath = GLib.build_filenamev([this.directory, 'history.json']);
        this.sourcePath = GLib.build_filenamev([GLib.get_user_config_dir(), 'evolution', 'sources', 'pingoose-agenda.source']);
        this.signal = settings.connect('changed::sync-agenda-calendar', () => {
            if (settings.get_boolean('sync-agenda-calendar')) {
                this.enableApproved = false;
                settings.set_strv('deleted-calendar-events', []);
                this.snapshot = null;
            }
            this.sync();
        });
        this.scopeSignal = settings.connect('changed::agenda-calendar-scope', () => { this.sync(); this.refresh(); });
        this.deleteSignal = settings.connect('changed::deleted-calendar-events', () => this.removeDeleted());
        this.removeDeleted();
        this.sync();
    }
    observe(rows, subject) {
        if (!subject) return;
        this.snapshot = {rows, subject: String(subject)};
        this.sync(false);
    }
    write(path, text) {
        const file = Gio.File.new_for_path(path);
        if (file.query_exists(null)) {
            const [ok, bytes] = file.load_contents(null);
            if (ok && ByteArray.toString(bytes) === text) return;
        }
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
        file.replace_contents(text, null, false, Gio.FileCreateFlags.PRIVATE, null);
    }
    sync(request = true) {
        try {
            if (!this.settings.get_boolean('sync-agenda-calendar')) {
                this.settings.set_string('agenda-calendar-status', 'Sync paused. Saved events are kept.');
                return;
            }
            if (!this.snapshot) {
                this.settings.set_string('agenda-calendar-status', 'Waiting for agenda from Intra…');
                if (request) this.refresh();
                return;
            }
            const existingSource = Gio.File.new_for_path(this.sourcePath);
            if (!this.enableApproved && existingSource.query_exists(null)) {
                const [, bytes] = existingSource.load_contents(null);
                const content = ByteArray.toString(bytes);
                if (/^(?:Enabled|Selected)=false\s*$/m.test(content)) {
                    this.settings.set_string('agenda-calendar-status', 'Enable the Pingoose calendar to sync.');
                    if (!this.awaitingEnable && this.confirmEnable) {
                        this.awaitingEnable = true;
                        this.confirmEnable(accepted => {
                            this.awaitingEnable = false;
                            if (this.destroyed) return;
                            if (accepted) { this.enableApproved = true; this.sync(false); }
                            else this.settings.set_boolean('sync-agenda-calendar', false);
                        });
                    }
                    return;
                }
            }
            // Validate the new snapshot before modifying either persistent file.
            Model.calendar(this.snapshot.rows, this.snapshot.subject);
            let previous = [];
            const history = Gio.File.new_for_path(this.historyPath);
            if (history.query_exists(null)) {
                const [ok, bytes] = history.load_contents(null);
                if (!ok) throw new Error('Cannot read agenda history');
                const saved = JSON.parse(ByteArray.toString(bytes));
                if (saved.subject === this.snapshot.subject) {
                    Model.calendar(saved.rows, saved.subject);
                    previous = saved.rows;
                }
            }
            const deleted = new Set(this.settings.get_strv('deleted-calendar-events'));
            const registeredOnly = this.settings.get_string('agenda-calendar-scope') === 'registered';
            const current = this.snapshot.rows.filter(row => !registeredOnly || row.subscribed === true);
            const unregistered = new Set(this.snapshot.rows.filter(row => row.subscribed === false).map(row => Model.eventKey(this.snapshot.subject, row)));
            if (registeredOnly) previous = previous.filter(row => row.subscribed === true && !unregistered.has(Model.eventKey(this.snapshot.subject, row)));
            const rows = Model.retainPast(previous, current).filter(row => !deleted.has(Model.eventKey(this.snapshot.subject, row)));
            const text = Model.calendar(rows, this.snapshot.subject);
            this.write(this.historyPath, JSON.stringify({subject: this.snapshot.subject, rows}));
            this.write(this.calendarPath, text);
            const source = new GLib.KeyFile();
            source.set_string('Data Source', 'DisplayName', 'Pingoose Agenda');
            source.set_boolean('Data Source', 'Enabled', true);
            source.set_string('Data Source', 'Parent', 'local-stub');
            source.set_string('Calendar', 'BackendName', 'local');
            source.set_string('Calendar', 'Color', '#4dbb92');
            source.set_boolean('Calendar', 'Selected', true);
            source.set_string('Local Backend', 'CustomFile', Gio.File.new_for_path(this.calendarPath).get_uri());
            source.set_boolean('Local Backend', 'Writable', false);
            this.write(this.sourcePath, source.to_data()[0]);
            this.settings.set_string('agenda-calendar-status', 'Agenda synced to the local Pingoose Agenda calendar.');
        } catch (error) {
            logError(error, 'Pingoose agenda calendar');
            this.settings.set_string('agenda-calendar-status', 'Calendar sync failed. It will retry with the next agenda refresh.');
        }
    }
    removeDeleted() {
        try {
            const file = Gio.File.new_for_path(this.historyPath);
            if (!file.query_exists(null)) return;
            const [ok, bytes] = file.load_contents(null);
            if (!ok) throw new Error('Cannot read agenda history');
            const saved = JSON.parse(ByteArray.toString(bytes));
            Model.calendar(saved.rows, saved.subject);
            const deleted = new Set(this.settings.get_strv('deleted-calendar-events'));
            saved.rows = saved.rows.filter(row => !deleted.has(Model.eventKey(saved.subject, row)));
            this.write(this.historyPath, JSON.stringify(saved));
            this.write(this.calendarPath, Model.calendar(saved.rows, saved.subject));
        } catch (error) {
            logError(error, 'Pingoose calendar deletion');
            this.settings.set_string('agenda-calendar-status', 'Unable to delete saved event. Please retry.');
        }
    }
    clear() { this.snapshot = null; }
    destroy() {
        this.destroyed = true;
        this.settings.disconnect(this.signal);
        this.settings.disconnect(this.deleteSignal);
        this.settings.disconnect(this.scopeSignal);
    }
};
