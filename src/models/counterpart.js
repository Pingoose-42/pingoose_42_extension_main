// Apply a validated lookup only to the same, still-upcoming evaluation.
function apply(state, row, login, result, time = Date.now()) {
    const stored = state?.evaluations.find(
        (item) => item.id === row.id && item.begin === row.begin
    );
    if (
        !stored ||
        stored.missing ||
        Date.parse(stored.begin) <= time ||
        !stored.users.includes(login)
    )
        return { changed: false };
    if (result.avatar) {
        stored.avatars = [...new Set([...(stored.avatars || []), login])];
        return { changed: true };
    }
    if (result.name) stored.names = { ...stored.names, [login]: result.name };
    if (!result.seat && !result.confirmedUnavailable) return { changed: !!result.name };
    const seat = result.seat || 'Unavailable';
    const notice = `${row.id}:lookup:${row.begin}:${login}`;
    const notify = !state.reminders.includes(notice) || stored.seats?.[login] !== seat;
    if (!state.reminders.includes(notice))
        state.reminders = [...state.reminders, notice].slice(-2000);
    stored.seats = { ...stored.seats, [login]: seat };
    stored.chatConfirmedAt = { ...stored.chatConfirmedAt };
    if (result.seat) stored.chatConfirmedAt[login] = time;
    else delete stored.chatConfirmedAt[login];
    return {
        changed: true,
        notification: notify
            ? {
                  type: 'notification',
                  update: true,
                  id: `reminder:${row.id}:${row.begin}:${login}`,
                  body: `Evaluation match confirmed · ${row.project}\n${login} · Seat: ${seat}`,
              }
            : null,
    };
}
if (typeof module !== 'undefined') module.exports = { apply };
