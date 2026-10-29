const fs = require('node:fs'),
    vm = require('node:vm'),
    assert = require('node:assert/strict');
const files = new Map(),
    signals = new Map();
let autoDeletePast = false,
    scope = 'all',
    enabled = false,
    deleted = [],
    refreshes = 0,
    writes = 0,
    status = '';
const settings = {
    connect(n, fn) {
        signals.set(n, fn);
        return n;
    },
    disconnect(n) {
        signals.delete(n);
    },
    get_boolean: (key) => (key === 'sync-agenda-calendar' ? enabled : autoDeletePast),
    get_string: () => scope,
    get_strv: () => deleted,
    set_strv(_k, value) {
        deleted = value;
        signals.get('changed::deleted-calendar-events')?.();
    },
    set_string(_k, value) {
        status = value;
    },
};
class KeyFile {
    constructor() {
        this.data = {};
    }
    set_string(group, key, value) {
        this.data[group + key] = value;
    }
    set_boolean(...args) {
        this.set_string(...args);
    }
    to_data() {
        return [JSON.stringify(this.data)];
    }
}
const ctx = {
    logError() {},
    imports: {
        byteArray: { toString: (x) => x },
        gi: {
            GLib: {
                build_filenamev: (p) => p.join('/'),
                get_user_data_dir: () => '/data',
                get_user_config_dir: () => '/config',
                mkdir_with_parents() {},
                path_get_dirname: (p) => p.slice(0, p.lastIndexOf('/')),
                KeyFile,
            },
            Gio: {
                FileCreateFlags: { PRIVATE: 1 },
                File: {
                    new_for_path: (path) => ({
                        query_exists: () => files.has(path),
                        load_contents: () => [true, files.get(path)],
                        replace_contents: (text) => {
                            writes++;
                            files.set(path, text);
                        },
                        delete: () => files.delete(path),
                        get_uri: () => `file://${path}`,
                    }),
                },
            },
        },
        misc: {
            extensionUtils: {
                getCurrentExtension: () => ({
                    imports: { models: { agendaCalendar: require('../models/agendaCalendar') } },
                }),
            },
        },
    },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('src/services/agendaCalendar.js', 'utf8'), ctx);
const control = new ctx.Controller(settings, () => refreshes++);
const row = { id: '1', name: 'Exam', begin: '2099-11-01T00:00:00Z', end: '2099-11-01T01:00:00Z' };
control.observe([row], 'a');
assert.equal(files.size, 0);
enabled = true;
signals.get('changed::sync-agenda-calendar')();
assert.equal(refreshes, 1);
control.observe([row], 'a');
assert.equal(files.size, 3);
const count = writes;
control.observe([row], 'a');
assert.equal(writes, count);
control.observe([{ ...row, end: 'bad' }], 'a');
assert(status.includes('failed'));
assert(files.get(control.calendarPath).includes('SUMMARY:Exam'));
control.observe([row], 'a');
files.set('/personal/calendar', 'private');
enabled = false;
signals.get('changed::sync-agenda-calendar')();
assert(files.get(control.calendarPath).includes('SUMMARY:Exam'));
settings.set_strv('deleted-calendar-events', ['a:event:1']);
assert(!files.get(control.calendarPath).includes('VEVENT'));
enabled = true;
signals.get('changed::sync-agenda-calendar')();
assert.equal(deleted.length, 0);
control.observe([row], 'a');
assert(
    files.get(control.calendarPath).includes('SUMMARY:Exam'),
    're-enabling restores server events'
);
settings.set_strv('deleted-calendar-events', ['a:event:1']);
control.observe([row], 'a');
assert(
    !files.get(control.calendarPath).includes('VEVENT'),
    'poll does not undo individual deletion'
);
control.clear();
assert(files.has(control.historyPath));
assert.equal(files.get('/personal/calendar'), 'private');
scope = 'registered';
deleted = [];
control.observe([{ ...row, subscribed: true }], 'a');
assert(files.get(control.calendarPath).includes('SUMMARY:Exam'));
control.observe([{ ...row, subscribed: false }], 'a');
assert(!files.get(control.calendarPath).includes('VEVENT'), 'unregister removes event');
// A completed registration becomes history, even if later snapshots drop its flag.
const ended = {
    ...row,
    id: '2',
    name: 'Past registration',
    subscribed: true,
    begin: '2020-01-01T00:00:00Z',
    end: '2020-01-01T01:00:00Z',
};
control.observe([ended], 'a');
control.observe([{ ...ended, subscribed: false }], 'a');
assert(
    files.get(control.calendarPath).includes('SUMMARY:Past registration'),
    'server subscription cleanup must not erase completed history'
);
control.observe([], 'a');
assert(JSON.parse(files.get(control.historyPath)).rows.some((item) => item.id === '2'));

