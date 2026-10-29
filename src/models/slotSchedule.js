// The interval is the idle gap after each slot ends.
function build(now, durationUnits, intervalUnits, count) {
    if (
        !Number.isFinite(now) ||
        !Number.isInteger(durationUnits) ||
        durationUnits < 1 ||
        durationUnits > 16 ||
        !Number.isInteger(intervalUnits) ||
        intervalUnits < 1 ||
        intervalUnits > 96 ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > 20
    )
        throw new Error('Choose valid slot length, gap and count values.');
    const unit = 15 * 60000;
    const stride = durationUnits + intervalUnits;
    const start = Math.ceil((now + 30 * 60000) / unit) * unit;
    if (start + ((count - 1) * stride + durationUnits) * unit > now + 7 * 86400000)
        throw new Error('Keep the slot schedule within the next 7 days.');
    return Array.from({ length: count }, (_, i) => ({
        begin: new Date(start + i * stride * unit).toISOString(),
        end: new Date(start + (i * stride + durationUnits) * unit).toISOString(),
    }));
}
function manual(begin, end, now = Date.now()) {
    const parse = (value) => {
        const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(00|15|30|45)$/.exec(value || '');
        if (!match) throw new Error('Use YYYY-MM-DD HH:mm with minutes 00, 15, 30 or 45.');
        const [, y, m, d, h, min] = match.map(Number);
        const date = new Date(y, m - 1, d, h, min);
        if (
            date.getFullYear() !== y ||
            date.getMonth() !== m - 1 ||
            date.getDate() !== d ||
            date.getHours() !== h
        )
            throw new Error('Choose a valid date and time.');
        return date.getTime();
    };
    const start = parse(begin),
        finish = parse(end);
    if (start < now + 1800000) throw new Error('Start must be at least 30 minutes from now.');
    if (finish <= start) throw new Error('Choose a slot length of at least 15 minutes.');
    if (finish > now + 7 * 86400000) throw new Error('Keep the slot within the next 7 days.');
    return { begin: new Date(start).toISOString(), end: new Date(finish).toISOString() };
}
if (typeof module !== 'undefined') module.exports = { build, manual };
