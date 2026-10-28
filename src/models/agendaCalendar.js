// RFC 5545 calendar snapshot. Dates remain UTC; desktop calendars localize them.
function escapeText(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n')
        .replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}
function fold(line) {
    let result = '', width = 0;
    for (const char of line) {
        const point = char.codePointAt(0);
        const bytes = point <= 127 ? 1 : point <= 2047 ? 2 : point <= 65535 ? 3 : 4;
        if (width + bytes > 75) { result += '\r\n '; width = 1; }
        result += char; width += bytes;
    }
    return result;
}
function stamp(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid agenda date');
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
function calendar(rows, subject) {
    if (!Array.isArray(rows) || !subject) throw new Error('Missing agenda snapshot');
    const events = new Map();
    for (const row of rows) {
        if (row.devTest) continue;
        if (!/^\d+$/.test(String(row.id)) || typeof row.name !== 'string' || !row.name.trim() ||
            !(Date.parse(row.end) > Date.parse(row.begin))) throw new Error('Invalid agenda event');
        const uid = `${encodeURIComponent(subject)}-${row.kind === 'exam' ? 'exam' : 'event'}-${row.id}@pingoose`;
        events.set(uid, ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp(row.begin)}`,
            `DTSTART:${stamp(row.begin)}`, `DTEND:${stamp(row.end)}`,
            `SUMMARY:${escapeText(row.name)}`, ...(row.location ? [`LOCATION:${escapeText(row.location)}`] : []),
            'TRANSP:TRANSPARENT', 'END:VEVENT']);
    }
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pingoose//Agenda//EN',
        'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Pingoose Agenda',
        ...[...events.keys()].sort().flatMap(uid => events.get(uid)), 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n';
}
// Keep completed events; missing future events may have been cancelled on Intra.
function retainPast(previous, current, now = Date.now()) {
    const key = row => `${row.kind === 'exam' ? 'exam' : 'event'}:${row.id}`;
    const merged = new Map(previous.filter(row => !row.devTest && Date.parse(row.end) <= now)
        .map(row => [key(row), row]));
    for (const row of current) if (!row.devTest) merged.set(key(row), row);
    return [...merged.values()];
}
function eventKey(subject, row) { return `${encodeURIComponent(subject)}:${row.kind === 'exam' ? 'exam' : 'event'}:${row.id}`; }
if (typeof module !== 'undefined') module.exports = {calendar, escapeText, fold, retainPast, eventKey};
