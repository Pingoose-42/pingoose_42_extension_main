// Slot API adapted from origin/deeev-seunkang-slot. Runs only in our WebKit session.
async function slotRequest(action, expected, payload) {
    const date = new Date();
    // Calendar boundaries must include a timezone. A date-only start can be
    // interpreted in the server timezone and omit the first slots of our day.
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 8);
    const query = new URLSearchParams({ start: start.toISOString(), end: end.toISOString() });
    const read = async () => {
        const response = await fetch(`/slots.json?${query}`, {
            credentials: 'same-origin',
            redirect: 'error',
            cache: 'no-store',
            headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (!response.ok)
            throw new Error('Unable to load slots. Open Intra and check your session.');
        const data = await response.json();
        if (!Array.isArray(data) || data.length > 1000) throw new Error('Invalid slot response.');
        return data
            .filter(
                (row) =>
                    row?.title === 'Available' ||
                    (Array.isArray(row?.className)
                        ? row.className
                        : String(row?.className || '').split(/\s+/)
                    ).includes('reserved')
            )
            .map((row) => {
                const id = String(row.id),
                    ids = String(row.ids || row.id);
                if (
                    !/^\d+$/.test(id) ||
                    !/^\d+(,\d+)*$/.test(ids) ||
                    !Number.isFinite(Date.parse(row.start)) ||
                    !Number.isFinite(Date.parse(row.end))
                )
                    throw new Error('Invalid slot response.');
                const matched = (
                    Array.isArray(row.className)
                        ? row.className
                        : String(row.className || '').split(/\s+/)
                ).includes('reserved');
                return {
                    id,
                    ids,
                    start: row.start,
                    end: row.end,
                    ...(matched
                        ? {
                              matched: true,
                              project: String(
                                  row.project_name || row.project?.name || row.title || 'Evaluation'
                              )
                                  .replace(/<[^>]*>/g, '')
                                  .slice(0, 200),
                          }
                        : {}),
                };
            });
    };
    const succeeded = async (response) => {
        if (response.status === 204) return true;
        if (!response.ok) return false;
        const result = await response.json();
        // Intra reports application errors inside otherwise successful HTTP responses.
        return result?.status === 200;
    };
    let rows = await read();

    if (action === 'create' || action === 'create-5') {
        const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
        if (!csrf) throw new Error('Slot session expired. Open Intra and try again.');
        const slotsToCreate = Array.isArray(payload) ? payload : [payload];
        if (
            !slotsToCreate.length ||
            slotsToCreate.length > 20 ||
            slotsToCreate.some(
                (item) =>
                    !item ||
                    !Number.isFinite(Date.parse(item.begin)) ||
                    !Number.isFinite(Date.parse(item.end)) ||
                    Date.parse(item.end) - Date.parse(item.begin) < 900000 ||
                    (action === 'create-5' &&
                        Date.parse(item.end) - Date.parse(item.begin) > 14400000) ||
                    (Date.parse(item.end) - Date.parse(item.begin)) % 900000 !== 0
            )
        )
            throw new Error('Invalid slot schedule.');
        if (action === 'create') {
            if (slotsToCreate.length !== 1) throw new Error('Create one slot at a time.');
            const begin = Date.parse(slotsToCreate[0].begin),
                end = Date.parse(slotsToCreate[0].end);
            if (
                begin < Date.now() + 1800000 ||
                end > Date.now() + 7 * 86400000 ||
                begin % 900000 ||
                end % 900000
            )
                return {
                    rows,
                    error: 'Start at least 30 minutes from now on a 15-minute boundary, within 7 days.',
                };
            const conflict = rows.find(
                (row) => Date.parse(row.start) < end && Date.parse(row.end) > begin
            );
            if (conflict) {
                const format = (value) =>
                    new Date(value).toLocaleString('en-GB', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                    });
                return {
                    rows,
                    error: `Could not create slot:\nOverlaps ${format(conflict.start)} – ${format(conflict.end)}.`,
                };
            }
        }
        let createdCount = 0,
            skipped = 0,
            failed = 0;
        for (const item of slotsToCreate) {
            if (
                rows.some(
                    (row) =>
                        Date.parse(row.start) === Date.parse(item.begin) &&
                        Date.parse(row.end) === Date.parse(item.end)
                )
            ) {
                skipped++;
                continue;
            }
            try {
                const params = new URLSearchParams({
                    'slot[begin_at]': item.begin,
                    'slot[end_at]': item.end,
                });
                const response = await fetch('/slots.json', {
                    method: 'POST',
                    credentials: 'same-origin',
                    redirect: 'error',
                    headers: {
                        'X-CSRF-Token': csrf,
                        'X-Requested-With': 'XMLHttpRequest',
                        'Accept': 'application/json, text/javascript, */*; q=0.01',
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    },
                    body: params.toString(),
                });
                if (await succeeded(response)) createdCount++;
                else failed++;
            } catch (_) {
                failed++;
            }
        }
        rows = await read();
        return {
            rows,
            created: createdCount,
            skipped,
            error: failed ? `${failed} slot(s) could not be opened. Refresh and try again.` : null,
        };
    }

    let failed = 0,
        closed = 0;
    const deleted = [];
    const available = rows.filter((row) => !row.matched);
    const targets =
        action === 'all'
            ? available
            : action === 'future'
              ? available.filter((row) => Date.parse(row.end) > Date.now())
              : (expected || []).filter((row) => !row.matched);
    if (action !== 'list') {
        const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
        if (!csrf) throw new Error('Slot session expired. Open Intra and try again.');
        // Bulk actions use the fresh server list; individual closes require an unchanged snapshot.
        for (const target of targets) {
            const current = rows.find((row) => row.id === target.id);
            if (!current) continue;
            if (current.matched) {
                failed++;
                continue;
            }
            if (
                current.ids !== target.ids ||
                current.start !== target.start ||
                current.end !== target.end
            ) {
                failed++;
                continue;
            }
            try {
                const response = await fetch(`/slots/${current.id}.json`, {
                    method: 'POST',
                    credentials: 'same-origin',
                    redirect: 'error',
                    headers: {
                        'X-CSRF-Token': csrf,
                        'X-Requested-With': 'XMLHttpRequest',
                        'Accept': 'application/json',
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    },
                    body: new URLSearchParams({ _method: 'delete', ids: current.ids }).toString(),
                });
                if (await succeeded(response)) {
                    closed++;
                    deleted.push(current);
                } else failed++;
            } catch (_) {
                failed++;
            }
        }
        rows = await read();
    }
    // A successful HTTP response alone does not prove the slots disappeared.
    if (action !== 'list') {
        const remaining = new Set(rows.flatMap((row) => row.ids.split(',')));
        const retained = targets.filter((row) =>
            row.ids.split(',').some((id) => remaining.has(id))
        ).length;
        failed = Math.max(failed, retained);
        closed = deleted.filter(
            (row) => !row.ids.split(',').some((id) => remaining.has(id))
        ).length;
    }
    return {
        rows,
        closed,
        error: failed ? `${failed} slot(s) could not be closed. Refresh and try again.` : null,
    };
}

