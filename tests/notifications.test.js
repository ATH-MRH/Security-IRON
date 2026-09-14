const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const alertsSource = fs.readFileSync(path.join(__dirname, '../frontend/js/alerts.js'), 'utf8');
// PG-16: alerts.js now calls SocKpis.compute(...) (frontend/js/soc-kpis.js) —
// load it into the same sandbox, exactly like index.html now loads it before
// alerts.js. Realtime (referenced only inside start()) gets its own minimal
// stub below, defined per-fixture so each test can drive it independently.
const socKpisSource = fs.readFileSync(path.join(__dirname, '../frontend/js/soc-kpis.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../frontend/js/app.js'), 'utf8');
const navSource = appSource.slice(appSource.indexOf('function openSidebar('), appSource.indexOf('function switchTab('));
const source = fs.readFileSync(path.join(__dirname, '../frontend/js/notifications.js'), 'utf8');
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fixture(data = {}) {
  const routes = {'/alerts':[], '/incidents':[], '/visiteurs':[], '/alerts/notifications':[], ...data};
  const state = { html:'', requests:[], posts:[], errors:[] };
  const dot = {style:{}, parentElement:{title:'',setAttribute(name,value){this[name]=value;}}};
  let buttons = [];
  const elements = new Map();
  function element(id) {
    if(id==='ac-comment')return element('ac-detail').querySelector('#ac-comment');
    if (!elements.has(id)) {
      let html = '', actions = [], comment = null, aiBtn = null, suggestButtons = [];
      // document.querySelectorAll('.page') isn't mocked (only the specific
      // selectors AlertCenter/NotificationBell actually query), so navTo()'s
      // own class toggling never reaches these elements — page-alertes
      // starts "active" here deliberately, simulating a user already viewing
      // that screen, which is what AlertCenter's realtime-triggered refresh
      // gate (refreshNow()) actually checks.
      const activeClasses = new Set(id === 'page-alertes' ? ['active'] : []);
      elements.set(id, {
        value:'', textContent:'', hidden:false,
        classList:{
          toggle(name, on){ if (on === undefined) on = !activeClasses.has(name); if (on) activeClasses.add(name); else activeClasses.delete(name); },
          contains:name=>activeClasses.has(name),
          // openSidebar/closeSidebar (frontend/js/app.js) use add/remove
          // directly rather than toggle — same backing set either way.
          add:name=>activeClasses.add(name),
          remove:name=>activeClasses.delete(name),
        },
        setAttribute(){}, getAttribute:()=>null,
        get innerHTML(){return html;},
        set innerHTML(value){
          html=value;
          actions=[...value.matchAll(/data-action="([^"]+)"/g)].map(m=>({dataset:{action:m[1]},disabled:false}));
          comment=value.includes('id="ac-comment"')?{value:'',focus(){}}:null;
          // PG-20: AlertCenter#detail() wires the AI-summary button via
          // target.querySelector('#ac-ai-summary-btn') — a distinct mock
          // object per innerHTML set, so a stale onclick from a previous
          // render is never mistaken for the current one.
          aiBtn=value.includes('id="ac-ai-summary-btn"')?{onclick:null}:null;
          // PG-21: AlertCenter#assistantAsk() wires each suggestion's
          // "Confirmer" button via panel.querySelectorAll('[data-suggest-alert]').
          suggestButtons=[...value.matchAll(/<button[^>]*data-suggest-alert="([^"]*)"[^>]*data-suggest-action="([^"]*)"[^>]*>/g)]
            .map(m=>({dataset:{suggestAlert:m[1],suggestAction:m[2]},disabled:false,textContent:''}));
        },
        querySelector:selector=>selector==='#ac-comment'?comment:selector==='#ac-ai-summary-btn'?aiBtn:null,
        querySelectorAll:selector=>selector==='[data-action]'?actions:selector==='[data-suggest-alert]'?suggestButtons:[]
      });
    }
    return elements.get(id);
  }
  // PG-16: AlertCenter.start() wires backend/js/realtime.js's Realtime — a
  // minimal stub (recording registered listeners, never itself connecting
  // to a network) is enough to prove AlertCenter's OWN wiring (does an
  // emitted event trigger a refresh / update the live badge), without
  // re-testing realtime.js's own reconnect/fallback logic (already covered,
  // in isolation, by tests/frontend-realtime.test.js).
  const realtimeListeners = [];
  const realtimeStub = {
    on: fn => { realtimeListeners.push(fn); return () => { const i = realtimeListeners.indexOf(fn); if (i >= 0) realtimeListeners.splice(i, 1); }; },
    connect: () => { realtimeStub.connectCalls = (realtimeStub.connectCalls || 0) + 1; },
    stop: () => {},
    isConnected: () => Boolean(realtimeStub._connected),
  };
  const emitRealtime = (type, data) => realtimeListeners.forEach(fn => fn(type, data));
  const context = vm.createContext({
    escapeHtml, fmtDateTime: s => String(s || ''),
    API: {get:async p=>{state.requests.push(p);if(routes[p] instanceof Error)throw routes[p];if(typeof routes[p]==='function')return routes[p]();
      if(p.startsWith('/alerts/')&&p!=='/alerts/notifications'&&!Object.hasOwn(routes,p))return {...routes['/alerts'].find(a=>a.id===p.slice(8)),timeline:[]};
      return structuredClone(routes[p]);},
    // PG-21: extended to mirror get() (Error-throwing, static-object
    // return) — every prior POST usage in this file only ever registered a
    // function-based route (never a plain object/Error), so this is purely
    // additive for AlertCenter#assistantAsk()/confirmSuggestion().
    post:async(p,b)=>{state.posts.push({p,b});if(routes[p] instanceof Error)throw routes[p];if(typeof routes[p]==='function')return routes[p]();return structuredClone(routes[p]);},
    getUser:()=>({id:1})},
    document: {activeElement:null,getElementById:element,querySelector:()=>dot,querySelectorAll:selector=>selector==='[data-action]'?element('ac-detail').querySelectorAll(selector):selector==='[data-bell-alert]'||selector==='[data-bell-notification]'?buttons.filter(b=>Object.hasOwn(b.dataset,selector==='[data-bell-alert]'?'bellAlert':'bellNotification')):[]},
    showModal:(title,html)=>{state.html=html;buttons=[...html.matchAll(/<button[^>]*data-bell-(alert|notification)="([^"]+)"([^>]*)>/g)].map(m=>({dataset:{[m[1]==='alert'?'bellAlert':'bellNotification']:m[2],target:m[3].match(/data-target="([^"]+)"/)?.[1]}}));},
    closeModal:()=>{state.closed=true;},isAdmin:()=>true,lapiStream:null,notify:m=>state.errors.push(m),
    Realtime: realtimeStub,
    setInterval:()=>0, clearInterval:()=>{}, setTimeout:()=>0, clearTimeout:()=>{},
  });
  const bell=vm.runInContext(source+'\nNotificationBell;',context);
  vm.runInContext(socKpisSource, context);
  const center=vm.runInContext(alertsSource+'\nAlertCenter;',context);
  vm.runInContext(navSource,context);
  return {bell,center,routes,state,dot,element,buttons:()=>buttons,realtimeStub,emitRealtime};
}
const visitor = {id:'v1',statut:'attendu',prenom:'Lina',nom:'Visite',societe:'Société',arrivee:'2026-09-08'};
const incident = {id:'i1',statut:'ouvert',ref:'INC-TEST',type:'Incident métier',lieu:'Quai',gravite:'critique'};
const alert = {id:'a1',status:'NOTIFIEE',acknowledged_at:null,type:'Signal de traitement',level:3,origin:'INCIDENT',site:'Site',username:'agent'};
test('A — expected visitors alone retain historical visibility',async()=>{
  const f=fixture({'/visiteurs':[visitor,{...visitor,prenom:'Exclu',statut:'present'}]});await f.bell.open();
  assert.match(f.state.html,/Lina Visite/);assert.doesNotMatch(f.state.html,/Exclu/);
  assert.match(f.dot.parentElement.title,/1 visiteur\(s\) attendu/);assert.equal(f.dot.style.display,'');
});
test('B — open incidents alone retain historical visibility',async()=>{
  const f=fixture({'/incidents':[incident,{...incident,ref:'RESOLU-EXCLU',statut:'resolu'}]});await f.bell.open();
  assert.match(f.state.html,/INC-TEST/);assert.doesNotMatch(f.state.html,/RESOLU-EXCLU/);
  assert.match(f.dot.parentElement.title,/1 incident\(s\) ouvert/);
});
test('C — pending alerts and internal history remain visible and navigable',async()=>{
  const f=fixture({'/alerts':[alert],'/alerts/notifications':[{id:1,alert_id:'a1',message:'SOS reçu'}]});await f.bell.open();
  assert.match(f.state.html,/Signal de traitement/);assert.match(f.state.html,/SOS reçu/);
  await f.buttons().find(b=>b.dataset.bellAlert).onclick();assert.match(f.element('ac-detail').innerHTML,/<small>a1<\/small>/);assert.equal(f.state.posts.length,0);
  await f.buttons().find(b=>b.dataset.bellNotification).onclick();assert.equal(f.state.posts[0].p,'/alerts/notifications/1/read');
  assert.match(f.element('ac-detail').innerHTML,/<small>a1<\/small>/);assert.match(f.dot.parentElement.title,/1 alerte\(s\) non acquittée/);
});
test('D — all three families coexist without destructive deduplication',async()=>{
  const f=fixture({'/alerts':[alert],'/incidents':[incident],'/visiteurs':[visitor]});await f.bell.open();
  for(const name of ['Signal de traitement','INC-TEST','Lina Visite'])assert.ok(f.state.html.includes(name));
  assert.ok(f.state.html.indexOf('Incidents à suivre')<f.state.html.indexOf('Visiteurs attendus'));
  assert.match(f.state.html,/Signal issu d’un incident/);assert.equal(f.state.posts.length,0);
});
test('E — acknowledgement removes only the pending alert, retains business objects and history',async()=>{
  const f=fixture({'/alerts':[alert],'/incidents':[incident],'/visiteurs':[visitor],'/alerts/notifications':[{id:1,alert_id:'a1',message:'Alerte acquittée',read_at:'date'}]});
  await f.bell.open();f.routes['/alerts']=[{...alert,status:'ACQUITTEE',acknowledged_at:'2026-09-08'}];await f.bell.open();
  assert.doesNotMatch(f.state.html,/data-bell-alert=/);assert.match(f.state.html,/INC-TEST/);assert.match(f.state.html,/Lina Visite/);assert.match(f.state.html,/Alerte acquittée/);
  assert.match(f.dot.parentElement.title,/0 alerte\(s\) non acquittée/);assert.equal(f.dot.style.display,'');
});
test('F — closing an incident uses resolu only and does not hide the alert or visitor',async()=>{
  const f=fixture({'/alerts':[alert],'/incidents':[incident],'/visiteurs':[visitor]});
  await f.bell.open();f.routes['/incidents']=[{...incident,statut:'resolu'}];await f.bell.open();
  assert.doesNotMatch(f.state.html,/INC-TEST/);assert.match(f.state.html,/Signal de traitement/);assert.match(f.state.html,/Lina Visite/);
  f.routes['/incidents']=[{...incident,statut:'encours'}];await f.bell.open();assert.match(f.state.html,/INC-TEST/);
});
test('G — empty bell has normal empty states and no badge',async()=>{
  const f=fixture();await f.bell.open();
  assert.equal(f.dot.style.display,'none');assert.match(f.state.html,/Aucune alerte à acquitter/);assert.match(f.state.html,/Aucun visiteur en attente/);assert.match(f.state.html,/Aucune alerte incident/);
});
test('H — use only existing authenticated APIs, discard stale data on permission loss',async()=>{
  const f=fixture({'/alerts':[alert],'/incidents':[incident],'/visiteurs':[visitor]});await f.bell.open();
  f.routes['/alerts']=new Error('403');f.routes['/incidents']=new Error('403');await f.bell.open();
  assert.doesNotMatch(f.state.html,/Signal de traitement|INC-TEST/);assert.match(f.state.html,/Lina Visite/);assert.match(f.state.html,/Données indisponibles/);
  assert.deepEqual([...new Set(f.state.requests)].sort(),['/alerts','/alerts/notifications','/incidents','/visiteurs']);
});
test('historical limits and ordering are preserved while counts include all matches',async()=>{
  const f=fixture({'/incidents':Array.from({length:10},(_,n)=>({...incident,ref:'REF-'+n})),'/visiteurs':Array.from({length:7},(_,n)=>({...visitor,prenom:'Visitor-'+n}))});
  await f.bell.open();assert.match(f.state.html,/REF-7/);assert.doesNotMatch(f.state.html,/REF-8/);assert.match(f.state.html,/Visitor-4/);assert.doesNotMatch(f.state.html,/Visitor-5/);
  assert.ok(f.state.html.indexOf('REF-0')<f.state.html.indexOf('REF-1'));assert.match(f.dot.parentElement.title,/7 visiteur.*10 incident/);
});
test('unread escalations do not multiply operational count and text is escaped',async()=>{
  const f=fixture({'/alerts':[{...alert,type:'<img src=x onerror=bad>'}],'/alerts/notifications':Array.from({length:3},(_,n)=>({id:n,alert_id:'a1',message:'Escalade'}))});
  await f.bell.open();assert.match(f.dot.parentElement.title,/1 alerte/);assert.doesNotMatch(f.state.html,/<img/);assert.match(f.state.html,/&lt;img/);
  f.routes['/alerts']=[{...alert,status:'FAUSSE_ALERTE'}];await f.bell.refresh();assert.match(f.dot.parentElement.title,/0 alerte/);
});

