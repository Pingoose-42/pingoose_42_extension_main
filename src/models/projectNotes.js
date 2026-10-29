// Legacy lists used a single record for many tasks. Stable derived IDs keep
// each line independently editable/deletable before the next atomic write.
function splitTasks(rows) {
    return rows.flatMap((note) => {
        if (note.kind !== 'todo') return [note];
        const lines = note.body.split('\n').filter((line) => line.trim());
        return lines.map((body, index) => ({
            ...note,
            body,
            id: index === 0 ? note.id : `${note.id}:task:${index}`,
        }));
    });
}
function grouped(rows) {
    const groups = new Map();
    for (const note of rows) {
        const key = `${note.login}:${note.project}`;
        if (!groups.has(key))
            groups.set(key, {
                login: note.login,
                project: note.project,
                name: note.projectName || note.project,
                rows: [],
            });
        groups.get(key).rows.push(note);
    }
    return [...groups.values()].sort(
        (a, b) =>
            Number(b.project === '__my_projects__') - Number(a.project === '__my_projects__') ||
            a.name.localeCompare(b.name) ||
            String(a.login).localeCompare(String(b.login))
    );
}

if (typeof module !== 'undefined') module.exports = { splitTasks, grouped };
