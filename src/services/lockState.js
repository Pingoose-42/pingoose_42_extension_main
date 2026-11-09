// ft_lock keeps a resident parent; a live same-user child exists while locked.
const { Gio, GLib } = imports.gi;
var Monitor = class Monitor {
    constructor() {
        this.locked = null;
        this.closed = false;
        this.refresh();
        this.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }
    refresh() {
        if (this.process || this.closed) return;
        try {
            const uid = String(new Gio.Credentials().get_unix_user());
            const process = Gio.Subprocess.new(
                ['/bin/ps', '-u', uid, '-o', 'pid=,ppid=,stat=,comm='],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            this.process = process;
            process.communicate_utf8_async(null, null, (child, result) => {
                this.process = null;
                if (this.closed) return;
                try {
                    const [, output] = child.communicate_utf8_finish(result);
                    if (!child.get_successful()) throw Error('Unavailable');
                    const rows = output
                        .trim()
                        .split('\n')
                        .map((line) => line.trim().split(/\s+/))
                        .filter((row) => row[3] === 'ft_lock' && !/^[ZX]/.test(row[2]));
                    const parents = new Set(rows.map((row) => row[0]));
                    this.locked = rows.some((row) => parents.has(row[1]));
                } catch (_) {
                    this.locked = null;
                }
            });
        } catch (_) {
            this.locked = null;
        }
    }
    destroy() {
        this.closed = true;
        if (this.timer) GLib.source_remove(this.timer);
        this.process?.force_exit();
    }
};
