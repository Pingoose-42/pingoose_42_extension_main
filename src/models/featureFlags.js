// Advanced features are intentionally not exposed in release preferences.
// General settings can also unlock these options with a local phrase. This is a UI/product gate,
// not a security boundary against someone modifying their own client.
var HIDDEN_OPTIONS = false;
var DEVELOPMENT_DEFAULTS = false;
function unlocked(settings) {
    return settings.get_user_value('hidden-options-unlocked') === null
        ? HIDDEN_OPTIONS
        : settings.get_boolean('hidden-options-unlocked');
}
function unlock(settings, phrase) {
    const command = phrase.trim().toLowerCase();
    if (!['pingoose-hidden-on', 'pingoose-hidden-off'].includes(command)) return false;
    settings.set_boolean('hidden-options-unlocked', command === 'pingoose-hidden-on');
    return true;
}
function enabled(settings, key) {
    if (
        !['hidden-cluster-chat', 'hidden-auto-slots', 'hidden-dev-options'].includes(key) ||
        !unlocked(settings)
    )
        return false;
    return settings.get_user_value(key) === null ? DEVELOPMENT_DEFAULTS : settings.get_boolean(key);
}
