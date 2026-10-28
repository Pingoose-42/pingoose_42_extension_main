var WINDOW_MS = 899000;

function isUpcomingWithinWindow(beginIsoString, now) {
    const timeUntilStart = Date.parse(beginIsoString) - now;
    return timeUntilStart > 0 && timeUntilStart <= WINDOW_MS;
}

function isDevSelfMatch(row, selfLogin) {
    return Boolean(
        row.devTest &&
        row.devSelf &&
        selfLogin &&
        row.users?.length === 1 &&
        row.users[0] === selfLogin
    );
}

function isSeatConfirmedRecently(row, login, now) {
    const confirmedAt = row.chatConfirmedAt?.[login];
    const windowStart = Date.parse(row.begin) - WINDOW_MS;
    return Number.isFinite(confirmedAt) && confirmedAt >= windowStart && confirmedAt <= now;
}

function isValidGrant(grant) {
    const validLogin = /^[a-zA-Z0-9_-]{1,64}$/.test(grant.login);
    const validSeat = /^c\d+r\d+s\d+$/.test(grant.seat);
    return validLogin && validSeat;
}

function grantsFrom(rows, now = Date.now(), selfLogin = null) {
    const eligibleRows = rows.filter(row => {
        if (row.missing) return false;
        if (row.devTest && !isDevSelfMatch(row, selfLogin)) return false;
        return isUpcomingWithinWindow(row.begin, now);
    });

    return eligibleRows.flatMap(row => {
        const users = row.users || [];
        return users
            .filter(login => isDevSelfMatch(row, selfLogin) || isSeatConfirmedRecently(row, login, now))
            .map(login => ({
                id: String(row.id),
                login,
                testSelf: Boolean(row.devTest),
                seat: String(row.seats?.[login] || '').toLowerCase(),
                expires: Date.parse(row.begin),
            }));
    }).filter(isValidGrant);
}

function allowed(policy, seat, scope, remoteLogin = null, now = Date.now()) {
    if (!policy.active) return false;
    if (scope === 'general') return policy.general === true;

    return policy.grants.some(grant => {
        const seatMatches = grant.seat === seat;
        const scopeMatches = grant.id === scope;
        const notExpired = grant.expires > now && (grant.expires - now) <= WINDOW_MS;
        const loginMatches = !remoteLogin || grant.login === remoteLogin;
        return seatMatches && scopeMatches && notExpired && loginMatches;
    });
}

function accepts(policy, seat, hello, now = Date.now()) {
    if (!hello || typeof hello !== 'object') return false;
    if (hello.protocol !== 'pingoose-chat-2' || hello.type !== 'hello') return false;
    if (typeof hello.login !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(hello.login)) return false;
    if (typeof hello.scope !== 'string') return false;

    if (!allowed(policy, seat, hello.scope, hello.login, now)) return false;
    return hello.scope !== 'general' || hello.general === true;
}

if (typeof module !== 'undefined') {
    module.exports = {grantsFrom, allowed, accepts, WINDOW_MS};
}