function deferred() {
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const settle = () => new Promise(resolve=>setImmediate(resolve));
function record(id) {return {...alert,id,type:'Titre '+id,latitude:null,created_at:'2026-09-08',timeline:[]};}
async function navigationFixture(ids=['old','new','A','B']) {
  const f=fixture({'/alerts':ids.map(record)});
  await f.center.openAlert('old');await settle();
  assert.match(f.element('ac-detail').innerHTML,/<small>old<\/small>/);
  await f.bell.open();
  f.click=id=>f.buttons().find(b=>b.dataset.bellAlert===id).onclick();
  return f;
}
function displayed(f,id) {
  const html=f.element('ac-detail').innerHTML;
  assert.ok(html.includes('<h2>Titre '+id+'</h2>'), 'Expected displayed title '+id);
  assert.ok(html.includes('<small>'+id+'</small>'), 'Expected displayed id '+id);
  assert.ok(f.element('ac-list').innerHTML.includes('selected\" data-alert=\"'+id+'\"'), 'Expected selected row '+id);
  // Also check the production closure bound to the actual action button.
  return f.element('ac-detail').querySelectorAll('[data-action]').find(b=>b.dataset.action==='ACQUITTEE');
}
async function assertAction(f,id) {
  const button=displayed(f,id);assert.ok(button);
  await button.onclick();await settle();
  assert.equal(f.state.posts.at(-1).p,'/alerts/'+id+'/actions');
  assert.equal(f.state.posts.at(-1).b.action,'ACQUITTEE');
}
test('navigation A — old to new: new detail slower than list refresh',async()=>{
  const f=await navigationFixture();const list=deferred(),target=deferred();
  f.routes['/alerts']=()=>list.promise;f.routes['/alerts/new']=()=>target.promise;
  const oldAction=displayed(f,'old');
  const click=f.click('new');
  assert.equal(f.element('ac-detail').querySelectorAll('[data-action]').length,0);
  await oldAction.onclick();assert.equal(f.state.posts.length,0);
  list.resolve(['old','new'].map(record));await settle();
  target.resolve(record('new'));await click;await settle();
  await assertAction(f,'new');
});
test('navigation B — old to new: list refresh slower than new detail',async()=>{
  const f=await navigationFixture();const list=deferred(),target=deferred();
  f.routes['/alerts']=()=>list.promise;f.routes['/alerts/new']=()=>target.promise;
  const click=f.click('new');target.resolve(record('new'));await click;
  displayed(f,'new');list.resolve(['old','new'].map(record));await settle();
  await assertAction(f,'new');
});
for (const order of [['B','A'],['A','B']]) {
  test('navigation C/D — clicks A then B; responses '+order.join(' then '),async()=>{
    const f=await navigationFixture();const responses={A:deferred(),B:deferred()};
    for(const id of ['A','B'])f.routes['/alerts/'+id]=()=>responses[id].promise;
    const clickA=f.click('A'),clickB=f.click('B');
    responses[order[0]].resolve(record(order[0]));await settle();
    if(order[0]==='A')assert.doesNotMatch(f.element('ac-detail').innerHTML,/<small>A<\/small>/);
    else displayed(f,'B');
    responses[order[1]].resolve(record(order[1]));await Promise.all([clickA,clickB]);await settle();
    await assertAction(f,'B');
  });
}
test('navigation E — B fails: no stale A actions, visible error survives late refresh',async()=>{
  const f=await navigationFixture();const a=deferred(),b=deferred(),list=deferred();
  f.routes['/alerts']=()=>list.promise;f.routes['/alerts/A']=()=>a.promise;f.routes['/alerts/B']=()=>b.promise;
  const clickA=f.click('A'),clickB=f.click('B');
  b.reject(new Error('B indisponible'));await clickB;
  a.resolve(record('A'));await clickA;
  list.resolve(['old','A','B'].map(record));await settle();
  assert.doesNotMatch(f.element('ac-detail').innerHTML,/<small>(old|A)<\/small>/);
  assert.equal(f.element('ac-detail').querySelectorAll('[data-action]').length,0);
  assert.match(f.element('ac-detail').innerHTML+f.element('ac-message').textContent,/B indisponible/);
});
test('late old detail/error cannot overwrite new selection or its error state',async()=>{
  for(const rejectOld of [false,true]) {
    const f=await navigationFixture();const old=deferred();
    f.routes['/alerts/old']=()=>old.promise;
    const refresh=f.center.load();await settle();
    await f.click('new');displayed(f,'new');
    if(rejectOld)old.reject(new Error('Ancienne erreur'));else old.resolve(record('old'));
    await refresh;await settle();
    displayed(f,'new');assert.doesNotMatch(f.element('ac-message').textContent,/Ancienne erreur/);
  }
});

async function historyFixture(ids=['A','B','C']) {
  const f=await navigationFixture(['old',...ids]);
  f.routes['/alerts/notifications']=ids.map(id=>({id,alert_id:id,message:'Notification '+id}));
  await f.bell.open();
  f.reads=Object.fromEntries(ids.map(id=>[id,deferred()]));
  for(const id of ids)f.routes['/alerts/notifications/'+id+'/read']=()=>f.reads[id].promise;
  f.historyClick=id=>f.buttons().find(b=>b.dataset.bellNotification===id).onclick();
  return f;
}
for(const order of [['B','A'],['A','B']])test('history A/B — last click B wins before reads settle: '+order,async()=>{
  const f=await historyFixture();const a=f.historyClick('A'),b=f.historyClick('B');
  await settle();displayed(f,'B');
  for(const id of order){f.reads[id].resolve({ok:true});await settle();displayed(f,'B');}
  await Promise.all([a,b]);await assertAction(f,'B');
});
for(const order of [['A','B','C'],['A','C','B'],['B','A','C'],['B','C','A'],['C','A','B'],['C','B','A']])test('history A/B/C — read permutation '+order,async()=>{
  const f=await historyFixture();const clicks=['A','B','C'].map(id=>f.historyClick(id));
  await settle();displayed(f,'C');
  for(const id of order){f.reads[id].resolve({ok:true});await settle();displayed(f,'C');}
  await Promise.all(clicks);await assertAction(f,'C');
});
test('history — obsolete read error ignored; current read error controlled without fallback',async()=>{
  const f=await historyFixture();const a=f.historyClick('A'),b=f.historyClick('B');
  await settle();f.reads.A.reject(new Error('Erreur lecture A'));await a;
  displayed(f,'B');assert.deepEqual(f.state.errors,[]);
  f.reads.B.reject(new Error('Erreur lecture B'));await b;
  displayed(f,'B');assert.equal(f.state.errors.length,1);assert.match(f.state.errors[0],/Erreur lecture B/);
});
test('history — leaving and returning to same ID invalidates old read error',async()=>{
  const f=await historyFixture();const a=f.historyClick('A');
  await settle();await f.center.openAlert('B');await f.center.openAlert('A');
  f.reads.A.reject(new Error('Erreur ancien clic A'));await a;
  displayed(f,'A');assert.deepEqual(f.state.errors,[]);
});
for(const fails of [false,true])test('pending old action '+(fails?'failure':'success')+' leaves B form and actions untouched',async()=>{
  const f=await navigationFixture();const response=deferred();
  f.routes['/alerts/old/actions']=()=>response.promise;
  f.element('ac-comment').value='commentaire old';
  const running=displayed(f,'old').onclick();
  assert.equal(f.state.posts[0].p,'/alerts/old/actions');assert.equal(f.state.posts[0].b.comment,'commentaire old');
  await f.center.openAlert('B');await settle();
  const field=f.element('ac-comment');field.value='commentaire B';
  const actions=f.element('ac-detail').querySelectorAll('[data-action]');
  const requests=f.state.requests.length;
  if(fails)response.reject(new Error('Erreur action old'));else response.resolve({ok:true});
  await running;await settle();
  displayed(f,'B');assert.equal(f.element('ac-comment'),field);assert.equal(field.value,'commentaire B');
  assert.equal(f.element('ac-detail').querySelectorAll('[data-action]'),actions);
  assert.ok(actions.every(b=>!b.disabled));assert.equal(f.state.requests.length,requests);
  assert.doesNotMatch(f.element('ac-message').textContent,/Erreur action old/);
});
test('pending actions old then B — B responds first, only B can refresh',async()=>{
  const f=await navigationFixture();const old=deferred(),b=deferred();
  f.routes['/alerts/old/actions']=()=>old.promise;f.routes['/alerts/B/actions']=()=>b.promise;
  const actionOld=displayed(f,'old').onclick();await f.center.openAlert('B');await settle();
  f.element('ac-comment').value='envoyé B';const actionB=displayed(f,'B').onclick();
  assert.deepEqual(f.state.posts.map(p=>p.p),['/alerts/old/actions','/alerts/B/actions']);
  b.resolve({ok:true});await actionB;await settle();
  f.element('ac-comment').value='nouvelle saisie B';const requests=f.state.requests.length;
  old.resolve({ok:true});await actionOld;await settle();
  displayed(f,'B');assert.equal(f.element('ac-comment').value,'nouvelle saisie B');assert.equal(f.state.requests.length,requests);
});
test('pending action — old → B → old is a new selection, not the original form',async()=>{
  const f=await navigationFixture();const response=deferred();f.routes['/alerts/old/actions']=()=>response.promise;
  const action=displayed(f,'old').onclick();await f.center.openAlert('B');await f.center.openAlert('old');await settle();
  const field=f.element('ac-comment');field.value='nouveau commentaire old';
  response.resolve({ok:true});await action;await settle();
  assert.equal(f.element('ac-comment'),field);assert.equal(field.value,'nouveau commentaire old');
});
test('current action preserves text edited after submission and polling cannot replace its form',async()=>{
  const f=await navigationFixture();const response=deferred();f.routes['/alerts/old/actions']=()=>response.promise;
  const field=f.element('ac-comment');field.value='texte envoyé';const action=displayed(f,'old').onclick();
  field.value='nouveau texte';await f.center.load();
  assert.equal(f.element('ac-comment'),field);
  response.resolve({ok:true});await action;await settle();
  assert.equal(f.element('ac-comment').value,'nouveau texte');
});
test('old POST settling while B POST is pending cannot unlock B controls',async()=>{
  const f=await navigationFixture();const old=deferred(),b=deferred();
  f.routes['/alerts/old/actions']=()=>old.promise;f.routes['/alerts/B/actions']=()=>b.promise;
  const actionOld=displayed(f,'old').onclick();await f.center.openAlert('B');await settle();
  f.element('ac-comment').value='commentaire B';const actionB=displayed(f,'B').onclick();
  const field=f.element('ac-comment'),buttons=f.element('ac-detail').querySelectorAll('[data-action]');
  old.reject(new Error('Ancien POST refusé'));await actionOld;
  assert.equal(field.value,'commentaire B');assert.ok(buttons.every(button=>button.disabled));
  assert.doesNotMatch(f.element('ac-message').textContent,/Ancien POST refusé/);
  b.resolve({ok:true});await actionB;await settle();displayed(f,'B');
});
for(const fails of [false,true])test('post-action refresh '+(fails?'error':'response')+' is ignored after selection changes',async()=>{
  const f=await navigationFixture();const list=deferred();
  f.routes['/alerts']=()=>list.promise;
  f.routes['/alerts/B']=()=>record('B');
  const actionOld=displayed(f,'old').onclick();await settle();
  await f.center.openAlert('B');const field=f.element('ac-comment');field.value='commentaire B';
  const buttons=f.element('ac-detail').querySelectorAll('[data-action]');
  if(fails)list.reject(new Error('Ancien refresh refusé'));else list.resolve([record('old')]);
  await actionOld;await settle();
  assert.equal(f.element('ac-comment'),field);assert.equal(field.value,'commentaire B');
  assert.equal(f.element('ac-detail').querySelectorAll('[data-action]'),buttons);
  assert.doesNotMatch(f.element('ac-message').textContent,/Ancien refresh refusé/);
  displayed(f,'B');
});

/* ============================================================ */
/*  PG-16 — SOC nouvelle génération : nouveaux panneaux, temps   */
/*  réel côté client, absence de régression de contrat.          */
/* ============================================================ */

test('PG-16/PG-21: AlertCenter keeps its exact original public contract, plus only the deliberate PG-21 addition', () => {
  const f = fixture();
  assert.deepEqual(
    Object.keys(f.center).sort(),
    // PG-21: assistantAsk() must be public — wired from an inline
    // onsubmit="AlertCenter.assistantAsk()" in frontend/index.html, unlike
    // aiSummary()/confirmSuggestion() which stay internal (wired
    // programmatically via .onclick, never referenced from markup).
    ['load','renderList','createForm','rules','notifications','openAlert','captureSelection','start','assistantAsk'].sort(),
  );
});

test('PG-16: load() renders every KPI card the SOC screen now shows, from real fetched alerts only', async () => {
  const rows = [
    {...record('a'), level:4, status:'NOTIFIEE', site:'Poste 1', escalation_step:0},
    {...record('b'), level:3, status:'ACQUITTEE', site:'Poste 1', escalation_step:2},
    {...record('c'), level:1, status:'CLOTUREE', site:'Poste 2', escalation_step:0}, // terminal: excluded from every active count
  ];
  const f = fixture({'/alerts':rows});
  await f.center.load();
  const html = f.element('ac-kpis').innerHTML;
  for (const label of ['Alertes actives','Critiques en cours','SOS en cours','Non acquittées','Escalades en cours','Alertes aujourd’hui','Prise en charge moyenne']) {
    assert.match(html, new RegExp(label), label + ' KPI card is rendered');
  }
  // 2 active (a, b) out of 3 rows (c is CLOTUREE, a terminal status).
  assert.match(html, /<div class="kpi-value">2<\/div>/);
});

test('PG-16: an empty dashboard (zero alerts, zero incidents) renders empty states, never throws', async () => {
  const f = fixture({'/alerts':[], '/incidents':[]});
  await assert.doesNotReject(f.center.load());
  assert.match(f.element('ac-by-site').innerHTML, /empty-state/);
  assert.match(f.element('ac-recent-incidents').innerHTML, /empty-state/);
  assert.match(f.element('ac-op-timeline').innerHTML, /empty-state/);
  assert.doesNotMatch(f.element('ac-kpis').innerHTML, /NaN|undefined|Infinity/);
});

test('PG-16: activité par site reflects the real, submitted site names of active alerts only', async () => {
  const rows = [
    {...record('a'), site:'Entrée Nord', status:'NOTIFIEE'},
    {...record('b'), site:'Entrée Nord', status:'NOTIFIEE'},
    {...record('c'), site:'Entrée Sud', status:'CLOTUREE'}, // terminal: excluded
  ];
  const f = fixture({'/alerts':rows});
  await f.center.load();
  const html = f.element('ac-by-site').innerHTML;
  assert.match(html, /Entrée Nord/);
  assert.match(html, /<strong>2<\/strong>/);
  assert.doesNotMatch(html, /Entrée Sud/);
});

test('PG-16: incidents récents are fetched separately and never block or break the alerts screen', async () => {
  const f = fixture({'/alerts':[record('a')], '/incidents':new Error('incidents indisponibles')});
  await assert.doesNotReject(f.center.load());
  await settle();
  // The alerts screen itself still rendered correctly despite /incidents failing.
  assert.match(f.element('ac-list').innerHTML, /Titre a/);
  assert.match(f.element('ac-recent-incidents').innerHTML, /empty-state/);
  assert.doesNotMatch(f.element('ac-message').textContent, /incidents indisponibles/);
});

test('PG-16: incidents récents render once fetched, and feed the merged operational timeline', async () => {
  const f = fixture({
    '/alerts':[{...record('a'), created_at:'2026-09-08T10:00:00.000Z'}],
    '/incidents':[{id:'i1', ref:'INC-1', type:'Intrusion', lieu:'Quai', gravite:'critique', datetime:'2026-09-08T11:00:00.000Z'}],
  });
  await f.center.load();
  await settle(); // the incidents fetch is deliberately decoupled from load()'s own await chain
  assert.match(f.element('ac-recent-incidents').innerHTML, /Intrusion/);
  assert.match(f.element('ac-recent-incidents').innerHTML, /INC-1/);
  const timeline = f.element('ac-op-timeline').innerHTML;
  assert.match(timeline, /Incident · Intrusion/);
  assert.match(timeline, /Alerte · Titre a/);
  // The later incident (11:00) must be listed before the earlier alert (10:00).
  assert.ok(timeline.indexOf('Incident · Intrusion') < timeline.indexOf('Alerte · Titre a'));
});

test('PG-16: start() connects to Realtime and reflects the live/fallback state in the badge', async () => {
  const f = fixture();
  f.realtimeStub._connected = true;
  f.center.start();
  assert.equal(f.realtimeStub.connectCalls, 1);
  assert.match(f.element('ac-live-badge').textContent, /Temps réel/);
  assert.ok(f.element('ac-live-badge').classList); // toggle() calls never throw against the mock
});

test('PG-16: a realtime alert:created/alert:updated event triggers an immediate refresh, without waiting for the 5s poll', async () => {
  const f = fixture({'/alerts':[record('a')]});
  f.center.start();
  const before = f.state.requests.filter(p => p === '/alerts').length;
  f.emitRealtime('alert:created', {id:'a', at:'2026-09-08T10:00:00.000Z'});
  await settle();
  const after = f.state.requests.filter(p => p === '/alerts').length;
  assert.ok(after > before, 'a fresh GET /alerts was issued in reaction to the realtime event');
});

test('PG-16: a realtime "poll" fallback event (no live SSE) also triggers the same refresh path', async () => {
  const f = fixture({'/alerts':[record('a')]});
  f.center.start();
  const before = f.state.requests.filter(p => p === '/alerts').length;
  f.emitRealtime('poll', null);
  await settle();
  assert.ok(f.state.requests.filter(p => p === '/alerts').length > before);
});

test('PG-16: the live badge switches to fallback wording once the connection is reported lost', async () => {
  const f = fixture();
  f.realtimeStub._connected = false;
  f.center.start();
  f.emitRealtime('poll', null); // any Realtime event also refreshes the badge
  assert.match(f.element('ac-live-badge').textContent, /Repli/);
});

test('PG-20: the AI summary is never fetched automatically, only on explicit request', async () => {
  const f = fixture({'/alerts': [{ ...alert, id: 'a1' }]});
  await f.center.openAlert('a1'); await settle();
  assert.equal(f.state.requests.includes('/alerts/a1/summary'), false);
});

test('PG-20: clicking "Résumé IA" fetches GET /alerts/:id/summary and renders the labelled result', async () => {
  const f = fixture({'/alerts': [{ ...alert, id: 'a1' }],
    '/alerts/a1/summary': { kind: 'alert_summary', resource_id: 'a1', text: 'Résumé de test', provider: 'local', generated_by_ai: true, simulated: true }});
  await f.center.openAlert('a1'); await settle();
  const btn = f.element('ac-detail').querySelector('#ac-ai-summary-btn');
  assert.ok(btn, 'the AI summary button is wired via target.querySelector');
  await btn.onclick(); await settle();
  assert.ok(f.state.requests.includes('/alerts/a1/summary'));
  const panel = f.element('ac-ai-summary');
  assert.equal(panel.hidden, false);
  assert.match(panel.innerHTML, /Généré par IA/);
  assert.match(panel.innerHTML, /Résumé de test/);
});

test('PG-20: a summary fetch failure is shown as an alert, never a silent panel', async () => {
  const f = fixture({'/alerts': [{ ...alert, id: 'a1' }], '/alerts/a1/summary': Object.assign(new Error('IA indisponible'), {})});
  await f.center.openAlert('a1'); await settle();
  const btn = f.element('ac-detail').querySelector('#ac-ai-summary-btn');
  await btn.onclick(); await settle();
  assert.match(f.element('ac-ai-summary').innerHTML, /IA indisponible/);
});

test('PG-20: switching to another alert before the summary resolves discards the stale response', async () => {
  const summary = deferred();
  const f = fixture({'/alerts': [record('old'), record('B')], '/alerts/old/summary': () => summary.promise});
  await f.center.openAlert('old'); await settle();
  const btn = f.element('ac-detail').querySelector('#ac-ai-summary-btn');
  const pending = btn.onclick();
  await f.center.openAlert('B'); await settle();
  summary.resolve({ text: 'Résumé de old', generated_by_ai: true });
  await pending; await settle();
  assert.doesNotMatch(f.element('ac-ai-summary').innerHTML, /Résumé de old/);
});

test('PG-21: an empty assistant question never calls the API', async () => {
  const f = fixture();
  f.element('ac-assistant-question').value = '   ';
  await f.center.assistantAsk();
  assert.equal(f.state.requests.includes('/alerts/assistant'), false);
  assert.ok(!f.state.posts.some(p => p.p === '/alerts/assistant'));
});

test('PG-21: a real question posts to /alerts/assistant and renders the labelled answer plus suggestions', async () => {
  const f = fixture({'/alerts/assistant': {
    text: 'Deux alertes critiques sur Site A.', generated_by_ai: true, question: 'Quelles alertes critiques ?',
    suggestions: [{ alert_id: 'a1', action: 'ACQUITTEE', label: 'Prendre en charge' }],
  }});
  f.element('ac-assistant-question').value = 'Quelles alertes critiques ?';
  await f.center.assistantAsk();
  assert.equal(f.state.posts.at(-1).p, '/alerts/assistant');
  assert.equal(f.state.posts.at(-1).b.question, 'Quelles alertes critiques ?');
  const panel = f.element('ac-assistant-answer');
  assert.equal(panel.hidden, false);
  assert.match(panel.innerHTML, /Généré par IA/);
  assert.match(panel.innerHTML, /Deux alertes critiques/);
  assert.match(panel.innerHTML, /Prendre en charge/);
});

test('PG-21: an assistant failure is shown as an alert, never a silent panel', async () => {
  const f = fixture({'/alerts/assistant': Object.assign(new Error('Assistant indisponible'), {})});
  f.element('ac-assistant-question').value = 'Que se passe-t-il ?';
  await f.center.assistantAsk();
  assert.match(f.element('ac-assistant-answer').innerHTML, /Assistant indisponible/);
});

test('PG-21: confirming a suggestion calls the real, existing action route — never a shortcut', async () => {
  const f = fixture({'/alerts/assistant': {
    text: 'x', generated_by_ai: true, suggestions: [{ alert_id: 'a1', action: 'ACQUITTEE', label: 'Prendre en charge' }],
  }, '/alerts': [record('a1')]});
  f.element('ac-assistant-question').value = 'Que faire ?';
  await f.center.assistantAsk();
  const button = f.element('ac-assistant-answer').querySelectorAll('[data-suggest-alert]')[0];
  assert.ok(button);
  await button.onclick();
  const post = f.state.posts.find(p => p.p === '/alerts/a1/actions');
  assert.ok(post, 'the suggestion is confirmed through the same POST /alerts/:id/actions route as a manual click');
  assert.equal(post.b.action, 'ACQUITTEE');
  assert.match(button.textContent, /Confirmée/);
});

test('PG-21: a failed confirmation re-enables the button and reports the failure, never a silent no-op', async () => {
  const f = fixture({'/alerts/assistant': {
    text: 'x', generated_by_ai: true, suggestions: [{ alert_id: 'a1', action: 'ACQUITTEE', label: 'Prendre en charge' }],
  }, '/alerts/a1/actions': Object.assign(new Error('Action refusée'), {})});
  f.element('ac-assistant-question').value = 'Que faire ?';
  await f.center.assistantAsk();
  const button = f.element('ac-assistant-answer').querySelectorAll('[data-suggest-alert]')[0];
  await button.onclick();
  assert.equal(button.disabled, false);
  assert.match(button.textContent, /Action refusée/);
});
