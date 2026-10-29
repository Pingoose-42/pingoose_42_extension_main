function summarizeLogtime(
    data,
    date = new Date(),
    { secondsMode = 'truncate', dailyLimit = '12h' } = {}
) {
    if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('invalid-logtime');
    const year = date.getFullYear(),
        month = String(date.getMonth() + 1).padStart(2, '0');
    const prefix = `${year}-${month}-`;
    const today = prefix + String(date.getDate()).padStart(2, '0');
    let total = 0,
        todaySeconds = null;
    for (let day = 1; day <= date.getDate(); day++) {
        const key = prefix + String(day).padStart(2, '0');
        const value = data[key];
        if (typeof value !== 'string' || !/^\d{2}:[0-5]\d:[0-5]\d$/.test(value))
            throw new Error('incomplete-logtime');
        const [h, m, s] = value.split(':').map(Number);
        if (h > 24) throw new Error('invalid-duration');
        let seconds = h * 3600 + m * 60 + s;
        if (dailyLimit === '12h') seconds = Math.min(seconds, 12 * 3600);
        if (secondsMode === 'truncate') seconds = Math.floor(seconds / 60) * 60;
        total += seconds;
        if (key === today) todaySeconds = seconds;
    }
    return {
        date: today,
        monthMinutes: Math.floor(total / 60),
        todayMinutes: Math.floor(todaySeconds / 60),
    };
}

if (typeof module !== 'undefined') module.exports = { summarizeLogtime };
