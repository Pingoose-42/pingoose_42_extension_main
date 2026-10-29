// Match the requested identity in Intra responses, independently of location.
function fromResponse(data, login, depth = 0) {
    if (!data || typeof data !== 'object' || depth > 6) return null;
    if (!Array.isArray(data) && String(data.login || '').toLowerCase() === login) {
        const name =
            data.usual_full_name ||
            data.display_name ||
            data.displayname ||
            [data.first_name, data.last_name].filter(Boolean).join(' ') ||
            data.name;
        if (typeof name === 'string' && name.trim()) return { name: name.trim().slice(0, 100) };
    }
    for (const value of Object.values(data)) {
        const found = fromResponse(value, login, depth + 1);
        if (found) return found;
    }
    return null;
}
if (typeof module !== 'undefined') module.exports = { fromResponse };

// Intra v3 renders the profile portrait as a CSS background; the navbar's
// <img> belongs to the signed-in user and must not identify this profile.
function readDOM(login, ownProfile = false) {
    for (const heading of document.querySelectorAll('h2')) {
        const identity = heading.parentElement;
        // Optional Intra titles precede the login (e.g. ‘📟코딩선생 jungblee’).
        const displayedLogin = identity
            ?.querySelector('p')
            ?.textContent.trim()
            .toLowerCase()
            .match(/(?:^|\s)@?([a-z0-9_-]+)$/)?.[1];
        // The account owner sees a title selector instead of a login below h2.
        // Only accept this alternate layout on the authenticated home page.
        const ownHome =
            ownProfile &&
            typeof location !== 'undefined' &&
            location.pathname === '/' &&
            Array.from(document.querySelectorAll('button')).some(
                (button) => button.textContent.trim().toLowerCase() === login
            );
        const profilePage =
            typeof location !== 'undefined' &&
            location.pathname.replace(/\/$/, '') === '/users/' + login &&
            !!heading.closest?.('header, [role="banner"]');
        if (displayedLogin !== login && !ownHome && !profilePage) continue;
        const name = heading.textContent.trim().slice(0, 100);
        if (!name) continue;
        const region = identity.parentElement;
        let avatar = null;
        for (const element of region.querySelectorAll('[style], img')) {
            const url =
                element.tagName === 'IMG'
                    ? element.src
                    : element.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1];
            if (/^https:\/\/cdn\.intra\.42\.fr\/users\//.test(url || '')) {
                avatar = url;
                break;
            }
        }
        const banner = heading.closest?.('header, [role="banner"]');
        // The profile campus field uses the map-pin icon, unlike email/cursus/date.
        const campusButton =
            banner &&
            Array.from(banner.querySelectorAll('button')).find((button) =>
                button.querySelector('svg circle[cx="12"][cy="10"][r="3"]')
            );
        const campus = campusButton?.textContent.trim().toLowerCase() || null;
        return { profileLogin: login, name, avatar, campus };
    }
    return null;
}
if (typeof module !== 'undefined') module.exports.readDOM = readDOM;
