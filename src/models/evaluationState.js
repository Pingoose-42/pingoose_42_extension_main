// Evaluation state transitions only: no networking, timers, files or UI.
const Model = typeof require === 'function' ? require('./evaluations.js') : imports.models.evaluations;
const Feedback = typeof require === 'function' ? require('./evaluationFeedback.js') : imports.models.evaluationFeedback;

function reconcile(previous, subject, rows, completeList, time = Date.now()) {
    const missingNotices = [];
    const plan = Model.advanceSeen(previous, subject, rows);
    const retained = new Map(plan.state.evaluations.map(row => [row.id, row]));
    const previousRows = new Map(retained);
    for (const row of rows) if (!plan.state.dismissed.includes(row.id)) {
        const cached=retained.get(row.id);
        if(cached && Date.parse(cached.begin)<=time)continue;
        const remaining=Date.parse(row.begin)-time;
        const users=!row.users.length && cached?.begin===row.begin && remaining>0 && remaining<=899000
            ? cached.users : row.users;
        retained.set(row.id, {...cached,...row,slug:row.slug || cached?.slug || null,users,missing:false,missingAt:null});
    }
    // Monitor missing matches from first discovery, independently of the 15-minute seat window.
    const present=new Set(rows.map(row=>row.id));
    for(const [id,cached] of retained){
        if(!present.has(id) && Date.parse(cached.begin)>time && !cached.missing){
            const missing={...cached,missing:true,missingAt:time,chatConfirmedAt:{}};
            retained.set(id,missing);missingNotices.push(missing);
        }
    }
    // Only a successful, validated current-account response proves absence.
    // This also reconciles cards restored from disk on the first login poll.
    const completed = completeList ? Feedback.completedEvaluators([...retained.values()], rows, time) : [];
    for (const id of completed) retained.delete(id);
    plan.state.evaluations = [...retained.values()];
    dismiss(plan.state, completed);
    return {plan, previousRows, missingNotices};
}

function dismiss(state, ids) {
    const removed = new Set(ids);
    state.dismissed = [...new Set([...state.dismissed, ...ids])].slice(-2000);
    state.evaluations = state.evaluations.filter(row => !removed.has(row.id));
    state.reminders = state.reminders.filter(key => !removed.has(key.split(':')[0]));
}

if (typeof module !== 'undefined') module.exports = {reconcile, dismiss};