var SlotsService = class SlotsService {
    constructor(context, allowedURI) {
        this.context = context;
        this.allowedURI = allowedURI;
        this.rows = [];
        this.busy = false;
    }
    run(action, id, callback, payload = null) {
        if (this.busy) return;
        const expected =
            action === 'all'
                ? this.rows.slice()
                : action === 'future'
                  ? this.rows.filter((row) => Date.parse(row.start) > Date.now())
                  : this.rows.filter((row) => row.id === id);
        if (
            action !== 'list' &&
            action !== 'create' &&
            action !== 'create-5' &&
            action !== 'all' &&
            action !== 'future' &&
            !expected.length
        ) {
            callback({ rows: this.rows, error: 'Refresh slots before closing them.' });
            return;
        }
        const { WebKit2, GLib } = imports.gi;
        this.busy = true;
        const view = (this.view = imports.worker.backgroundView.create(this.context, (uri) =>
            this.allowedURI(uri)
        ));
        let started = false,
            reading = false,
            attempts = 0;
        const finish = (result) => {
            this.close();
            if (result.rows) this.rows = result.rows;
            callback(result);
        };
        view.connect('load-changed', (_view, event) => {
            if (
                started ||
                event !== WebKit2.LoadEvent.FINISHED ||
                !/^https:\/\/profile\.intra\.42\.fr\/slots\/?(?:[?#]|$)/.test(view.get_uri() || '')
            )
                return;
            started = true;
            const script = `window.__pingooseSlots = null; (${slotRequest.toString()})(${JSON.stringify(action)}, ${JSON.stringify(expected)}, ${JSON.stringify(payload)}).then(value => window.__pingooseSlots = value).catch(error => window.__pingooseSlots = {error: error.message}); void 0;`;
            view.run_javascript_in_world(script, 'pingoose-slots', null, (page, result) => {
                try {
                    page.run_javascript_in_world_finish(result);
                } catch (_) {
                    if (this.view === view) finish({ error: 'Unable to read slots.' });
                }
            });
        });
        this.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (++attempts > 60) {
                finish({ error: 'Slot request timed out. Open Intra and try again.' });
                return GLib.SOURCE_REMOVE;
            }
            if (!started || reading) return GLib.SOURCE_CONTINUE;
            reading = true;
            view.run_javascript_in_world(
                'JSON.stringify(window.__pingooseSlots)',
                'pingoose-slots',
                null,
                (page, result) => {
                    reading = false;
                    if (this.view !== view) return;
                    try {
                        const value = JSON.parse(
                            page.run_javascript_in_world_finish(result).get_js_value().to_string()
                        );
                        if (value) finish(value);
                    } catch (_) {
                        finish({ error: 'Unable to read slots.' });
                    }
                }
            );
            return GLib.SOURCE_CONTINUE;
        });
        view.load_uri('https://profile.intra.42.fr/slots');
    }
    close() {
        if (this.timer) imports.gi.GLib.source_remove(this.timer);
        this.timer = 0;
        this.view?.stop_loading();
        this.view?.destroy();
        this.view = null;
        this.busy = false;
    }
};
if (typeof module !== 'undefined') module.exports = { slotRequest };
