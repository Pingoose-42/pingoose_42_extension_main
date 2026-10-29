const assert = require('node:assert/strict');
const State = require('../models/evaluationState.js');
const Model = require('../models/evaluations.js');
const Feedback = require('../models/evaluationFeedback.js');
const time = Date.parse('2026-01-01T00:00:00Z');
const row = {
    id: '1',
    kind: 'evaluated',
    begin: new Date(time - 1000).toISOString(),
    users: ['peer'],
    project: 'Libft',
    slug: '42cursus-libft',
};
const previous = Model.advanceSeen(null, 'account', []).state;
previous.evaluations = [row];
previous.reminders = ['1:soon', '10:soon'];
const original = JSON.stringify(previous);
const result = State.reconcile(previous, 'account', [], true, time);
assert.equal(JSON.stringify(previous), original, 'reconciliation must not mutate stored input');
assert.equal(result.plan.state.evaluations.length, 1, 'evaluatee retained');
State.dismiss(result.plan.state, ['1']);
assert.deepEqual(result.plan.state.reminders, ['10:soon']);
assert.deepEqual(result.plan.state.dismissed, ['1']);
const evaluator = { ...row, kind: 'evaluator' };
previous.evaluations = [evaluator];
assert.equal(
    State.reconcile(previous, 'account', [], false, time).plan.state.evaluations.length,
    1
);
assert.equal(State.reconcile(previous, 'account', [], true, time).plan.state.evaluations.length, 0);
assert.equal(
    State.reconcile(previous, 'account', [], true, time - 2000).plan.state.evaluations.length,
    1
);
const groups = Feedback.projectGroups(
    [row, { ...row, id: '2' }, { ...row, id: '3', devTest: true }, evaluator],
    [],
    time
);
assert.equal(groups.size, 1);
assert.deepEqual(
    groups.get(row.slug).map((r) => r.id),
    ['1', '2']
);
assert.equal(
    Feedback.projectGroups([{ ...row, slug: null }], [{ name: 'Libft', slug: row.slug }], time)
        .size,
    1
);
console.log(
    'PASS: pure reconciliation, deterministic time, dismissal and grouped feedback requests'
);
