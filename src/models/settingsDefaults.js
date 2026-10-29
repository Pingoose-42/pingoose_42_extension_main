// GSettings defaults have one source of truth: schemas/*.gschema.xml.
// Runtime request/status keys are not user preferences and are reset separately.
var CONTROL_KEYS = ['reset-request', 'reset-status', 'logout-request', 'update-check-request'];
var SERVICE_SITES = [
    { name: 'SUBAK', url: 'https://subak.site/' },
    { name: 'PeerFinder', url: 'https://peerfinder.org/' },
];
function restore(settings) {
    for (const key of settings.settings_schema.list_keys())
        if (!CONTROL_KEYS.includes(key)) settings.reset(key);
}
if (typeof module !== 'undefined') module.exports = { SERVICE_SITES };
