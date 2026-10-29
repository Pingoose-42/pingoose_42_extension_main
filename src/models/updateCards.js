function bodies(commit) {
    const lines = (commit.changes?.length ? commit.changes : [commit]).map(
        (item) =>
            `${String(item.message || 'Update')
                .replace(/[\x00-\x1f\x7f]/g, ' ')
                .slice(0, 500)}`
    );
    lines.push(
        '\nRestart GNOME Shell: press Alt+F2, type r, and press Enter (X11). On Wayland, log out and back in.'
    );
    const pages = [];
    let body = '';
    for (const line of lines) {
        if (body && body.length + line.length + 1 > 950) {
            pages.push(body);
            body = '';
        }
        body += (body ? '\n' : '') + line;
    }
    if (body) pages.push(body);
    return pages;
}