// Some Intra lists drop events as soon as they start, before their end time.
const ongoing = {
    ...row,
    id: '3',
    name: 'In progress',
    subscribed: true,
    begin: new Date(Date.now() - 60000).toISOString(),
    end: new Date(Date.now() + 3600000).toISOString(),
};
control.observe([ongoing], 'a');
control.observe([], 'a');
assert(
    files.get(control.calendarPath).includes('SUMMARY:In progress'),
    'an event must survive disappearance during its scheduled duration'
);
control.observe([{ ...ongoing, subscribed: null }], 'a');
assert(files.get(control.calendarPath).includes('SUMMARY:In progress'));
scope = 'all';
const legacy = { ...ended, id: '4', name: 'Previously synced', subscribed: null };
control.observe([legacy], 'a');
scope = 'registered';
control.observe([], 'a');
assert(
    files.get(control.calendarPath).includes('SUMMARY:Previously synced'),
    'changing scope does not retroactively delete stored history'
);
control.clear();
control.observe([], 'a');
assert(
    files.get(control.calendarPath).includes('SUMMARY:Past registration'),
    'history survives relogin without an event in the current server snapshot'
);
settings.set_strv('deleted-calendar-events', ['a:event:2', 'a:event:3', 'a:event:4']);
assert(!files.get(control.calendarPath).includes('VEVENT'), 'management can delete history');
control.observe([ended, ongoing], 'a');
assert(
    !files.get(control.calendarPath).includes('VEVENT'),
    'polling respects manual history deletion'
);

deleted = [];
control.observe([ended, ongoing, { ...row, subscribed: true }], 'a');
autoDeletePast = true;
signals.get('changed::auto-delete-past-agenda-calendar')();
assert(!files.get(control.calendarPath).includes('SUMMARY:Past registration'));
assert(
    files.get(control.calendarPath).includes('SUMMARY:In progress'),
    'auto-delete waits until the end'
);
assert(files.get(control.calendarPath).includes('SUMMARY:Exam'));
control.observe([ended, ongoing, { ...row, subscribed: true }], 'a');
assert(
    !files.get(control.calendarPath).includes('SUMMARY:Past registration'),
    'old server rows do not recreate auto-deleted events'
);
enabled = false;
const pausedCalendar = files.get(control.calendarPath);
control.observe([ended], 'a');
assert.equal(files.get(control.calendarPath), pausedCalendar, 'paused sync never deletes events');
autoDeletePast = false;
enabled = true;
control.observe([ended], 'a');
assert(files.get(control.calendarPath).includes('SUMMARY:Past registration'));

let approval;
control.confirmEnable = (done) => {
    approval = done;
};
control.enableApproved = false;
files.set(control.sourcePath, '[Data Source]\nEnabled=false\n[Calendar]\nSelected=false\n');
control.observe([{ ...row, subscribed: true }], 'a');
assert.equal(typeof approval, 'function');
assert(files.get(control.sourcePath).includes('Enabled=false'));
approval(true);
assert(!files.get(control.sourcePath).includes('Enabled=false'));
control.destroy();
assert.equal(signals.size, 0);
console.log(
    'PASS: past/ongoing history retention, optional ended-event deletion, pause/relogin, manual deletion and calendar isolation'
);
