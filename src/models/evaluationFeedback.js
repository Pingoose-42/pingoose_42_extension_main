// Read only the signed-in user's project page. No form submission or API writes.
function readPage(login, slug) {
    if(location.origin!=='https://projects.intra.42.fr' || location.pathname.replace(/\/$/,'')!==`/${slug}/${login}` ||
        document.readyState!=='complete' || !document.querySelector('#teams-accordion') ||
        !Array.from(document.querySelectorAll('[data-login]')).some(e=>e.getAttribute('data-login')===login))return null;
    const items=Array.from(document.querySelectorAll('.corrected-item')).map(item=>{
        const header=item.querySelector('.corrected-header');
        const team=item.closest('[id^="team-"]')?.id;
        const stamp=header?.querySelector('[data-long-date]')?.getAttribute('data-long-date');
        const peer=header?.querySelector('[data-tooltip-login]')?.getAttribute('data-tooltip-login');
        const links=Array.from(item.querySelectorAll('a[href]')).filter(a=>/\/scale_teams\/\d+\/feedbacks\/new(?:[?#]|$)/.test(a.getAttribute('href')));
        return {team,stamp,peer,buttons:links.map(a=>({id:a.getAttribute('href').match(/\/scale_teams\/(\d+)\/feedbacks\/new/)[1],
            enabled:!a.hasAttribute('disabled') && a.getAttribute('aria-disabled')!=='true' && !a.classList.contains('disabled')}))};
    });
    return {items};
}
function inspect(row, page, slug) {
    if(!page || !Array.isArray(page.items) || row.devTest)return {state:'unknown'};
    const pending=page.items.find(item=>item.buttons.some(button=>button.id===String(row.id)));
    if(pending){
        if(!pending.buttons.some(button=>button.id===String(row.id) && button.enabled))return {state:'unknown'};
        return {state:'pending',watch:pending.team && pending.stamp && pending.peer ? {slug,team:pending.team,stamp:pending.stamp,peer:pending.peer}:null};
    }
    const watch=row.feedbackWatch;
    // Absence alone cannot distinguish an evaluation still in progress from
    // submitted feedback. Require a persisted observation of its active button.
    if(!watch || watch.slug!==slug)return {state:'unknown'};
    const same=page.items.filter(item=>item.team===watch.team && item.stamp===watch.stamp && item.peer===watch.peer);
    return {state:same.length===1 && same[0].buttons.length===0?'complete':'unknown'};
}
function eligibleEvaluatee(row, time = Date.now()) {
    return !row.devTest && !row.missing && ['evaluated','evaluatee','corrected'].includes(row.kind) && Date.parse(row.begin) <= time;
}
function completedEvaluators(cached, current, time = Date.now()) {
    const present = new Set(current.map(row => row.id));
    return cached.filter(row => !row.devTest && ['evaluator','corrector'].includes(row.kind) &&
        Date.parse(row.begin) <= time && !present.has(row.id)).map(row => row.id);
}
// Group requests by project so one page read serves every matching card.
function projectGroups(rows, projects = [], time = Date.now()) {
    const groups = new Map();
    for (const row of rows) {
        if (!eligibleEvaluatee(row, time)) continue;
        const slug = row.feedbackWatch?.slug || row.slug || projects.find(p =>
            p.name.toLowerCase() === row.project.toLowerCase())?.slug;
        if (!slug || !/^[a-zA-Z0-9_-]{1,100}$/.test(slug)) continue;
        if (!groups.has(slug)) groups.set(slug, []);
        groups.get(slug).push({id:row.id, begin:row.begin});
    }
    return groups;
}
if(typeof module!=='undefined')module.exports={readPage,inspect,eligibleEvaluatee,completedEvaluators,projectGroups};
