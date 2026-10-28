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
const {identifier} = loadEvaluations();

function ensureUtcSuffix(dateStr) {
    return /(?:Z|[+-]\d{2}:\d{2})$/.test(dateStr) ? dateStr : `${dateStr}Z`;
}

function parseNonNegativeInt(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeEventRow(row, feedback = false) {
    const id = identifier(row?.id);
    const name = row.name;
    const begin = row.begin_at ?? row.beginAt;
    const end = row.end_at ?? row.endAt;

    const isValidName = typeof name === 'string' && name.trim().length > 0 && name.length <= 500;
    const isValidBegin = typeof begin === 'string' && Number.isFinite(Date.parse(begin));
    const isValidEnd = typeof end === 'string' && Number.isFinite(Date.parse(end));

    if (!isValidName || !isValidBegin || !isValidEnd) {
        throw new Error('response-error');
    }

    const field = (snake, camel) => row[snake] ?? row[camel];
    const subscription = field('events_user_id', 'eventsUserId');
    const delay = field('unsubscription_delay', 'unsubscriptionDelay');
    const subscribedVal = field('is_subscribed', 'isSubscribed');

    return {
        id,
        name,
        begin: ensureUtcSuffix(begin),
        end: ensureUtcSuffix(end),
        feedback,
        kind: typeof row.kind === 'string' ? row.kind.slice(0, 60) : '',
        description: typeof row.description === 'string' ? row.description.slice(0, 30000) : '',
        subscribers: parseNonNegativeInt(field('nbr_subscribers', 'nbrSubscribers')),
        capacity: parseNonNegativeInt(field('max_subscribers', 'maxSubscribers')),
        subscribed: typeof subscribedVal === 'boolean' ? subscribedVal : null,
        subscriptionId: /^\d+$/.test(String(subscription ?? '')) ? String(subscription) : null,
        unsubscriptionDelay: typeof delay === 'number' && Number.isFinite(delay) && delay >= 0 ? delay : 0,
        waitlisted: field('is_waitlisted', 'isWaitlisted') === true,
        location: typeof row.location === 'string' ? row.location.slice(0, 200) : '',
    };
}

function parseAgenda(data, feedback = false) {
    if (!Array.isArray(data) || data.length > 1000) {
        throw new Error('response-error');
    }
    return data.map(row => normalizeEventRow(row, feedback));
}

function canSubscribe(row) {
    if (row.subscribed !== false || row.waitlisted) return false;
    if (row.capacity > 0 && (row.subscribers === null || row.subscribers >= row.capacity)) {
        return false;
    }
    return true;
}

function canUnsubscribe(row, now) {
    if (row.subscribed !== true || !/^\d+$/.test(String(row.subscriptionId ?? ''))) {
        return false;
    }
    const deadline = Date.parse(row.begin) - (row.unsubscriptionDelay || 0) * 3600000;
    return deadline > now;
}

// The same constraints used by the Intra agenda UI; the server remains authoritative.
function agendaAction(row, action, now = Date.now()) {
    if (!row || row.devTest || !/^\d+$/.test(String(row.id)) || !row.kind) return null;
    if (!['subscribe', 'unsubscribe'].includes(action)) return null;
    if (Date.parse(row.begin) <= now) return null;

    const group = row.kind === 'exam' ? 'exams' : 'events';
    let path = `/${group}/${row.id}/${group}_users`;

    if (action === 'subscribe') {
        if (!canSubscribe(row)) return null;
        return {
            method: 'POST',
            url: `https://profile.intra.42.fr${path}.json`,
        };
    }

    if (!canUnsubscribe(row, now)) return null;
    path += `/${row.subscriptionId}`;
    return {
        method: 'DELETE',
        url: `https://profile.intra.42.fr${path}.json`,
    };
}

function formatRemainingDuration(diffMs) {
    const totalMinutes = Math.max(0, Math.ceil(diffMs / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    const parts = [
        [days, 'd'],
        [hours, 'h'],
        [minutes, 'm'],
    ].filter(([val]) => val > 0).map(([val, unit]) => `${val} ${unit}`);

    return parts.join(' ') + ' remain';
}

function agendaSummary(row, now = Date.now()) {
    const start = new Date(row.begin);
    const startTime = start.getTime();
    const endTime = Date.parse(row.end);

    const year = start.getFullYear();
    const month = String(start.getMonth() + 1).padStart(2, '0');
    const day = String(start.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    let statusText;
    if (now >= startTime) {
        statusText = now < endTime ? 'In progress' : 'Ended';
    } else {
        statusText = formatRemainingDuration(startTime - now);
    }

    return `${dateStr} (${statusText})`;
}

if (typeof module !== 'undefined') {
    module.exports = {parseAgenda, agendaAction, agendaSummary};
}
