function due(rows, category, minutes, now = Date.now()) {
    return rows
        .filter((row) => {
            if (category === 'agenda' && row.subscribed !== true) return false;
            const remaining = Date.parse(row.begin) - now;
            return (
                Number.isFinite(remaining) &&
                (minutes === 0
                    ? remaining <= 0 && remaining > -60000
                    : remaining > 0 && remaining <= minutes * 60000)
            );
        })
        .map((row) => ({
            type: 'notification',
            category: category === 'agenda' ? 'agenda' : 'evaluation',
            id: `start:${category}:${row.id}:${row.begin}`,
            startReminder: true,
            title: category === 'agenda' ? 'Agenda starting soon' : 'Evaluation starting soon',
            body: `${row.name || row.project || 'Evaluation'}\nStarts ${new Date(row.begin).toLocaleString()}`,
        }));
}
function immediateAllowed(message, settings) {
    if (message.startReminder) return true;
    if (message.category === 'agenda') return settings.get_boolean('notify-agenda-immediate');
    if (message.id?.startsWith('intrapy:'))
        return settings.get_boolean('notify-evaluation-immediate');
    return true;
}
if (typeof module !== 'undefined') module.exports = { due, immediateAllowed };
