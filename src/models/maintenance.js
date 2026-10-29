// Parse only explicitly UTC-dated maintenance notices; never guess a timezone.
function parse(text) {
    if (typeof text !== 'string' || !/scheduled maintenance/i.test(text)) return null;
    const m = text.match(
        /\b(\d{2})\/(\d{2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})\s*UTC\b/i
    );
    if (!m) return null;
    const [day, month, year, hour, minute, endHour, endMinute] = m.slice(1).map(Number);
    if (hour > 23 || endHour > 23 || minute > 59 || endMinute > 59) return null;
    const start = Date.UTC(year, month - 1, day, hour, minute);
    const date = new Date(start);
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    )
        return null;
    let end = Date.UTC(year, month - 1, day, endHour, endMinute);
    if (end < start) end += 86400000;
    return valid({ start, end }) ? { start, end } : null;
}
function valid(value) {
    return (
        !!value &&
        Number.isFinite(value.start) &&
        Number.isFinite(value.end) &&
        value.end > value.start &&
        value.end - value.start <= 86400000
    );
}
function active(value, time = Date.now()) {
    return valid(value) && time >= value.start && time < value.end;
}
function label(value) {
    const format = new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
    });
    return `${format.format(new Date(value.start))} – ${format.format(new Date(value.end))}`;
}
if (typeof module !== 'undefined') module.exports = { parse, valid, active, label };
