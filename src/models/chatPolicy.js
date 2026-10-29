var WINDOW_MS = 899000;
function grantsFrom(rows, now = Date.now(), selfLogin = null) {
    return rows
        .filter(
            (row) =>
                !row.missing &&
                (!row.devTest ||
                    (row.devSelf &&
                        selfLogin &&
                        row.users?.length === 1 &&
                        row.users[0] === selfLogin)) &&
                Date.parse(row.begin) > now &&
                Date.parse(row.begin) - now <= WINDOW_MS
        )
        .flatMap((row) =>
            (row.users || [])
                .filter(
                    (login) =>
                        (row.devTest && row.devSelf && login === selfLogin) ||
                        (Number.isFinite(row.chatConfirmedAt?.[login]) &&
                            row.chatConfirmedAt[login] >= Date.parse(row.begin) - WINDOW_MS &&
                            row.chatConfirmedAt[login] <= now)
                )
                .map((login) => ({
                    id: String(row.id),
                    login,
                    testSelf: !!row.devTest,
                    seat: String(row.seats?.[login] || '').toLowerCase(),
                    expires: Date.parse(row.begin),
                }))
        )
        .filter(
            (grant) =>
                /^[a-zA-Z0-9_-]{1,64}$/.test(grant.login) && /^c\d+r\d+s\d+$/.test(grant.seat)
        );
}
function allowed(policy, seat, scope, remoteLogin = null, now = Date.now()) {
    if (!policy.active) return false;
    if (scope === 'general') return policy.general === true;
    return policy.grants.some(
        (grant) =>
            grant.seat === seat &&
            grant.id === scope &&
            grant.expires > now &&
            grant.expires - now <= WINDOW_MS &&
            (!remoteLogin || grant.login === remoteLogin)
    );
}
function accepts(policy, seat, hello, now = Date.now()) {
    return (
        hello?.protocol === 'pingoose-chat-2' &&
        hello.type === 'hello' &&
        typeof hello.login === 'string' &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(hello.login) &&
        typeof hello.scope === 'string' &&
        allowed(policy, seat, hello.scope, hello.login, now) &&
        (hello.scope !== 'general' || hello.general === true)
    );
}
if (typeof module !== 'undefined') module.exports = { grantsFrom, allowed, accepts, WINDOW_MS };
