// Meta's initial snapshot can include ended locations; only active seats count.
function snapshot(rows, campus) {
    if (!Array.isArray(rows) || !/^\d+$/.test(campus)) throw new Error('Invalid snapshot');
    const seats = Object.create(null);
    for (const row of rows) {
        if (!row || typeof row.login !== 'string' || !/^\d+$/.test(String(row.campus_id)))
            throw new Error('Invalid location');
        if (String(row.campus_id) !== campus || row.end_at) continue;
        const login = row.login.toLowerCase();
        const host = String(row.host || '').toLowerCase();
        const seat = host.split('.')[0];
        if (/^[a-z0-9_-]{1,64}$/.test(login) && /^c\d+r\d+s\d+$/.test(seat)) seats[login] = seat;
    }
    return { campus, seats };
}
