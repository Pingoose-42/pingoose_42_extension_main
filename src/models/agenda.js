// Agenda parsing, display and subscription rules; no network or desktop dependencies.
function loadEvaluations() {
    if (typeof module !== 'undefined') return require('./evaluations.js');
    // Workers register src globally; GNOME Shell uses the extension's importer.
    try {
        return imports.models.evaluations;
    } catch (_) {
        return imports.misc.extensionUtils.getCurrentExtension().imports.models.evaluations;
    }
}
const { identifier } = loadEvaluations();

function parseAgenda(data, feedback = false) {
    if (!Array.isArray(data) || data.length > 1000) throw new Error('response-error');
    return data.map((row) => {
        const id = identifier(row?.id);
        const name = row.name;
        const begin = row.begin_at ?? row.beginAt;
        const end = row.end_at ?? row.endAt;
        if (
            typeof name !== 'string' ||
            !name.trim() ||
            name.length > 500 ||
            typeof begin !== 'string' ||
            !Number.isFinite(Date.parse(begin)) ||
            typeof end !== 'string' ||
            !Number.isFinite(Date.parse(end))
        )
            throw new Error('response-error');
        const utc = (value) => (/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`);
        const field = (snake, camel) => row[snake] ?? row[camel];
        const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
        const subscription = field('events_user_id', 'eventsUserId');
        const delay = field('unsubscription_delay', 'unsubscriptionDelay');
        return {
            id,
            name,
            begin: utc(begin),
            end: utc(end),
            feedback,
            kind: typeof row.kind === 'string' ? row.kind.slice(0, 60) : '',
            description: typeof row.description === 'string' ? row.description.slice(0, 30000) : '',
            subscribers: count(field('nbr_subscribers', 'nbrSubscribers')),
            capacity: count(field('max_subscribers', 'maxSubscribers')),
            subscribed:
                typeof field('is_subscribed', 'isSubscribed') === 'boolean'
                    ? field('is_subscribed', 'isSubscribed')
                    : null,
            subscriptionId: /^\d+$/.test(String(subscription ?? '')) ? String(subscription) : null,
            unsubscriptionDelay:
                typeof delay === 'number' && Number.isFinite(delay) && delay >= 0 ? delay : 0,
            waitlisted: field('is_waitlisted', 'isWaitlisted') === true,
            location: typeof row.location === 'string' ? row.location.slice(0, 200) : '',
        };
    });
}

// The same constraints used by the Intra agenda UI; the server remains authoritative.
function agendaAction(row, action, now = Date.now()) {
    if (
        !row ||
        row.devTest ||
        !/^\d+$/.test(String(row.id)) ||
        !row.kind ||
        !['subscribe', 'unsubscribe'].includes(action) ||
        !(Date.parse(row.begin) > now)
    )
        return null;
    const group = row.kind === 'exam' ? 'exams' : 'events';
    let path = `/${group}/${row.id}/${group}_users`;
    if (action === 'subscribe') {
        if (
            row.subscribed !== false ||
            row.waitlisted ||
            (row.capacity > 0 && (row.subscribers === null || row.subscribers >= row.capacity))
        )
            return null;
    } else {
        if (
            row.subscribed !== true ||
            !/^\d+$/.test(String(row.subscriptionId ?? '')) ||
            Date.parse(row.begin) - (row.unsubscriptionDelay || 0) * 3600000 <= now
        )
            return null;
        path += `/${row.subscriptionId}`;
    }
    return {
        method: action === 'subscribe' ? 'POST' : 'DELETE',
        url: `https://profile.intra.42.fr${path}.json`,
    };
}
function agendaSummary(row, now = Date.now()) {
    const start = new Date(row.begin),
        end = Date.parse(row.end);
    const date = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    const minutes = Math.max(0, Math.ceil((start.getTime() - now) / 60000));
    const state =
        now >= start.getTime()
            ? now < end
                ? 'In progress'
                : 'Ended'
            : [
                  [Math.floor(minutes / 1440), 'd'],
                  [Math.floor((minutes % 1440) / 60), 'h'],
                  [minutes % 60, 'm'],
              ]
                  .filter(([value]) => value > 0)
                  .map(([value, unit]) => `${value} ${unit}`)
                  .join(' ') + ' remain';
    return `${date} (${state})`;
}

if (typeof module !== 'undefined') module.exports = { parseAgenda, agendaAction, agendaSummary };
