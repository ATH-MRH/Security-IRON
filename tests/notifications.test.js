const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const alertsSource = fs.readFileSync(path.join(__dirname, '../frontend/js/alerts.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../frontend/js/app.js'), 'utf8');
const navSource = appSource.slice(appSource.indexOf('function navTo(page)'), appSource.indexOf('function switchTab('));
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
      let html = '', actions = [], comment = null;
      elements.set(id, {
        value:'', textContent:'', classList:{toggle(){}},
        get innerHTML(){return html;},
        set innerHTML(value){
          html=value;
          actions=[...value.matchAll(/data-action="([^"]+)"/g)].map(m=>({dataset:{action:m[1]},disabled:false}));
          comment=value.includes('id="ac-comment"')?{value:'',focus(){}}:null;
        },
        querySelector:selector=>selector==='#ac-comment'?comment:null,
        querySelectorAll:selector=>selector==='[data-action]'?actions:[]
      });
    }
    return elements.get(id);
  }
  const context = vm.createContext({
    escapeHtml, fmtDateTime: s => String(s || ''),
    API: {get:async p=>{state.requests.push(p);if(routes[p] instanceof Error)throw routes[p];if(typeof routes[p]==='function')return routes[p]();
      if(p.startsWith('/alerts/')&&p!=='/alerts/notifications'&&!Object.hasOwn(routes,p))return {...routes['/alerts'].find(a=>a.id===p.slice(8)),timeline:[]};
      return structuredClone(routes[p]);},post:async(p,b)=>{state.posts.push({p,b});if(typeof routes[p]==='function')return routes[p]();},getUser:()=>({id:1})},
    document: {activeElement:null,getElementById:element,querySelector:()=>dot,querySelectorAll:selector=>selector==='[data-action]'?element('ac-detail').querySelectorAll(selector):selector==='[data-bell-alert]'||selector==='[data-bell-notification]'?buttons.filter(b=>Object.hasOwn(b.dataset,selector==='[data-bell-alert]'?'bellAlert':'bellNotification')):[]},
    showModal:(title,html)=>{state.html=html;buttons=[...html.matchAll(/<button[^>]*data-bell-(alert|notification)="([^"]+)"([^>]*)>/g)].map(m=>({dataset:{[m[1]==='alert'?'bellAlert':'bellNotification']:m[2],target:m[3].match(/data-target="([^"]+)"/)?.[1]}}));},
    closeModal:()=>{state.closed=true;},isAdmin:()=>true,lapiStream:null,notify:m=>state.errors.push(m)
  });
  const bell=vm.runInContext(source+'\nNotificationBell;',context);
  const center=vm.runInContext(alertsSource+'\nAlertCenter;',context);
  vm.runInContext(navSource,context);
  return {bell,center,routes,state,dot,element,buttons:()=>buttons};
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
