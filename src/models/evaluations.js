// Shared validation and ID tracking; no credentials, networking or desktop access.
const ISSUER = 'https://auth.42.fr/auth/realms/students-42';
const MAX_SEEN = 2000;

function identifier(value) {
    if (Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) && !/^0+$/.test(value)) {
        return value;
    }
    throw new Error('response-error');
}

function claimsInfo(claims, login) {
    const isValidClaims = Boolean(
        claims &&
        claims.iss === ISSUER &&
        typeof claims.sub === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(claims.sub) &&
        Number.isFinite(claims.exp) &&
        claims.exp > 0
    );

    if (!isValidClaims) throw new Error('auth-error');
    if (claims.preferred_username !== login) throw new Error('account-error');

    // This checks account selection, not a JWT signature; the HTTPS API validates authentication.
    return {subject: claims.sub, login};
}

function validateAndFormatBeginDate(rawBegin) {
    const begin = typeof rawBegin === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/.test(rawBegin)
        ? `${rawBegin}Z`
        : rawBegin;

    const match = typeof begin === 'string' && begin.match(
        /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/
    );

    if (!match || !Number.isFinite(Date.parse(begin))) {
        throw new Error('response-error');
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const calendar = new Date(Date.UTC(year, month - 1, day));

    if (
        calendar.getUTCFullYear() !== year ||
        calendar.getUTCMonth() + 1 !== month ||
        calendar.getUTCDate() !== day
    ) {
        throw new Error('response-error');
    }

    return begin;
}

function extractEvaluationUsers(row) {
    const isEvaluatorRole = row.kind === 'evaluator' || row.kind === 'corrector';
    const fallbackCandidates = isEvaluatorRole
        ? (row.correcteds || row.evaluated || [])
        : (row.corrector || row.evaluator || []);

    const candidates = row.user ?? fallbackCandidates;
    const userList = Array.isArray(candidates) ? candidates : [candidates];

    const logins = userList
        .map(user => (typeof user === 'string' ? user : user?.login))
        .filter(login => typeof login === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(login));

    return [...new Set(logins)].slice(0, 10);
}

function parseRows(data) {
    if (!Array.isArray(data) || data.length > 1000) throw new Error('response-error');

    const VALID_KINDS = ['evaluator', 'evaluated', 'corrector', 'corrected', 'evaluatee'];
    const ids = new Set();
    const result = [];

    for (const row of data) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('response-error');

        const id = identifier(row.id);
        const rawBegin = row.begin_at ?? row.beginAt;
        const begin = validateAndFormatBeginDate(rawBegin);
        const project = row.project_name ?? row.projectName;

        if (
            ids.has(id) ||
            typeof row.kind !== 'string' ||
            !row.kind ||
            row.kind.length > 40 ||
            (project != null && (typeof project !== 'string' || project.length > 500))
        ) {
            throw new Error('response-error');
        }

        ids.add(id);

        if (VALID_KINDS.includes(row.kind)) {
            const users = extractEvaluationUsers(row);
            const slug = typeof row.project_slug === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(row.project_slug)
                ? row.project_slug
                : null;

            result.push({
                id,
                begin,
                project: project || '',
                kind: row.kind,
                users,
                slug,
            });
        }
    }
    return result;
}

