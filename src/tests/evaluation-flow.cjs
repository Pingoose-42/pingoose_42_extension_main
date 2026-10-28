const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const model = require('../models/evaluations.js');
const row = {id: 123, kind: 'evaluator', begin_at: '2026-10-20T18:45:00+09:00', project_name: 'Codexion'};
let state = model.advanceSeen(null, 'subject', model.parseRows([])).state;
let plan = model.advanceSeen(state, 'subject', model.parseRows([row]));
assert.equal(plan.added.length, 1);
const event = model.notification(plan.added[0]);
assert.match(event.body, /Codexion/);
state = model.storedState(JSON.stringify(plan.state));
assert.equal(model.advanceSeen(state, 'subject', model.parseRows([row])).added.length, 0);
assert.equal(model.advanceSeen(null, 'subject', model.parseRows([row])).added.length, 1);
assert.equal(model.parseRows([{...row, kind: 'evaluated'}]).length, 1);
assert.throws(() => model.parseRows([{...row, begin_at: 'invalid'}]));
assert.equal(model.advanceSeen(state, 'subject', model.parseRows([row, {...row,id:124}])).added.length, 1);
const source = require('./source.cjs');
class Actor {
 constructor(props={}) {Object.assign(this,props);this.children=[];this.clutter_text={};}
 add_child(child){this.children.push(child);}
 set_child(child){this.child=child;this.label=child.text;}
 remove_all_children(){this.children=[];}
 set_style(){}
 add_style_class_name(){}
 connect(name, fn){this[name]=fn;}
}
class Section {constructor(){this.items=[];} removeAll(){this.items=[];} addMenuItem(i){this.items.push(i);}}
let banners=0;
const profileMenus=[];
class Menu {constructor(){this.actor={hide(){}};profileMenus.push(this);}addAction(label,action){this.action=action;}toggle(){this.toggled=true;}close(){}destroy(){}}
const context={imports:{ui:{main:{uiGroup:{add_child(){}}}}},PopupMenu:{PopupMenu:Menu,PopupBaseMenuItem:Actor,PopupMenuItem:Actor},St:{Side:{TOP:0},BoxLayout:Actor,Label:Actor,Button:Actor,Bin:Actor,Icon:Actor},Clutter:{ActorAlign:{CENTER:0,END:1}},Pango:{WrapMode:{WORD_CHAR:0},EllipsizeMode:{NONE:0}},Main:{notify(){banners++;}},GLib:{DateTime:{new_now_local:()=>({format:()=> '18:45'})}}};
context.imports.misc={extensionUtils:{getCurrentExtension:()=>({imports:{models:{startReminders:require('../models/startReminders')}}})}};
vm.createContext(context);
vm.runInContext('class Probe {'+source.slice(source.indexOf('    _message(message)'),source.indexOf('    _flashScreen('))+source.slice(source.indexOf('    _renderCards()'),source.indexOf('    disable()'))+'}; globalThis.Probe=Probe;',context);
const p=new context.Probe();p._settings={get_boolean:()=>true};p._saveCardState=()=>{};p._syncOptionalSections=()=>{};p._updatePanelLabel=()=>{};p._notifications=[];p._indicator={cards:new Section(),menu:{isOpen:false},count:{},profileReady:true,loginOnly:false};p._flashScreen=()=>{};p._showBanner=()=>{banners++;};
p._message(event);
assert.equal(p._notifications.length,1);assert.equal(banners,1);assert.equal(p._indicator.cards.items.length,2);
p._message(event);assert.equal(banners,1);
for(let id=124;id<130;id++)p._message(model.notification({...model.parseRows([row])[0],id:String(id)}));
assert.equal(p._notifications.length,7);
const dismiss=p._indicator.cards.items[0].children[0];dismiss.clicked();assert.equal(p._notifications.length,6);
const footer=p._indicator.cards.items.at(-1);footer.children[0].clicked();assert.equal(p._notifications.length,0);assert.equal(p._indicator.cards.items.length,0);
const countBefore=banners;
p._message(event);
assert.equal(p._notifications.length,0,'cleared notification must not reappear');
assert.equal(banners,countBefore,'cleared notification must not repeat its system banner');
console.log('PASS: new evaluation → notification → card; duplicate/restart/baseline; malformed response; retained card history; individual and clear-all deletion');

