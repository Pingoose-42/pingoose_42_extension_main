const assert = require('node:assert/strict');
const M = require('../models/evaluationFeedback.js');
const Store = require('../models/evaluations.js');
const row = {
    id: '123',
    kind: 'evaluated',
    begin: '2026-01-01T00:00:00Z',
    project: 'Libft',
    users: [],
};
const item = {
    team: 'team-1',
    stamp: '2026-01-01 09:00:00 +0900',
    peer: 'peer',
    buttons: [{ id: '123', enabled: true }],
};
const page = { items: [item] };
const result = M.inspect(row, page, '42cursus-libft');
assert.equal(result.state, 'pending');
const watched = { ...row, feedbackWatch: result.watch };
assert.equal(
    M.inspect(watched, { items: [{ ...item, buttons: [] }] }, '42cursus-libft').state,
    'complete'
);
for (const data of [
    null,
    { items: [] },
    { items: [{ ...item, team: 'team-2', buttons: [] }] },
    { items: [{ ...item, buttons: [{ id: '123', enabled: false }] }] },
])
    assert.equal(M.inspect(watched, data, '42cursus-libft').state, 'unknown');
assert.equal(
    M.inspect(row, { items: [{ ...item, buttons: [] }] }, '42cursus-libft').state,
    'unknown'
);
assert.equal(M.inspect({ ...watched, devTest: true }, page, '42cursus-libft').state, 'unknown');
assert.equal(M.eligibleEvaluatee({ ...row, devTest: true }), false);
assert.equal(M.eligibleEvaluatee({ ...row, missing: true }), false);
assert.equal(M.eligibleEvaluatee({ ...row, begin: '2099-01-01T00:00:00Z' }), false);
const evaluator = { ...row, kind: 'evaluator' };
assert.deepEqual(M.completedEvaluators([evaluator], []), ['123']);
assert.deepEqual(M.completedEvaluators([evaluator], [evaluator]), []);
assert.deepEqual(M.completedEvaluators([{ ...evaluator, devTest: true }, row], []), []);
const state = Store.advanceSeen(null, 'fixture', []).state;
state.evaluations = [watched];
assert.deepEqual(
    Store.storedState(JSON.stringify(state)).evaluations[0].feedbackWatch,
    result.watch
);
console.log(
    'PASS: feedback retention, confirmed disappearance, failure safety, test exclusion and persistent baseline'
);
// Run the production DOM reader against a minimal representation of the observed page.
const vm = require('node:vm');
let href = '/scale_teams/123/feedbacks/new';
const link = {
    getAttribute: (n) => (n === 'href' ? href : null),
    hasAttribute: () => false,
    classList: { contains: () => false },
};
const header = {
    querySelector: (s) => ({
        getAttribute: () => (s.includes('long-date') ? item.stamp : item.peer),
    }),
};
const element = {
    querySelector: () => header,
    closest: () => ({ id: item.team }),
    querySelectorAll: () => (href ? [link] : []),
};
const context = {
    location: { origin: 'https://projects.intra.42.fr', pathname: '/42cursus-libft/me' },
    document: {
        readyState: 'complete',
        querySelector: () => ({}),
        querySelectorAll: (s) =>
            s === '[data-login]' ? [{ getAttribute: () => 'me' }] : [element],
    },
};
vm.createContext(context);
const read = () =>
    JSON.parse(
        JSON.stringify(
            vm.runInContext('(' + M.readPage.toString() + ')("me","42cursus-libft")', context)
        )
    );
assert.equal(M.inspect(row, read(), '42cursus-libft').state, 'pending');
href = null;
assert.equal(M.inspect(watched, read(), '42cursus-libft').state, 'complete');
context.document.readyState = 'loading';
assert.equal(read(), null);
context.document.readyState = 'complete';
context.location.pathname = '/42cursus-libft/someone';
assert.equal(read(), null);
console.log(
    'PASS: observed project DOM parsing, disappearing button, loading and wrong-account guards'
);
const offline = { ...row, users: ['peer'] };
assert.equal(
    M.inspect(offline, { items: [{ ...item, buttons: [] }] }, '42cursus-libft').state,
    'unknown'
);
assert.equal(
    M.inspect(
        offline,
        { items: [{ ...item, peer: 'someone-else', buttons: [] }] },
        '42cursus-libft'
    ).state,
    'unknown'
);
assert.equal(
    M.inspect(
        offline,
        { items: [{ ...item, stamp: '2026-01-02 09:00:00 +0900', buttons: [] }] },
        '42cursus-libft'
    ).state,
    'unknown'
);
assert.equal(
    M.inspect(
        offline,
        {
            items: [
                { ...item, buttons: [] },
                { ...item, buttons: [] },
            ],
        },
        '42cursus-libft'
    ).state,
    'unknown'
);
for (const elapsed of [1000, 30 * 60000, 3 * 3600000, 86400000]) {
    const ongoing = { ...offline, begin: new Date(Date.now() - elapsed).toISOString() };
    assert.equal(
        M.inspect(ongoing, { items: [{ ...item, buttons: [] }] }, '42cursus-libft').state,
        'unknown'
    );
}
assert.equal(M.inspect(watched, page, '42cursus-libft').state, 'pending');
assert.equal(M.inspect(watched, null, '42cursus-libft').state, 'unknown');
assert.equal(M.inspect(watched, { items: [] }, '42cursus-libft').state, 'unknown');
assert.equal(
    M.inspect(watched, { items: [{ ...item, buttons: [] }] }, '42cursus-libft').state,
    'complete'
);
console.log(
    'PASS: variable evaluation duration never proves completion; observed button transition does'
);