function storedState(text) {
    const state = JSON.parse(text);
    if (
        !state ||
        state.version !== 1 ||
        typeof state.subject !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(state.subject) ||
        !Array.isArray(state.ids) ||
        state.ids.length > MAX_SEEN ||
        state.ids.some(id => typeof id !== 'string' || identifier(id) !== id) ||
        new Set(state.ids).size !== state.ids.length
    ) {
        throw new Error('storage-error');
    }

    for (const field of ['dismissed', 'reminders', 'agendaIds']) {
        if (state[field] === undefined) state[field] = [];
        if (
            !Array.isArray(state[field]) ||
            state[field].length > MAX_SEEN ||
            state[field].some(value => typeof value !== 'string' || value.length > 512)
        ) {
            throw new Error('storage-error');
        }
    }

    if (state.evaluations === undefined) state.evaluations = [];
    if (!Array.isArray(state.evaluations) || state.evaluations.length > 10000) {
        throw new Error('storage-error');
    }

    state.evaluations = state.evaluations.map(row => {
        const parsed = parseRows([{
            ...row,
            begin_at: row.begin,
            project_name: row.project,
            user: row.users,
            project_slug: row.slug,
        }])[0];
        if (!parsed) throw new Error('storage-error');

        const watch = row.feedbackWatch;
        if (
            watch &&
            /^[a-zA-Z0-9_-]{1,100}$/.test(watch.slug) &&
            /^team-\d+$/.test(watch.team) &&
            typeof watch.stamp === 'string' &&
            watch.stamp.length <= 100 &&
            /^[a-zA-Z0-9_-]{1,64}$/.test(watch.peer)
        ) {
            parsed.feedbackWatch = {slug: watch.slug, team: watch.team, stamp: watch.stamp, peer: watch.peer};
        }

        if (row.devTest === true) parsed.devTest = true;
        parsed.missing = row.missing === true;
        parsed.missingAt = Number.isFinite(row.missingAt) ? row.missingAt : null;
        parsed.avatars = Array.isArray(row.avatars) ? row.avatars.filter(login => parsed.users.includes(login)) : [];
        parsed.names = {};
        parsed.seats = {};
        parsed.chatConfirmedAt = {};

        for (const login of parsed.users) {
            if (typeof row.names?.[login] === 'string') parsed.names[login] = row.names[login].slice(0, 100);
            const seat = row.seats?.[login];
            if (Number.isFinite(row.chatConfirmedAt?.[login])) parsed.chatConfirmedAt[login] = row.chatConfirmedAt[login];
            if (typeof seat === 'string' && (seat === 'Unavailable' || /^c[0-9]+r[0-9]+s[0-9]+$/i.test(seat))) {
                parsed.seats[login] = seat;
            }
        }
        return parsed;
    });

    return state;
}

function advanceSeen(previous, subject, rows) {
    const baseline = previous !== null && previous.subject === subject;
    const old = baseline ? previous.ids : [];
    const seen = new Set(old);
    const ids = [...new Set([...rows.map(row => row.id), ...old])].slice(0, MAX_SEEN);

    return {
        state: {
            version: 1,
            subject,
            ids,
            evaluations: baseline ? (previous.evaluations || []) : [],
            dismissed: baseline ? (previous.dismissed || []) : [],
            reminders: baseline ? (previous.reminders || []) : [],
            agendaIds: baseline ? (previous.agendaIds || []) : [],
        },
        added: rows.filter(row => !seen.has(row.id) && !(baseline && previous.dismissed?.includes(row.id))),
    };
}

function retryAfter(value, now = Date.now()) {
    if (typeof value !== 'string' || value.length > 100) return 0;
    if (/^\d+$/.test(value)) {
        const seconds = Number(value);
        return Number.isSafeInteger(seconds) ? seconds : 0;
    }
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : 0;
}

function notification(row) {
    const date = new Date(row.begin);
    const pad = value => String(value).padStart(2, '0');
    const when = `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const project = (row.project || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
    const roleText = row.kind === 'evaluator' || row.kind === 'corrector' ? 'Evaluator' : 'Evaluatee';

    return {
        type: 'notification',
        id: `intrapy:${row.id}`,
        body: `You have been matched with someone.\n${roleText} · ${when}${project ? ` · ${project}` : ''}`,
    };
}

if (typeof module !== 'undefined') {
    module.exports = {
        identifier,
        claimsInfo,
        parseRows,
        storedState,
        advanceSeen,
        retryAfter,
        notification,
    };
}
