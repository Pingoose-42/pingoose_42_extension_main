const SLOT_UNIT_MS = 15 * 60 * 1000;
const LEAD_TIME_MS = 30 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function isValidInteger(value, min, max) {
    return Number.isInteger(value) && value >= min && value <= max;
}

function parseDateTimeString(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(00|15|30|45)$/.exec(value || '');
    if (!match) {
        throw new Error('Use YYYY-MM-DD HH:mm with minutes 00, 15, 30 or 45.');
    }

    const [, year, month, day, hour, minute] = match.map(Number);
    const date = new Date(year, month - 1, day, hour, minute);

    const matchesCalendar = date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day &&
        date.getHours() === hour;

    if (!matchesCalendar) {
        throw new Error('Choose a valid date and time.');
    }

    return date.getTime();
}

/**
 * Builds an automated schedule of evaluation slots with intervals.
 */
function build(now, durationUnits, intervalUnits, count) {
    const validParams = Number.isFinite(now) &&
        isValidInteger(durationUnits, 1, 16) &&
        isValidInteger(intervalUnits, 1, 96) &&
        isValidInteger(count, 1, 20);

    if (!validParams) {
        throw new Error('Choose valid slot length, gap and count values.');
    }

    const strideUnits = durationUnits + intervalUnits;
    const startTime = Math.ceil((now + LEAD_TIME_MS) / SLOT_UNIT_MS) * SLOT_UNIT_MS;
    const totalDurationMs = ((count - 1) * strideUnits + durationUnits) * SLOT_UNIT_MS;

    if (startTime + totalDurationMs > now + SEVEN_DAYS_MS) {
        throw new Error('Keep the slot schedule within the next 7 days.');
    }

    return Array.from({length: count}, (_, i) => {
        const slotStart = startTime + i * strideUnits * SLOT_UNIT_MS;
        const slotEnd = slotStart + durationUnits * SLOT_UNIT_MS;
        return {
            begin: new Date(slotStart).toISOString(),
            end: new Date(slotEnd).toISOString(),
        };
    });
}

/**
 * Validates and converts manually specified start and end strings.
 */
function manual(beginStr, endStr, now = Date.now()) {
    const startTime = parseDateTimeString(beginStr);
    const endTime = parseDateTimeString(endStr);

    if (startTime < now + LEAD_TIME_MS) {
        throw new Error('Start must be at least 30 minutes from now.');
    }
    if (endTime <= startTime) {
        throw new Error('Choose a slot length of at least 15 minutes.');
    }
    if (endTime > now + SEVEN_DAYS_MS) {
        throw new Error('Keep the slot within the next 7 days.');
    }

    return {
        begin: new Date(startTime).toISOString(),
        end: new Date(endTime).toISOString(),
    };
}

if (typeof module !== 'undefined') {
    module.exports = {build, manual};
}
