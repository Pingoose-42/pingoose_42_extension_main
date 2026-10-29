const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const worker = fs.readFileSync('src/worker/profile.js', 'utf8');
const context = {
    document: {
        body: { innerText: '' },
        images: [],
        querySelector: () => ({ textContent: 'Fixture' }),
        querySelectorAll: () => [],
    },
    navigator: { language: 'en-US' },
};
vm.createContext(context);
vm.runInContext(worker, context);
for (const kind of ['Ultimate', 'Milestone']) {
    context.document.body.innerText = `${kind} Deadline : 2026. 10. 18. Projects`;
    const data = JSON.parse(context.readProfileDOM('fixture'));
    assert.equal(data.deadline, '2026-10-18');
    assert.equal(data.deadlineKind, kind.toLowerCase());
}
for (const [label, kind] of [
    ['Blackholed at', 'blackhole'],
    ['Black holed at', 'blackhole'],
    ['Alumnization', 'alumnization'],
    ['Alumnization at', 'alumnization'],
    ['Alumnisation', 'alumnization'],
]) {
    for (const raw of ['2026-10-18', '2026. 10. 18.', '10/18/2026']) {
        context.document.body.innerText = `Pace 24 ${label}: ${raw} Projects`;
        const data = JSON.parse(context.readProfileDOM('fixture'));
        assert.equal(data.deadline, '2026-10-18');
        assert.equal(data.deadlineKind, kind);
    }
    context.document.body.innerText = `${label}: 2026-02-30 Projects`;
    assert.equal(JSON.parse(context.readProfileDOM('fixture')).deadline, null);
}
const source = fs.readFileSync('src/ui/indicator.js', 'utf8');
let time = 1000000;
context.GLib = { get_monotonic_time: () => time };
vm.runInContext(
    'class Probe {' +
        source.slice(
            source.indexOf('    checkProfileReady()'),
            source.indexOf('    refreshLogtimeTitle()')
        ) +
        '};globalThis.Probe=Probe',
    context
);
const p = new context.Probe();
p.lastProfile = { name: 'Fixture', level: 4 };
p.profileLoadStarted = time;
p.profileLoading = { hide() {} };
p.profileContent = { show() {} };
p.count = {};
p.checkProfileReady();
assert.ok(!p.profileReady);
time += 30000000;
p.checkProfileReady();
assert.equal(p.profileReady, true);
assert.equal(p.count.text, '42');
console.log(
    'PASS: Ultimate/Milestone deadline extraction; loading waits initially and recovers after missing-resource timeout'
);
context.deadlineText = (value) => value || '—';
vm.runInContext(
    'class ProfileProbe {' +
        source.slice(
            source.indexOf('    updateProfile(data)'),
            source.indexOf('    updateProjects(data)')
        ) +
        '};globalThis.ProfileProbe=ProfileProbe',
    context
);
const cached = new context.ProfileProbe();
cached.checkProfileReady = () => {};
let projectUpdates = 0;
cached.updateProjects = () => projectUpdates++;
for (const key of [
    'profileName',
    'profileLogin',
    'profileLevel',
    'profilePercent',
    'profileProgress',
    'profilePoints',
    'profilePace',
    'deadlineCaption',
    'profileDeadline',
])
    cached[key] = { add_style_class_name() {}, remove_style_class_name() {} };
const complete = {
    login: 'fixture',
    name: 'Fixture',
    level: 4,
    progress: 50,
    points: 7,
    pace: 24,
    deadline: '2026-10-18',
    projects: [{ name: 'Example', slug: 'example' }],
};
cached.updateProfile(complete);
cached.updateProfile({ ...complete });
assert.equal(projectUpdates, 1);
cached.updateProfile({
    login: 'fixture',
    name: '',
    level: null,
    progress: null,
    points: null,
    pace: null,
    deadline: null,
    projects: null,
});
assert.equal(projectUpdates, 1);
assert.equal(cached.lastProfile.level, 4);
assert.equal(cached.profileDeadline.text, '2026-10-18');
cached.updateProfile({ ...complete, progress: 51, projects: [] });
assert.equal(cached.profilePercent.text, '(51%)');
assert.equal(cached.lastProfile.projects.length, 0);
console.log(
    'PASS: unchanged and partial profile snapshots do not repaint; changed progress and confirmed empty projects update'
);

cached.updateProfile({ ...complete, progress: 0 });
assert.equal(cached.lastProfile.progress, 51, 'transient zero must retain cached experience');
time += 2000000;
cached.updateProfile({ ...complete, progress: 51 });
assert.equal(cached.lastProfile.progress, 51);
cached.updateProfile({ ...complete, level: 5, progress: 0 });
assert.equal(cached.lastProfile.level, 5, 'level-up is immediate');
assert.equal(cached.lastProfile.progress, 0);
cached.updateProfile({ ...complete, level: 5, progress: 60 });
cached.updateProfile({ ...complete, level: 5, progress: 40 });
assert.equal(cached.lastProfile.progress, 60);
time += 5000000;
cached.updateProfile({ ...complete, level: 5, progress: 40 });
assert.equal(cached.lastProfile.progress, 40, 'confirmed correction must eventually apply');
let widthWrites = 0,
    width = cached.profileProgress.width;
Object.defineProperty(cached.profileProgress, 'width', {
    get: () => width,
    set: (value) => {
        widthWrites++;
        width = value;
    },
});
cached.updateProfile({ ...complete, level: 5, progress: 40, points: 99 });
assert.equal(widthWrites, 0, 'unrelated changes must not reset the experience width');
console.log(
    'PASS: transient zero ignored, level-up accepted, stable corrections accepted and unchanged bar untouched'
);
for (const [cursus, expected] of [
    ['Pisciner at C Piscine', false],
    ['Transcender at 42cursus', false],
    ['Alumni at 42cursus', false],
    ['Cadet at 42cursus', true],
]) {
    context.document.querySelector = (selector) => ({
        textContent: selector === '[role="combobox"]' ? cursus : 'Fixture',
    });
    context.document.body.innerText = 'Pace 24 Projects C Piscine';
    assert.equal(JSON.parse(context.readProfileDOM('fixture')).paceApplicable, expected);
}
context.document.body.innerText = 'Alumnization : 2027. 1. 1. Pace 24';
assert.equal(JSON.parse(context.readProfileDOM('fixture')).paceApplicable, false);
cached.updateProfile({ ...complete, paceApplicable: false });
assert.equal(cached.profilePace.visible, false);
cached.updateProfile({ ...complete, paceApplicable: true, deadlineKind: 'milestone' });
assert.equal(cached.profilePace.visible, true);
cached.updateProfile({ ...complete, paceApplicable: true, deadlineKind: 'alumnization' });
assert.equal(cached.profilePace.visible, false);
console.log(
    'PASS: no Pace for Piscine/Transcender/Alumni; Cadet remains visible despite past Piscine text'
);
