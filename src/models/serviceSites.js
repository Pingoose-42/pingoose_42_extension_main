function loadDefaults() {
    if (typeof module !== 'undefined') return require('./settingsDefaults.js');
    // Standalone WebKit workers add the source root to their import path.
    try {
        return imports.models.settingsDefaults;
    } catch (_) {
        return imports.misc.extensionUtils.getCurrentExtension().imports.models.settingsDefaults;
    }
}
const Defaults = loadDefaults();
var DEFAULT_SITES = Defaults.SERVICE_SITES;
function normalizeSite(name, url) {
    name = String(name || '').trim();
    url = String(url || '').trim();
    if (
        !name ||
        name.length > 80 ||
        url.length > 2048 ||
        !/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?(?:[/?#][^\s]*)?$/i.test(url)
    )
        return null;
    return { name, url };
}
function readSites(settings) {
    const value = settings.get_string('service-sites');
    if (!value) return DEFAULT_SITES.map((site) => ({ ...site }));
    try {
        const data = JSON.parse(value);
        if (!Array.isArray(data)) return [];
        return data
            .slice(0, 30)
            .map((site) => normalizeSite(site?.name, site?.url))
            .filter(Boolean);
    } catch (_) {
        return [];
    }
}
if (typeof module !== 'undefined') module.exports = { DEFAULT_SITES, normalizeSite, readSites };