assert.equal(model.parseRows([{...row, begin_at: '2026-10-20T09:45:00', user: 'peer'}])[0].begin, '2026-10-20T09:45:00Z');
assert.deepEqual(model.parseRows([{...row, kind:'evaluated', user:'peer'}])[0].users, ['peer']);
vm.runInContext('class EvaluationProbe {'+source.slice(source.indexOf('    _evaluationRelativeTime('),source.indexOf('    _renderCards()'))+'}; globalThis.EvaluationProbe=EvaluationProbe;',context);
const e=new context.EvaluationProbe();e._syncOptionalSections=()=>{};e._indicator={evaluations:new Section(),menu:{connect(){return 1;},disconnect(){}}};e._optionsManager={addMenu(){},removeMenu(){}};e._feedback={};e._send=command=>{e.sent=command;};
e._evaluations=[{id:'42',project:'Codexion',kind:'evaluated',begin:new Date(Date.now()-1000).toISOString(),users:['peer']}];
e._renderEvaluations();
let box=e._indicator.evaluations.items[0].children[0];
assert.equal(box.children.at(-1).label,'Have you submitted your evaluation feedback?');
box.children.at(-1).clicked();box=e._indicator.evaluations.items[0].children[0];
assert.equal(box.children.at(-1).children[0].label,'Yes');box.children.at(-1).children[1].clicked();
box=e._indicator.evaluations.items[0].children[0];assert.equal(box.children.at(-1).children[0].label,'Open Project');
box.children.at(-1).children[1].clicked();box=e._indicator.evaluations.items[0].children[0];box.children.at(-1).clicked();
box=e._indicator.evaluations.items[0].children[0];box.children.at(-1).children[0].clicked();assert.equal(e.sent,'feedback:42');
e._evaluations[0].begin=new Date(Date.now()+60000).toISOString();e._renderEvaluations();
box=e._indicator.evaluations.items[0].children[0];assert.equal(box.children.length,3);
console.log('PASS: actual user field, UTC timestamp, Evaluation Info and feedback branches; no early dismissal button');
vm.runInContext('class VisibilityProbe {'+source.slice(source.indexOf('    _syncOptionalSections()'),source.indexOf('    _renderCards()'))+'}; globalThis.VisibilityProbe=VisibilityProbe;',context);
const visibility=new context.VisibilityProbe();visibility._updatePanelLabel=()=>{};visibility._applySectionOrder=visibility._applyPanelLayout=()=>{};
visibility._indicator=Object.fromEntries(['evaluationItem','notificationItem','agendaItem'].map(key=>[key,{actor:{}}]));
visibility._evaluations=[];visibility._notifications=[];visibility._syncOptionalSections();
assert.ok(Object.values(visibility._indicator).filter(item=>item.actor).every(item=>!item.actor.visible));
visibility._evaluations=[{}];visibility._notifications=[{}];visibility._agenda=[{}];visibility._syncOptionalSections();
assert.ok(Object.entries(visibility._indicator).filter(([key])=>!key.endsWith('Separator')).every(([,item])=>item.actor.visible));
visibility._indicator.loginOnly=true;visibility._syncOptionalSections();
assert.ok(Object.values(visibility._indicator).filter(item=>item.actor).every(item=>!item.actor.visible));
visibility._indicator.loginOnly=false;
console.log('PASS: empty and signed-out sections hidden; populated sections visible');
vm.runInContext('class PanelProbe {'+source.slice(source.indexOf('    _updatePanelLabel()'),source.indexOf('    _syncOptionalSections()'))+'};globalThis.PanelProbe=PanelProbe;',context);
const panel=new context.PanelProbe();panel._indicator={loginOnly:false,profileReady:true,count:{}};
panel._notifications=[{unread:true}];panel._updatePanelLabel();assert.equal(panel._indicator.count.text,'New 1');
panel._agenda=[{feedback:true}];panel._updatePanelLabel();assert.equal(panel._indicator.count.text,'Feedback 1');
panel._evaluations=[{begin:new Date(Date.now()-1000).toISOString()}];panel._updatePanelLabel();assert.equal(panel._indicator.count.text,'Feedback 2');
panel._agenda=[];panel._evaluations=[];panel._notifications[0].unread=false;panel._updatePanelLabel();assert.equal(panel._indicator.count.text,'42');
console.log('PASS: panel unread count, feedback priority/count and return to 42');
panel._unreadIds=new Set(['1','2','3','4','5']);panel._updatePanelLabel();assert.equal(panel._indicator.count.text,'New 5');
panel._unreadIds.add('6');panel._updatePanelLabel();assert.equal(panel._indicator.count.text,'New 5+');
panel._agenda=Array.from({length:6},()=>({feedback:true}));panel._updatePanelLabel();assert.equal(panel._indicator.count.text,'Feedback 5+');
panel._agenda.pop();panel._updatePanelLabel();assert.equal(panel._indicator.count.text,'Feedback 5');
assert.ok(p._unreadIds.size === 0);
console.log('PASS: New/Feedback show 5 at five, 5+ above five; Clear All resets unread tracking');
e._evaluations=[{id:'99',project:'Example',kind:'evaluator',begin:new Date(Date.now()-1000).toISOString(),users:[]}];e._feedback={};e.sent=null;
e._renderEvaluations();box=e._indicator.evaluations.items[0].children[0];assert.equal(box.children.at(-1).label,'Has the evaluation ended?');
box.children.at(-1).clicked();box=e._indicator.evaluations.items[0].children[0];box.children.at(-1).children[1].clicked();
assert.equal(e.sent,null);assert.equal(e._evaluations.length,1);box=e._indicator.evaluations.items[0].children[0];assert.equal(box.children.at(-1).label,'Has the evaluation ended?');
box.children.at(-1).clicked();box=e._indicator.evaluations.items[0].children[0];box.children.at(-1).children[0].clicked();assert.equal(e.sent,'feedback:99');
console.log('PASS: evaluator asks about completion; Not yet retains card without project branch; Yes explicitly dismisses');

