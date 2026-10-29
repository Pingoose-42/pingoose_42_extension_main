const { Gio, GLib } = imports.gi;
imports.searchPath.unshift(GLib.build_filenamev([GLib.get_current_dir(), 'src']));
const Notes = imports.services.projectNotes;
Notes.save({ project: 'fixture', login: 'fixture', kind: 'note', title: 'Test', body: 'Body' });
const monitor = Notes.file().get_parent().monitor_directory(Gio.FileMonitorFlags.NONE, null);
let events = 0;
monitor.connect('changed', () => {
    events++;
});
for (let i = 0; i < 20; i++) Notes.list();
const loop = new GLib.MainLoop(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
monitor.cancel();
if (events !== 0) throw Error(`Read triggered ${events} file events`);
print('PASS: repeated notes reads emit no filesystem change events');
