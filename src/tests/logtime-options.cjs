const assert = require('node:assert/strict');
const fs = require('node:fs'),
    vm = require('node:vm');
const context = {};
vm.createContext(context);
vm.runInContext(fs.readFileSync('src/models/logtime.js', 'utf8'), context);
const data = { '2026-10-01': '15:30:45', '2026-10-02': '01:00:40', '2026-10-03': '01:00:40' };
const date = new Date(2026, 9, 3);
const result = (options) => context.summarizeLogtime(data, date, options);
assert.equal(result().monthMinutes, 840);
assert.equal(result({ secondsMode: 'sum', dailyLimit: '12h' }).monthMinutes, 841);
assert.equal(result({ secondsMode: 'truncate', dailyLimit: 'all' }).monthMinutes, 1050);
assert.equal(result({ secondsMode: 'sum', dailyLimit: 'all' }).monthMinutes, 1052);
assert.equal(context.summarizeLogtime(data, new Date(2026, 9, 1)).todayMinutes, 720);
assert.equal(
    context.summarizeLogtime(data, new Date(2026, 9, 1), { dailyLimit: 'all' }).todayMinutes,
    930
);
assert.throws(() => context.summarizeLogtime({}, date));
assert.equal(
    context.summarizeLogtime({ '2026-11-01': '00:00:59' }, new Date(2026, 10, 1)).monthMinutes,
    0
);
console.log('PASS: all four logtime modes, daily cap, Today, month boundary and incomplete data');