let restoreScroll;
context.Meta={LaterType:{BEFORE_REDRAW:0},later_add(type,fn){restoreScroll=fn;return 1;},later_remove(){restoreScroll=null;}};
const adjustment={value:480,lower:0,upper:1200,page_size:420};
e._indicator.evaluationScroll={grab_key_focus(){},get_vscroll_bar:()=>({get_adjustment:()=>adjustment})};
const section=e._indicator.evaluations;
section.removeAll=function(){this.items=[];adjustment.value=0;};
e._feedback={};e._evaluationKey=null;e._renderEvaluations();restoreScroll();
assert.equal(adjustment.value,480);
box=section.items[0].children[0];box.children.at(-1).clicked();
assert.equal(adjustment.value,480);assert.strictEqual(section.items[0],e._evaluationActors.get('99'));
e._evaluations=[];e._renderEvaluations();adjustment.upper=420;restoreScroll();assert.equal(adjustment.value,0);
console.log('PASS: feedback actions preserve scroll after layout; removing content clamps to valid scroll range');

let evaluationStyle;
visibility._indicator.evaluationScroll={set_style(style){evaluationStyle=style;}};
visibility._notifications=[{}];visibility._slotsExpanded=true;
visibility._syncOptionalSections();assert.ok(evaluationStyle.includes('190px'));
visibility._slotsExpanded=false;visibility._syncOptionalSections();assert.ok(evaluationStyle.includes('300px'));
visibility._notifications=[];visibility._syncOptionalSections();assert.ok(evaluationStyle.includes('360px'));
e._evaluations=[{id:'missing-test',project:'Test',kind:'evaluated',begin:new Date(Date.now()+60000).toISOString(),users:[],missing:true}];
e._feedback={};e.sent=null;e._renderEvaluations();
box=e._indicator.evaluations.items[0].children[0];box.children.at(-1).clicked();
box=e._indicator.evaluations.items[0].children[0];
assert.equal(box.children.at(-1).children[0].label,'Yes');
assert.equal(box.children.at(-1).children[1].label,'Later');
box.children.at(-1).children[1].clicked();assert.equal(e.sent,null);
box=e._indicator.evaluations.items[0].children[0];box.children.at(-1).clicked();
box=e._indicator.evaluations.items[0].children[0];box.children.at(-1).children[0].clicked();
assert.equal(e.sent,'feedback:missing-test');
console.log('PASS: missing evaluation requires Yes; Later keeps the card');

const updateProbe=new context.Probe();updateProbe._saveCardState=()=>{};updateProbe._renderCards=()=>{};updateProbe._showBanner=()=>{throw Error('Update must not repeat banner');};updateProbe._flashScreen=()=>{};
updateProbe._notifications=[{id:'reminder:fixture',body:'Seat: Unavailable',unread:false}];
updateProbe._receivedNotificationIds=new Set(['reminder:fixture']);
updateProbe._message({type:'notification',id:'reminder:fixture',update:true,body:'Seat: c1r1s1'});
assert.equal(updateProbe._notifications.length,1);
assert.equal(updateProbe._notifications[0].body,'Seat: c1r1s1');
assert.equal(updateProbe._notifications[0].unread,false);
updateProbe._notifications=[];
updateProbe._message({type:'notification',id:'reminder:fixture',update:true,body:'Seat: c1r1s2'});
assert.equal(updateProbe._notifications.length,0,'dismissed reminder stays dismissed');
console.log('PASS: seat result updates one reminder without repeated banner or restoring dismissed cards');

const beforeMuted=banners;
p._settings={get_boolean:()=>false};
p._message({type:'notification',id:'muted-evaluation',body:'Muted evaluation'});
p._message({type:'notification',id:'muted-agenda',category:'agenda',body:'Muted agenda'});
assert.equal(banners,beforeMuted);
assert.equal(p._notifications.length,2,'muting banners preserves cards');
console.log('PASS: muted evaluation and agenda system notifications preserve cards');

e._indicator.menu.close=()=>{};
e._evaluations=[{id:'profile-links',project:'Project',begin:new Date(Date.now()+600000).toISOString(),users:['peer'],names:{peer:'Peer Full Name'},seats:{peer:'c1r2s3'}}];
e._evaluationKey=null;e._renderEvaluations();
const flatten=actor=>[actor,...(actor.children || []).flatMap(flatten)];
const actors=flatten(e._indicator.evaluations.items[0]);
const nameButton=actors.find(actor=>actor.label==='Peer Full Name'),nickButton=actors.find(actor=>actor.label==='@peer');
assert(nameButton && nickButton);nameButton.clicked();nickButton.clicked();
for(const menu of profileMenus.slice(-2)){assert(menu.toggled);menu.action();assert.match(e.sent,/users\/peer/);}
assert(actors.some(actor=>actor.text==='c1r2s3'));
console.log('PASS: full name and nickname separately open the same Intra profile action, with seat on identity line');
