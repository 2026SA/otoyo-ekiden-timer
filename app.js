const STORAGE_KEY = 'ekiden_timer_v03_state';
const QUEUE_KEY = 'ekiden_timer_v03_queue';
const DEVICE_KEY = 'ekiden_timer_v03_device';
const ROOT_PATH = (window.EKIDEN_APP_OPTIONS && window.EKIDEN_APP_OPTIONS.rootPath) || 'ekidenTimerV02';
const PASSAGE_WINDOW_MS = 2500;
const SPREAD_WARNING_MS = 500;
const LOCK_STALE_MS = 90000;
const HEARTBEAT_MS = 20000;
const DEFAULT_NOTICE = '開会式は、体育館で10時からとなっています。参加者は、5分前にはお集まりください。';
const DEFAULT_CODES = { admin:'1234', A:'1111', B:'2222', C:'3333' };

let currentScreen = 'top';
let currentOperator = null;
let currentTeamNo = null;
let currentSession = null;
let csvPending = null;
let serverOffsetMs = 0;
let firebaseMode = false;
let firebaseReady = false;
let firebaseConnected = false;
let dbApi = null;
let rootUnsub = null;
let heartbeatTimer = null;
let state = loadLocalState();
let pendingQueue = loadQueue();

function freshState(){
  return {
    meta:{ raceStatus:'before', startAt:null, finishAt:null, notice:DEFAULT_NOTICE, version:6 },
    settings:{ eventName:'大豊学園駅伝大会', eventDate:'', entryDeadline:'', venue:'大豊学園', contact:'大会事務局', entryOpen:true },
    applications:{},
    teams:{},
    officialMeasurements:{},
    teamMeasurements:{},
    adoptions:{},
    overrides:{},
    credentials:{ adminHash:'', operatorHashes:{} },
    locks:{ operators:{}, teams:{} },
    notices:{}
  };
}
function normalizeState(raw){
  const f=freshState();
  const r=raw||{};
  return {
    meta:{...f.meta,...(r.meta||{})},
    settings:{...f.settings,...(r.settings||{})},
    applications:r.applications||{},
    teams:r.teams||{},
    officialMeasurements:r.officialMeasurements||{},
    teamMeasurements:r.teamMeasurements||{},
    adoptions:r.adoptions||{},
    overrides:r.overrides||{},
    credentials:{...f.credentials,...(r.credentials||{}),operatorHashes:{...(r.credentials?.operatorHashes||{})}},
    locks:{operators:{...(r.locks?.operators||{})},teams:{...(r.locks?.teams||{})}},
    notices:r.notices||{}
  };
}
function loadLocalState(){
  try{return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}'));}catch{return freshState();}
}
function saveLocalSnapshot(){
  localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
  window.dispatchEvent(new CustomEvent('ekiden-local-change'));
}
function loadQueue(){
  try{return JSON.parse(localStorage.getItem(QUEUE_KEY)||'[]');}catch{return [];}
}
function saveQueue(){localStorage.setItem(QUEUE_KEY,JSON.stringify(pendingQueue)); renderSyncStatus();}
function getDeviceId(){
  let id=localStorage.getItem(DEVICE_KEY);
  if(!id){id='d_'+cryptoRandom(18);localStorage.setItem(DEVICE_KEY,id);} return id;
}
const DEVICE_ID=getDeviceId();

function cryptoRandom(len=12){
  const a=new Uint8Array(len); crypto.getRandomValues(a); return [...a].map(x=>(x%36).toString(36)).join('');
}
function makeId(prefix='x'){return `${prefix}_${syncedNow()}_${cryptoRandom(8)}`;}
function syncedNow(){return Date.now()+serverOffsetMs;}
function fmtClock(ms){
  if(ms==null||ms<0)return '00:00:00.00';
  const cs=Math.floor(ms/10)%100,s=Math.floor(ms/1000)%60,m=Math.floor(ms/60000)%60,h=Math.floor(ms/3600000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}
function fmtTimeOfDay(ts){
  if(!ts)return '---';
  const d=new Date(ts); return d.toLocaleTimeString('ja-JP',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})+'.'+String(Math.floor(d.getMilliseconds()/10)).padStart(2,'0');
}
function parseTimeOfDay(text,baseTs){
  const m=String(text||'').trim().match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[.:](\d{1,3}))?$/); if(!m)return null;
  const d=new Date(baseTs||Date.now()); d.setHours(Number(m[1]),Number(m[2]),Number(m[3]),Number(String(m[4]||'0').padEnd(3,'0'))); return d.getTime();
}
function esc(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function toast(msg){const el=document.getElementById('toast');el.textContent=msg;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),1900);}
function teamKey(v){return String(v).trim().replace(/[.#$\/[\]]/g,'_');}
function teamList(){return Object.values(state.teams||{}).sort((a,b)=>naturalCompare(a.teamNo,b.teamNo));}
function naturalCompare(a,b){return String(a).localeCompare(String(b),'ja',{numeric:true,sensitivity:'base'});}
function getTeam(no){return state.teams[teamKey(no)]||teamList().find(t=>String(t.teamNo)===String(no));}
function statusLabel(){return state.meta.raceStatus==='running'?'計測中':state.meta.raceStatus==='finished'?'終了':'開始前';}
function runnerFor(teamNo,leg){const t=getTeam(teamNo);return t?.runners?.find(r=>Number(r.leg)===Number(leg));}

function audienceLabel(v){return ({all:'全体',participants:'参加者向け',ekiden:'駅伝参加チーム',funrun:'ファンラン'})[v]||'全体';}
function priorityLabel(v){return v==='important'?'重要':'通常';}
function fmtNoticeTime(ts){if(!ts)return '';const d=new Date(ts);return d.toLocaleString('ja-JP',{hour12:false,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});}
function noticeList(includeHidden=false){
  const arr=Object.values(state.notices||{}).filter(Boolean);
  const visible=arr.filter(n=>includeHidden || n.visible!==false);
  if(!visible.length&&state.meta.notice){
    return [{id:'legacy_notice',title:'大会からのお知らせ',body:state.meta.notice,audience:'all',priority:'important',pinned:true,visible:true,createdAt:state.meta.startAt||0,updatedAt:state.meta.startAt||0,legacy:true}];
  }
  return visible.sort((a,b)=>(Number(!!b.pinned)-Number(!!a.pinned))||((b.updatedAt||b.createdAt||0)-(a.updatedAt||a.createdAt||0)));
}
function clearNoticeForm(){
  const ti=document.getElementById('noticeTitleInput'),bi=document.getElementById('noticeBodyInput'),ai=document.getElementById('noticeAudienceInput'),pi=document.getElementById('noticePriorityInput'),fi=document.getElementById('noticePinInput');
  if(ti)ti.value=''; if(bi)bi.value=''; if(ai)ai.value='all'; if(pi)pi.value='important'; if(fi)fi.checked=false;
}
function createNoticeFromForm(){
  const title=document.getElementById('noticeTitleInput')?.value.trim()||'大会からのお知らせ';
  const body=document.getElementById('noticeBodyInput')?.value.trim()||'';
  if(!body){toast('本文を入力してください');return null;}
  return {id:makeId('notice'),title,body,audience:document.getElementById('noticeAudienceInput')?.value||'all',priority:document.getElementById('noticePriorityInput')?.value||'important',pinned:!!document.getElementById('noticePinInput')?.checked,visible:true,createdAt:syncedNow(),updatedAt:syncedNow()};
}
function renderNoticeBoardAdmin(){
  const el=document.getElementById('noticeBoardAdmin'); if(!el)return;
  const rows=noticeList(true);
  if(!rows.length){el.innerHTML='<div class="notice-empty">まだ掲示板の投稿はありません。</div>';return;}
  el.innerHTML=rows.map(n=>`<div class="notice-card ${n.pinned?'pinned':''} ${n.visible===false?'hidden-notice':''}"><div class="notice-card-head"><div><div class="notice-card-title">${esc(n.title||'大会からのお知らせ')}</div><div class="notice-tags"><span class="notice-tag audience">${esc(audienceLabel(n.audience))}</span><span class="notice-tag ${n.priority==='important'?'important':''}">${esc(priorityLabel(n.priority))}</span>${n.pinned?'<span class="notice-tag pinned">固定表示</span>':''}${n.visible===false?'<span class="notice-tag hidden">非公開</span>':''}</div></div><div class="notice-card-meta">${esc(fmtNoticeTime(n.updatedAt||n.createdAt))}</div></div><div class="notice-body">${esc(n.body||'').replace(/\n/g,'<br>')}</div><div class="notice-actions">${n.legacy?'':`<button class="tiny-btn" data-toggle-notice="${esc(n.id)}">${n.visible===false?'公開する':'非公開にする'}</button> <button class="tiny-btn" data-pin-notice="${esc(n.id)}">${n.pinned?'固定解除':'上部に固定'}</button> <button class="tiny-btn red" data-delete-notice="${esc(n.id)}">削除</button>`}</div></div>`).join('');
  el.querySelectorAll('[data-toggle-notice]').forEach(b=>b.addEventListener('click',()=>{const n=state.notices?.[b.dataset.toggleNotice];if(!n)return;queueWrite(`notices/${n.id}`,{...n,visible:n.visible===false?true:false,updatedAt:syncedNow()});toast(n.visible===false?'お知らせを公開しました':'お知らせを非公開にしました');}));
  el.querySelectorAll('[data-pin-notice]').forEach(b=>b.addEventListener('click',()=>{const n=state.notices?.[b.dataset.pinNotice];if(!n)return;queueWrite(`notices/${n.id}`,{...n,pinned:!n.pinned,updatedAt:syncedNow()});toast(!n.pinned?'上部に固定しました':'固定を解除しました');}));
  el.querySelectorAll('[data-delete-notice]').forEach(b=>b.addEventListener('click',()=>{const n=state.notices?.[b.dataset.deleteNotice];if(!n)return;if(confirm('このお知らせを削除しますか？')){queueWrite(`notices/${n.id}`,null,true);toast('お知らせを削除しました');}}));
}
function renderParticipantNotices(){
  const el=document.getElementById('participantNoticeBoard'); if(!el)return;
  const rows=noticeList(false).filter(n=>n.visible!==false);
  const count=document.getElementById('participantNoticeCount'); if(count)count.textContent=`${rows.length}件`;
  if(!rows.length){el.innerHTML='<div class="notice-empty">現在、お知らせはありません。</div>';return;}
  el.innerHTML=rows.map(n=>`<details class="participant-notice-item ${n.priority==='important'?'important':''} ${n.pinned?'pinned':''}"><summary><div class="participant-notice-summary-main"><div class="notice-card-title">${esc(n.title||'大会からのお知らせ')}</div><div class="notice-tags"><span class="notice-tag audience">${esc(audienceLabel(n.audience))}</span><span class="notice-tag ${n.priority==='important'?'important':''}">${esc(priorityLabel(n.priority))}</span>${n.pinned?'<span class="notice-tag pinned">固定</span>':''}</div></div><div class="participant-notice-summary-side"><span>${esc(fmtNoticeTime(n.updatedAt||n.createdAt))}</span><b class="disclosure-mark">＋</b></div></summary><div class="participant-notice-body">${esc(n.body||'').replace(/\n/g,'<br>')}</div></details>`).join('');
}

async function sha256(text){
  const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(text))); return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function verifyCode(kind,code,operator=null){
  if(kind==='admin'){
    const hash=state.credentials.adminHash; return hash?await sha256(code)===hash:String(code)===DEFAULT_CODES.admin;
  }
  if(kind==='operator'){
    const hash=state.credentials.operatorHashes?.[operator]; return hash?await sha256(code)===hash:String(code)===DEFAULT_CODES[operator];
  }
  return false;
}

function pathParts(path){return path.split('/').filter(Boolean);}
function setByPath(obj,path,value){
  const parts=pathParts(path); let cur=obj;
  for(let i=0;i<parts.length-1;i++){if(!cur[parts[i]]||typeof cur[parts[i]]!=='object')cur[parts[i]]={};cur=cur[parts[i]];}
  cur[parts.at(-1)]=value;
}
function removeByPath(obj,path){
  const parts=pathParts(path); let cur=obj;
  for(let i=0;i<parts.length-1;i++){cur=cur?.[parts[i]];if(!cur)return;} delete cur[parts.at(-1)];
}
function mergePending(raw){
  const copy=structuredClone(raw||{}); pendingQueue.forEach(op=>{if(op.remove)removeByPath(copy,op.path);else setByPath(copy,op.path,op.value);}); return copy;
}
function localApply(path,value,remove=false){
  if(remove)removeByPath(state,path);else setByPath(state,path,value); saveLocalSnapshot(); renderCurrent();
}
function queueWrite(path,value,remove=false){
  if(!firebaseMode){localApply(path,value,remove);return;}
  if(remove)removeByPath(state,path);else setByPath(state,path,value); saveLocalSnapshot(); renderCurrent();
  const op={id:makeId('q'),path,value,remove}; pendingQueue.push(op); saveQueue(); sendQueuedOp(op);
}
function sendQueuedOp(op){
  if(!firebaseReady||!dbApi)return;
  const target=dbApi.ref(dbApi.db,`${ROOT_PATH}/${op.path}`);
  const p=op.remove?dbApi.remove(target):dbApi.set(target,op.value);
  p.then(()=>{pendingQueue=pendingQueue.filter(x=>x.id!==op.id);saveQueue();}).catch(()=>{});
}
function flushQueue(){pendingQueue.slice().forEach(sendQueuedOp);}

async function initFirebase(){
  const config=window.EKIDEN_FIREBASE_CONFIG;
  if(!config){firebaseMode=false;firebaseReady=false;renderSyncStatus();return;}
  firebaseMode=true;
  try{
    const appMod=await import('https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js');
    const dbMod=await import('https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js');
    const authMod=await import('https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js');
    const app=appMod.initializeApp(config);
    const db=dbMod.getDatabase(app);
    const auth=authMod.getAuth(app);
    try{await authMod.signInAnonymously(auth);}catch(e){console.warn('Anonymous auth failed',e);}
    dbApi={...dbMod,db}; firebaseReady=true;
    dbMod.onValue(dbMod.ref(db,'.info/serverTimeOffset'),snap=>{serverOffsetMs=Number(snap.val()||0);renderSyncStatus();});
    dbMod.onValue(dbMod.ref(db,'.info/connected'),snap=>{firebaseConnected=!!snap.val();renderSyncStatus();if(firebaseConnected)flushQueue();});
    rootUnsub=dbMod.onValue(dbMod.ref(db,ROOT_PATH),snap=>{
      const merged=mergePending(snap.val()||{}); state=normalizeState(merged); saveLocalSnapshot(); renderCurrent();
    });
    renderSyncStatus(); flushQueue();
  }catch(err){
    console.error(err); firebaseMode=false;firebaseReady=false;firebaseConnected=false;toast('Firebase接続に失敗。ローカルモードで続行します');renderSyncStatus();
  }
}

function renderSyncStatus(){
  const badge=document.getElementById('syncBadge');
  const cb=document.getElementById('connectionBadge');
  const cd=document.getElementById('connectionDetail');
  const pc=document.getElementById('pendingCount');
  const so=document.getElementById('serverOffsetLabel');
  if(badge){badge.textContent=firebaseMode?(firebaseConnected?'Firebase同期中':'Firebase待機中'):'ローカル試作モード';}
  if(cb){cb.textContent=firebaseMode?(firebaseConnected?'ONLINE':'OFFLINE'):'LOCAL';cb.className='mini-badge '+(firebaseConnected?'online':'');}
  if(cd){cd.textContent=firebaseMode?(firebaseConnected?'複数端末でリアルタイム同期しています。':'通信復旧後に未送信データを再送します。'):'同一ブラウザ内のみ。Firebase設定後に複数端末同期します。';}
  if(pc)pc.textContent=String(pendingQueue.length);
  if(so)so.textContent=`${Math.round(serverOffsetMs)} ms`;
  const cs=document.getElementById('clockStatus'); if(cs)cs.textContent=firebaseMode?`Firebase基準の時刻補正：${Math.round(serverOffsetMs)} ms`:'端末時刻で計測（ローカル試作）';
}

// ---------- Screen navigation ----------
const screens=[...document.querySelectorAll('.screen')];
function go(name){
  currentScreen=name; screens.forEach(s=>s.classList.toggle('active',s.id===`screen-${name}`));
  document.getElementById('appTopbar').classList.toggle('hidden',name==='top');
  const titles={'entry':'参加申込','entry-complete':'申込完了','admin-login':'管理者ログイン','timer-login':'計測係ログイン','admin':'管理者画面','timer':'運営計測','team-timer':'チーム参考計測','participant':'参加者・閲覧画面'};
  document.getElementById('topbarTitle').textContent=titles[name]||'駅伝タイム計測';
  renderCurrent(); window.scrollTo({top:0,behavior:'smooth'});
}
function renderCurrent(){
  renderSyncStatus();
  renderTopStatus();
  if(currentScreen==='entry')renderEntry();
  if(currentScreen==='admin')renderAdmin();
  if(currentScreen==='timer')renderTimer();
  if(currentScreen==='team-timer')renderTeamTimer();
  if(currentScreen==='participant')renderParticipant();
}
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.go)));
document.getElementById('homeBtn').addEventListener('click',async()=>{await releaseCurrentLock();go('top');});
document.getElementById('menuBtn').addEventListener('click',async()=>{await releaseCurrentLock();go('top');});

// ---------- Login ----------
document.getElementById('adminLoginBtn').addEventListener('click',async()=>{
  const ok=await verifyCode('admin',document.getElementById('adminPin').value); if(ok){currentSession={role:'admin'};go('admin');}else toast('アクセスコードが違います');
});
document.querySelectorAll('[data-login-tab]').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('[data-login-tab]').forEach(x=>x.classList.toggle('active',x===btn));
  const official=btn.dataset.loginTab==='official'; document.getElementById('officialLoginPane').classList.toggle('active',official);document.getElementById('teamLoginPane').classList.toggle('active',!official);
}));
document.querySelectorAll('#operatorSelector button').forEach(btn=>btn.addEventListener('click',()=>{
  currentOperator=btn.dataset.op; document.querySelectorAll('#operatorSelector button').forEach(b=>b.classList.toggle('selected',b===btn));document.getElementById('timerEnterBtn').disabled=false;
}));
document.getElementById('timerEnterBtn').addEventListener('click',async()=>{
  if(!currentOperator)return; const ok=await verifyCode('operator',document.getElementById('operatorPin').value,currentOperator); if(!ok){toast('アクセスコードが違います');return;}
  if(!(await claimLock('operators',currentOperator))){toast(`計測係${currentOperator}は別端末で使用中です`);return;}
  currentSession={role:'operator',id:currentOperator};startHeartbeat();go('timer');
});
document.getElementById('teamEnterBtn').addEventListener('click',async()=>{
  const no=document.getElementById('teamLoginNo').value.trim();const code=document.getElementById('teamLoginCode').value.trim();const t=getTeam(no);
  if(!t){toast('チーム番号が見つかりません');return;} if(String(t.accessCode||'')!==String(code)){toast('チーム用アクセスコードが違います');return;}
  if(!(await claimLock('teams',teamKey(no)))){toast('このチームの計測画面は別端末で使用中です');return;}
  currentTeamNo=String(t.teamNo);currentSession={role:'team',id:teamKey(no)};startHeartbeat();go('team-timer');
});

async function claimLock(kind,id){
  const path=`locks/${kind}/${id}`;const now=syncedNow();const val={deviceId:DEVICE_ID,lastSeen:now};
  if(!firebaseMode||!firebaseReady){const cur=state.locks?.[kind]?.[id];if(cur&&cur.deviceId!==DEVICE_ID&&now-cur.lastSeen<LOCK_STALE_MS)return false;localApply(path,val);return true;}
  try{
    const lr=dbApi.ref(dbApi.db,`${ROOT_PATH}/${path}`);const res=await dbApi.runTransaction(lr,cur=>{if(!cur||cur.deviceId===DEVICE_ID||now-Number(cur.lastSeen||0)>LOCK_STALE_MS)return val;return;});
    return !!res.committed;
  }catch{return false;}
}
function startHeartbeat(){clearInterval(heartbeatTimer);heartbeatTimer=setInterval(()=>{
  if(!currentSession||!['operator','team'].includes(currentSession.role))return;const kind=currentSession.role==='operator'?'operators':'teams';queueWrite(`locks/${kind}/${currentSession.id}`,{deviceId:DEVICE_ID,lastSeen:syncedNow()});
},HEARTBEAT_MS);}
async function releaseCurrentLock(){
  clearInterval(heartbeatTimer);heartbeatTimer=null;
  if(currentSession&&['operator','team'].includes(currentSession.role)){
    const kind=currentSession.role==='operator'?'operators':'teams';const path=`locks/${kind}/${currentSession.id}`;const cur=kind==='operators'?state.locks.operators?.[currentSession.id]:state.locks.teams?.[currentSession.id];
    if(cur?.deviceId===DEVICE_ID)queueWrite(path,null,true);
  }
  currentSession=null;currentOperator=null;currentTeamNo=null;
}

// ---------- Data computation ----------
function activeOfficialMeasurements(teamNo=null){
  return Object.values(state.officialMeasurements||{}).filter(m=>m&&m.status!=='deleted'&&(teamNo==null||String(m.teamNo)===String(teamNo))).sort((a,b)=>a.at-b.at);
}
function activeTeamMeasurements(teamNo=null){
  const flat=[];Object.values(state.teamMeasurements||{}).forEach(bucket=>Object.values(bucket||{}).forEach(m=>{if(m&&m.status!=='deleted'&&(teamNo==null||String(m.teamNo)===String(teamNo)))flat.push(m);}));return flat.sort((a,b)=>a.at-b.at);
}
function clusterRows(rows,keyFn){
  const groups=[];for(const row of rows){const key=keyFn(row);let g=groups.at(-1);if(!g||g.key!==key||row.at-g.lastAt>PASSAGE_WINDOW_MS){g={key,rows:[],lastAt:row.at};groups.push(g);}g.rows.push(row);g.lastAt=row.at;}return groups;
}
function officialGroups(teamNo){
  const rows=activeOfficialMeasurements(teamNo);const rawGroups=clusterRows(rows,r=>String(r.teamNo));
  return rawGroups.map(g=>{
    const byOp={};g.rows.forEach(r=>{if(!byOp[r.operator]||r.at<byOp[r.operator].at)byOp[r.operator]=r;});const uniq=Object.values(byOp).sort((a,b)=>a.at-b.at);const times=uniq.map(r=>r.at).sort((a,b)=>a-b);
    let at=times[0];if(times.length===2)at=Math.round((times[0]+times[1])/2);if(times.length>=3)at=times[Math.floor(times.length/2)];const spread=times.length>1?times.at(-1)-times[0]:0;
    return {eventId:`off_${g.rows[0].id}`,source:'official',teamNo:String(g.rows[0].teamNo),rawIds:g.rows.map(r=>r.id),usedRows:uniq,at,spread,count:uniq.length,review:spread>SPREAD_WARNING_MS};
  });
}
function teamGroups(teamNo){
  const rows=activeTeamMeasurements(teamNo);const rawGroups=clusterRows(rows,r=>String(r.teamNo));
  return rawGroups.map(g=>({eventId:`team_${g.rows[0].id}`,source:'team',teamNo:String(g.rows[0].teamNo),rawIds:g.rows.map(r=>r.id),at:g.rows[0].at,count:1,spread:0,review:false}));
}
function isTeamGroupMatched(tg){return officialGroups(tg.teamNo).some(og=>Math.abs(og.at-tg.at)<=PASSAGE_WINDOW_MS);}
function computedPasses(teamNo=null){
  const teams=teamNo!=null?[getTeam(teamNo)].filter(Boolean):teamList();const all=[];
  for(const t of teams){
    let events=officialGroups(t.teamNo).slice();
    teamGroups(t.teamNo).forEach(g=>{if(state.adoptions?.[g.eventId]?.active)events.push({...g,source:'team-adopted'});});
    events=events.sort((a,b)=>a.at-b.at).slice(0,15);
    events.forEach((e,i)=>{const ov=state.overrides?.[e.eventId];all.push({...e,teamName:t.teamName,leg:i+1,officialAt:ov?.officialAt??e.at,override:!!ov});});
  }
  return all;
}
function passesForTeam(teamNo){return computedPasses(teamNo).sort((a,b)=>a.leg-b.leg);}
function teamProgress(teamNo){return passesForTeam(teamNo).length;}
function teamTotal(teamNo){const p=passesForTeam(teamNo).at(-1);return p&&state.meta.startAt?p.officialAt-state.meta.startAt:null;}
function lapTime(pass){if(!pass||!state.meta.startAt)return null;const prev=passesForTeam(pass.teamNo).find(x=>x.leg===pass.leg-1);return pass.officialAt-(prev?.officialAt??state.meta.startAt);}

// ---------- Entry / operations (v0.3) ----------
const AGE_GROUPS=['未就学','小学生','中学生','高校生','一般','40代','50代','60代以上'];
let lastReceiptId='';

function localDayNumber(dateLike){
  if(!dateLike)return null;
  const parts=String(dateLike).split('-').map(Number); if(parts.length!==3||parts.some(Number.isNaN))return null;
  return Math.floor(Date.UTC(parts[0],parts[1]-1,parts[2])/86400000);
}
function todayDayNumber(){const d=new Date();return Math.floor(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())/86400000);}
function daysUntil(dateLike){const n=localDayNumber(dateLike);return n==null?null:n-todayDayNumber();}
function formatShortDate(dateLike){if(!dateLike)return '';const p=String(dateLike).split('-').map(Number);if(p.length!==3)return '';return `${p[0]}年${p[1]}月${p[2]}日`;}
function entryIsOpenNow(){if(!state.settings?.entryOpen)return false;const d=daysUntil(state.settings?.entryDeadline);return d==null||d>=0;}
function countdownText(days,kind){
  if(days==null)return kind==='event'?'日程未設定':'締切未設定';
  if(kind==='event')return days>0?`あと ${days}日`:days===0?'本日開催':'開催済み';
  return days>0?`あと ${days}日`:days===0?'本日締切':'受付終了';
}
function renderTopImportantNotices(){
  const sec=document.getElementById('topImportantSection'),el=document.getElementById('topImportantNotices'); if(!sec||!el)return;
  const rows=noticeList(false).filter(n=>n.visible!==false&&n.priority==='important').slice(0,3);
  sec.classList.toggle('hidden',!rows.length);
  if(!rows.length){el.innerHTML='';return;}
  el.innerHTML=rows.map(n=>`<div class="top-important-item"><div class="top-important-item-head"><span>${esc(n.title||'重要なお知らせ')}</span>${n.pinned?'<em>固定</em>':''}</div><p>${esc(n.body||'').replace(/\n/g,'<br>')}</p></div>`).join('');
}

function renderTopStatus(){
  const cfg=state.settings||{},open=entryIsOpenNow();
  const el=document.getElementById('entryTopStatus');
  if(el)el.textContent=open?'申込受付中・フォームはこちら':'現在、申込受付は終了しています';
  const eventDays=daysUntil(cfg.eventDate),entryDays=daysUntil(cfg.entryDeadline);
  const eventEl=document.getElementById('eventCountdown'),entryEl=document.getElementById('entryCountdown');
  const eventDateEl=document.getElementById('eventDateLabel'),entryDateEl=document.getElementById('entryDeadlineLabel');
  if(eventEl)eventEl.textContent=countdownText(eventDays,'event');
  if(entryEl)entryEl.textContent=cfg.entryOpen?countdownText(entryDays,'entry'):'受付停止中';
  if(eventDateEl)eventDateEl.textContent=cfg.eventDate?formatShortDate(cfg.eventDate):'';
  if(entryDateEl)entryDateEl.textContent=cfg.entryDeadline?formatShortDate(cfg.entryDeadline):'';
  renderTopImportantNotices();
}
function initEntryRows(){
  const body=document.getElementById('entryRunnerRows'); if(!body||body.children.length)return;
  const sexOpts=['男','女','回答しない'].map(v=>`<option>${v}</option>`).join('');
  const ageOpts=AGE_GROUPS.map(v=>`<option>${v}</option>`).join('');
  body.innerHTML=Array.from({length:15},(_,i)=>`<tr data-entry-leg="${i+1}"><td data-label="区間" class="runner-leg"><span class="runner-leg-label">第${i+1}区間</span><span class="runner-leg-number">${i+1}</span></td><td data-label="氏名"><input data-runner-name maxlength="60" placeholder="走者氏名" /></td><td data-label="性別"><select data-runner-sex>${sexOpts}</select></td><td data-label="区分"><select data-runner-group>${ageOpts}</select></td><td data-label="年齢"><input data-runner-age inputmode="numeric" type="number" min="1" max="100" placeholder="任意" /></td></tr>`).join('');
}
function renderEntry(){
  initEntryRows();
  const cfg=state.settings||{};
  document.getElementById('entryEventName').textContent=`${cfg.eventName||'大豊学園駅伝大会'} 参加申込`;
  const open=entryIsOpenNow(),badge=document.getElementById('entryOpenBadge'),closed=document.getElementById('entryClosedMessage'),btn=document.getElementById('entrySubmitBtn');
  badge.textContent=open?'受付中':'受付停止中';badge.className='status-pill '+(open?'running':'finished');
  closed.classList.toggle('hidden',open);closed.textContent=open?'':`現在、駅伝の参加申込は受け付けていません。${cfg.contact?` お問い合わせ：${cfg.contact}`:''}`;
  btn.disabled=!open;
}
function entryRows(){return [...document.querySelectorAll('#entryRunnerRows tr')];}
function fillDemoEntry(){
  const n=Math.floor(Math.random()*900)+100;
  document.getElementById('entryTeamName').value=`ダミーチーム${n}`;
  document.getElementById('entryRepName').value=`代表者${n}`;
  document.getElementById('entryPhone').value='090-0000-0000';
  document.getElementById('entryEmail').value=`dummy${n}@example.com`;
  document.getElementById('entryContactPref').value=['email','phone','fax','postal','student'][n%5];
  document.getElementById('entryFax').value=n%5===2?'0887-00-0000':'';
  document.getElementById('entryAddress').value=n%5===3?'高知県長岡郡大豊町 ダミー住所':'';
  document.getElementById('entryStudentName').value=n%5===4?'大豊学園 児童生徒（ダミー）':'';
  const names=['青木','井上','上田','大西','岡田','加藤','川村','小松','佐々木','田中'];
  entryRows().forEach((row,i)=>{
    const who=i===7?2:i%names.length;
    row.querySelector('[data-runner-name]').value=`${names[who]} ${i===7?'光':'選手'+(who+1)}`;
    row.querySelector('[data-runner-sex]').value=i%2?'女':'男';
    row.querySelector('[data-runner-group]').value=['小学生','中学生','一般','40代'][i%4];
    row.querySelector('[data-runner-age]').value=[10,14,28,45][i%4];
  });
  document.getElementById('entryNotes').value='開発用ダミーデータです。';
  document.getElementById('entryAgree').checked=true;
}
function copyPrevRunner(){
  const rows=entryRows();
  for(let i=1;i<rows.length;i++){
    const cur=rows[i].querySelector('[data-runner-name]'),prev=rows[i-1].querySelector('[data-runner-name]');
    if(!cur.value.trim()&&prev.value.trim()){
      ['name','sex','group','age'].forEach(k=>{const a=rows[i].querySelector(`[data-runner-${k}]`),b=rows[i-1].querySelector(`[data-runner-${k}]`);if(a&&b)a.value=b.value;});
      toast(`第${i+1}区間へ直前の走者をコピーしました`);return;
    }
  }
  toast('コピーできる空欄がありません');
}
function validateContact(pref,data){
  if(pref==='email'&&!data.email)return '希望連絡方法がメールの場合、メールアドレスを入力してください。';
  if(pref==='fax'&&!data.fax)return '希望連絡方法がFAXの場合、FAX番号を入力してください。';
  if(pref==='postal'&&!data.address)return '希望連絡方法が郵送の場合、郵送先住所を入力してください。';
  if(pref==='student'&&!data.studentName)return '児童生徒経由の場合、受取可能な児童生徒名等を入力してください。';
  return '';
}
function receiptNumber(id,ts){const d=new Date(ts);return `E${String(d.getFullYear()).slice(-2)}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${id.slice(-5).toUpperCase()}`;}

initEntryRows();
document.getElementById('fillDemoEntryBtn').addEventListener('click',fillDemoEntry);
document.getElementById('copyPrevRunnerBtn').addEventListener('click',copyPrevRunner);
document.getElementById('entryForm').addEventListener('submit',e=>{
  e.preventDefault(); if(!entryIsOpenNow()){toast('現在、申込受付は終了しています');return;}
  const contact={
    repName:document.getElementById('entryRepName').value.trim(),repType:document.getElementById('entryRepType').value,
    phone:document.getElementById('entryPhone').value.trim(),email:document.getElementById('entryEmail').value.trim(),fax:document.getElementById('entryFax').value.trim(),
    address:document.getElementById('entryAddress').value.trim(),contactPref:document.getElementById('entryContactPref').value,studentName:document.getElementById('entryStudentName').value.trim()
  };
  const err=validateContact(contact.contactPref,contact);if(err){toast(err);return;}
  const runners=entryRows().map((row,i)=>({leg:i+1,name:row.querySelector('[data-runner-name]').value.trim(),sex:row.querySelector('[data-runner-sex]').value,ageGroup:row.querySelector('[data-runner-group]').value,age:Number(row.querySelector('[data-runner-age]').value)||null}));
  const missing=runners.find(r=>!r.name);if(missing){toast(`第${missing.leg}区間の走者名を入力してください`);return;}
  const at=syncedNow(),id=makeId('app');
  const app={id,receiptNo:receiptNumber(id,at),teamName:document.getElementById('entryTeamName').value.trim(),contact,runners,notes:document.getElementById('entryNotes').value.trim(),status:'pending',submittedAt:at,updatedAt:at};
  if(!app.teamName||!contact.repName||!contact.phone){toast('必須項目を確認してください');return;}
  document.getElementById('entrySubmitBtn').disabled=true;queueWrite(`applications/${id}`,app);lastReceiptId=id;
  document.getElementById('entryReceiptNo').textContent=app.receiptNo;document.getElementById('entryCompleteText').textContent=`「${app.teamName}」の申込内容を大会事務局で確認します。`;e.target.reset();entryRows().forEach(row=>{row.querySelector('[data-runner-sex]').value='男';row.querySelector('[data-runner-group]').value='未就学';});go('entry-complete');
});

function renderEventSettings(){
  const x=state.settings||{};
  document.getElementById('settingEventName').value=x.eventName||'';document.getElementById('settingEventDate').value=x.eventDate||'';document.getElementById('settingEntryDeadline').value=x.entryDeadline||'';document.getElementById('settingVenue').value=x.venue||'';document.getElementById('settingContact').value=x.contact||'';document.getElementById('settingEntryOpen').checked=!!x.entryOpen;
}
document.getElementById('saveEventSettingsBtn').addEventListener('click',()=>{
  const x={eventName:document.getElementById('settingEventName').value.trim()||'大豊学園駅伝大会',eventDate:document.getElementById('settingEventDate').value,entryDeadline:document.getElementById('settingEntryDeadline').value,venue:document.getElementById('settingVenue').value.trim(),contact:document.getElementById('settingContact').value.trim(),entryOpen:document.getElementById('settingEntryOpen').checked};
  queueWrite('settings',x);toast('大会・申込設定を保存しました');
});

function entryUrl(){const u=new URL(location.href);u.search='';u.hash='';u.searchParams.set('screen','entry');return u.toString();}
function renderEntryQr(){
  const text=entryUrl(),label=document.getElementById('entryUrlText'),box=document.getElementById('entryQrBox');if(label)label.textContent=text;if(!box)return;box.innerHTML='';
  if(window.QRCode){new window.QRCode(box,{text,width:220,height:220,colorDark:'#102d48',colorLight:'#ffffff',correctLevel:window.QRCode.CorrectLevel.M});}else{box.innerHTML='<div class="empty-state">QRライブラリ読込待ち</div>';}
}
document.getElementById('refreshQrBtn').addEventListener('click',()=>{renderEntryQr();toast('申込QRを更新しました');});
document.getElementById('downloadQrBtn').addEventListener('click',()=>{renderEntryQr();setTimeout(()=>{const box=document.getElementById('entryQrBox'),c=box.querySelector('canvas'),img=box.querySelector('img'),a=document.createElement('a');a.download='ekiden_entry_qr.png';a.href=c?c.toDataURL('image/png'):img?.src||'';if(a.href)a.click();else toast('QR画像を保存できませんでした');},50);});

function applicationList(){return Object.values(state.applications||{}).filter(Boolean).sort((a,b)=>(b.submittedAt||0)-(a.submittedAt||0));}
function contactPrefLabel(v){return ({email:'メール',phone:'電話',fax:'FAX',postal:'郵送',student:'児童生徒経由'})[v]||v||'—';}
function renderApplications(){
  const apps=applicationList(),pending=apps.filter(a=>a.status==='pending').length,approved=apps.filter(a=>a.status==='approved').length,returned=apps.filter(a=>a.status==='returned').length;
  document.getElementById('applicationStats').innerHTML=`<div class="application-stat"><strong>${apps.length}</strong><small>申込総数</small></div><div class="application-stat"><strong>${pending}</strong><small>未確認</small></div><div class="application-stat"><strong>${approved}</strong><small>承認済</small></div>`;
  const el=document.getElementById('applicationList');if(!apps.length){el.innerHTML='<div class="empty-state">申込はまだありません。ダミー申込を追加して画面確認できます。</div>';return;}
  el.innerHTML=`<table class="data-table"><thead><tr><th>受付</th><th>チーム</th><th>代表者・連絡</th><th>選手</th><th>状態</th><th>発行情報</th><th>操作</th></tr></thead><tbody>${apps.map(a=>{
    const c=a.contact||{},status=a.status||'pending',chip=status==='approved'?'approved':status==='returned'?'returned':'pending',statusText=status==='approved'?'承認済':status==='returned'?'差戻し':'未確認';
    const detail=(a.runners||[]).map(r=>`第${r.leg}区 ${r.name}（${r.sex}/${r.ageGroup}${r.age?'/'+r.age+'歳':''}）`).join('、');
    const issued=status==='approved'?`チーム${esc(a.issuedTeamNo||'')} / <span class="team-code-inline">${esc(a.issuedAccessCode||'')}</span>`:'—';
    const actions=status==='pending'?`<button class="tiny-btn green" data-approve-app="${esc(a.id)}">承認</button> <button class="tiny-btn" data-return-app="${esc(a.id)}">差戻し</button>`:status==='returned'?`<button class="tiny-btn" data-reopen-app="${esc(a.id)}">未確認へ戻す</button>`:`<button class="tiny-btn" data-show-team="${esc(a.issuedTeamNo||'')}">チーム確認</button>`;
    return `<tr><td>${esc(a.receiptNo||'')}<br><small>${a.submittedAt?new Date(a.submittedAt).toLocaleString('ja-JP'):''}</small></td><td><strong>${esc(a.teamName||'')}</strong><div class="app-detail">${esc(a.notes||'')}</div></td><td>${esc(c.repName||'')}<div class="app-detail">${esc(c.phone||'')} / ${esc(c.email||'')}<br>希望：${esc(contactPrefLabel(c.contactPref))}${c.studentName?`<br>${esc(c.studentName)}`:''}</div></td><td><details><summary>15区間を確認</summary><div class="app-detail">${esc(detail)}</div></details></td><td><span class="status-chip ${chip}">${statusText}</span></td><td>${issued}</td><td>${actions} <button class="tiny-btn red" data-delete-app="${esc(a.id)}">削除</button></td></tr>`;
  }).join('')}</tbody></table>`;
  el.querySelectorAll('[data-approve-app]').forEach(b=>b.addEventListener('click',()=>approveApplication(b.dataset.approveApp)));
  el.querySelectorAll('[data-return-app]').forEach(b=>b.addEventListener('click',()=>setApplicationStatus(b.dataset.returnApp,'returned')));
  el.querySelectorAll('[data-reopen-app]').forEach(b=>b.addEventListener('click',()=>setApplicationStatus(b.dataset.reopenApp,'pending')));
  el.querySelectorAll('[data-delete-app]').forEach(b=>b.addEventListener('click',()=>deleteApplication(b.dataset.deleteApp)));
  el.querySelectorAll('[data-show-team]').forEach(b=>b.addEventListener('click',()=>toast(`チーム${b.dataset.showTeam}は下の「登録チーム管理」で確認できます`)));
}
function nextTeamNumber(){const used=new Set(teamList().map(t=>String(t.teamNo)));let n=1;while(used.has(String(n)))n++;return String(n);}
function approveApplication(id){
  const a=state.applications?.[id];if(!a||a.status==='approved')return;if(!confirm(`「${a.teamName}」を承認し、チーム番号とアクセスコードを発行しますか？`))return;
  const no=nextTeamNumber(),code=randomNumericCode(),team={teamNo:no,teamName:a.teamName,accessCode:code,runners:(a.runners||[]).map(r=>({...r,leg:Number(r.leg)})),sourceApplicationId:id,representative:{name:a.contact?.repName||'',phone:a.contact?.phone||'',email:a.contact?.email||'',contactPref:a.contact?.contactPref||''}};
  queueWrite(`teams/${teamKey(no)}`,team);queueWrite(`applications/${id}`,{...a,status:'approved',issuedTeamNo:no,issuedAccessCode:code,approvedAt:syncedNow(),updatedAt:syncedNow()});toast(`チーム${no}として承認しました`);
}
function setApplicationStatus(id,status){const a=state.applications?.[id];if(!a)return;queueWrite(`applications/${id}`,{...a,status,updatedAt:syncedNow()});toast(status==='returned'?'差戻しにしました':'未確認へ戻しました');}
function deleteApplication(id){const a=state.applications?.[id];if(!a)return;if(a.status==='approved'){toast('承認済み申込は先に登録チームを確認してください');return;}if(confirm(`申込「${a.teamName}」を削除しますか？`)){queueWrite(`applications/${id}`,null,true);toast('申込を削除しました');}}

function renderTeamManagement(){
  const teams=teamList(),el=document.getElementById('teamManagementList');if(!teams.length){el.innerHTML='<div class="empty-state">登録チームはありません。</div>';return;}
  el.innerHTML=`<table class="data-table"><thead><tr><th>No.</th><th>チーム名</th><th>代表者</th><th>走者</th><th>アクセスコード</th><th>操作</th></tr></thead><tbody>${teams.map(t=>`<tr><td>${esc(t.teamNo)}</td><td>${esc(t.teamName)}</td><td>${esc(t.representative?.name||'—')}</td><td>${(t.runners||[]).length}区間</td><td><span class="team-code-inline">${esc(t.accessCode||'未設定')}</span></td><td><button class="tiny-btn" data-rename-team="${esc(t.teamNo)}">名称変更</button> <button class="tiny-btn" data-regenerate-code="${esc(t.teamNo)}">コード再発行</button> <button class="tiny-btn red" data-delete-team="${esc(t.teamNo)}">削除</button></td></tr>`).join('')}</tbody></table>`;
  el.querySelectorAll('[data-rename-team]').forEach(b=>b.addEventListener('click',()=>renameTeam(b.dataset.renameTeam)));
  el.querySelectorAll('[data-regenerate-code]').forEach(b=>b.addEventListener('click',()=>regenerateTeamCode(b.dataset.regenerateCode)));
  el.querySelectorAll('[data-delete-team]').forEach(b=>b.addEventListener('click',()=>deleteTeam(b.dataset.deleteTeam)));
}
function renameTeam(no){const t=getTeam(no);if(!t)return;const name=prompt('新しいチーム名を入力してください。',t.teamName);if(!name?.trim())return;queueWrite(`teams/${teamKey(no)}`,{...t,teamName:name.trim()});toast('チーム名を変更しました');}
function regenerateTeamCode(no){const t=getTeam(no);if(!t||!confirm(`${t.teamName}のチーム用アクセスコードを再発行しますか？`))return;const code=randomNumericCode();queueWrite(`teams/${teamKey(no)}`,{...t,accessCode:code});if(t.sourceApplicationId&&state.applications?.[t.sourceApplicationId]){const a=state.applications[t.sourceApplicationId];queueWrite(`applications/${t.sourceApplicationId}`,{...a,issuedAccessCode:code,updatedAt:syncedNow()});}toast(`新しいコード：${code}`);}
function deleteTeam(no){const t=getTeam(no);if(!t)return;if(teamProgress(no)>0){toast('計測記録があるチームは削除できません');return;}if(!confirm(`チーム${no}「${t.teamName}」を削除しますか？`))return;queueWrite(`teams/${teamKey(no)}`,null,true);if(t.sourceApplicationId&&state.applications?.[t.sourceApplicationId]){const a=state.applications[t.sourceApplicationId];queueWrite(`applications/${t.sourceApplicationId}`,{...a,status:'pending',issuedTeamNo:null,issuedAccessCode:null,approvedAt:null,updatedAt:syncedNow()});}toast('チームを削除しました');}

function makeDummyApplication(seed){
  const groups=['小学生','中学生','一般','40代'];const surnames=['山田','佐藤','高橋','小川','西村','森','岡本','藤田'];const submittedAt=syncedNow()-seed*60000,id=makeId(`dummy${seed}`),pref=['email','phone','fax','postal','student'][seed%5];
  return {id,receiptNo:receiptNumber(id,submittedAt),teamName:['大豊ファミリー','杉の子ランナーズ','吉野川スマイル','おおとよフレンズ','山びこチーム','れいほくスターズ'][seed%6]+seed,contact:{repName:`代表 ${surnames[seed%surnames.length]}`,repType:seed%2?'保護者':'参加者',phone:'090-0000-'+String(1000+seed),email:pref==='email'?`dummy${seed}@example.com`:'',fax:pref==='fax'?'0887-00-0000':'',address:pref==='postal'?'高知県長岡郡大豊町（ダミー）':'',contactPref:pref,studentName:pref==='student'?'大豊学園 児童生徒（ダミー）':''},runners:Array.from({length:15},(_,i)=>{const same=(i===8?2:i);return {leg:i+1,name:`${surnames[(same+seed)%surnames.length]} 選手${(same%7)+1}`,sex:(i+seed)%2?'女':'男',ageGroup:groups[(i+seed)%groups.length],age:[10,14,29,45][(i+seed)%4]};}),notes:'開発用ダミー申込',status:'pending',submittedAt,updatedAt:submittedAt};
}
document.getElementById('loadDemoApplicationsBtn').addEventListener('click',()=>{const merged={...(state.applications||{})};for(let i=1;i<=6;i++){const a=makeDummyApplication(i);merged[a.id]=a;}queueWrite('applications',merged);toast('ダミー申込を6件追加しました');});
document.getElementById('exportApplicationsBtn').addEventListener('click',()=>{
  const out=[['receipt_no','status','team_name','representative','phone','email','fax','address','contact_preference','student_contact','notes','submitted_at','issued_team_no','issued_access_code']];applicationList().forEach(a=>{const c=a.contact||{};out.push([a.receiptNo||'',a.status||'',a.teamName||'',c.repName||'',c.phone||'',c.email||'',c.fax||'',c.address||'',contactPrefLabel(c.contactPref),c.studentName||'',a.notes||'',a.submittedAt?new Date(a.submittedAt).toISOString():'',a.issuedTeamNo||'',a.issuedAccessCode||'']);});downloadText('\uFEFF'+out.map(r=>r.map(csvEscape).join(',')).join('\r\n'),'ekiden_applications_v03.csv','text/csv;charset=utf-8');
});

// ---------- Admin ----------
function renderAdmin(){
  const passes=computedPasses();document.getElementById('adminTeamCount').textContent=teamList().length;document.getElementById('adminPassCount').textContent=passes.length;
  const pill=document.getElementById('raceStatusPill');pill.textContent=statusLabel();pill.className='status-pill '+(state.meta.raceStatus==='running'?'running':state.meta.raceStatus==='finished'?'finished':'');
  document.getElementById('startRaceBtn').disabled=state.meta.raceStatus==='running';document.getElementById('finishRaceBtn').disabled=state.meta.raceStatus!=='running';
  renderEventSettings();renderEntryQr();renderApplications();renderTeamManagement();
  renderTeamCodes();renderAdminPassLog();renderRawOfficialLog();renderTeamBackupLog();renderNoticeBoardAdmin();renderSyncStatus();
}
document.getElementById('startRaceBtn').addEventListener('click',()=>{
  if(!teamList().length&&!confirm('チーム登録がありません。このまま開始しますか？'))return;if(!confirm('全チーム一斉スタートとして計測を開始します。よろしいですか？'))return;
  queueWrite('meta',{...state.meta,raceStatus:'running',startAt:syncedNow(),finishAt:null});toast('一斉スタートしました');
});
document.getElementById('finishRaceBtn').addEventListener('click',()=>{queueWrite('meta',{...state.meta,raceStatus:'finished',finishAt:syncedNow()});toast('競技終了にしました');});
document.getElementById('saveNoticeBtn').addEventListener('click',()=>{const notice=createNoticeFromForm(); if(!notice)return; queueWrite(`notices/${notice.id}`,notice); queueWrite('meta/notice',notice.body); toast('掲示板に投稿しました'); clearNoticeForm();});
document.getElementById('clearNoticeFormBtn').addEventListener('click',()=>clearNoticeForm());
document.getElementById('saveAccessCodesBtn').addEventListener('click',async()=>{
  const a=document.getElementById('newAdminCode').value.trim(),A=document.getElementById('newOpACode').value.trim(),B=document.getElementById('newOpBCode').value.trim(),C=document.getElementById('newOpCCode').value.trim();
  const cred=structuredClone(state.credentials||{adminHash:'',operatorHashes:{}});cred.operatorHashes=cred.operatorHashes||{};
  if(a)cred.adminHash=await sha256(a);if(A)cred.operatorHashes.A=await sha256(A);if(B)cred.operatorHashes.B=await sha256(B);if(C)cred.operatorHashes.C=await sha256(C);
  queueWrite('credentials',cred);['newAdminCode','newOpACode','newOpBCode','newOpCCode'].forEach(id=>document.getElementById(id).value='');toast('アクセスコードを更新しました');
});

function renderTeamCodes(){
  const el=document.getElementById('teamCodeList'),teams=teamList();if(!teams.length){el.innerHTML='<div class="empty-state">チーム未登録</div>';return;}
  el.innerHTML=`<table class="data-table"><thead><tr><th>チーム</th><th>コード</th></tr></thead><tbody>${teams.map(t=>`<tr><td>${esc(t.teamNo)} ${esc(t.teamName)}</td><td><code>${esc(t.accessCode||'未設定')}</code></td></tr>`).join('')}</tbody></table>`;
}
function renderAdminPassLog(){
  const rows=computedPasses().sort((a,b)=>b.officialAt-a.officialAt),el=document.getElementById('adminPassLog');if(!rows.length){el.innerHTML='<div class="empty-state">まだ正式通過記録はありません。</div>';return;}
  el.innerHTML=`<table class="data-table"><thead><tr><th>チーム</th><th>区間</th><th>走者</th><th>正式通過</th><th>区間タイム</th><th>根拠</th><th>状態</th><th>操作</th></tr></thead><tbody>${rows.map(p=>{
    const reason=p.source==='official'?p.usedRows.map(r=>`${r.operator}:${fmtTimeOfDay(r.at)}`).join(' / '):'チーム参考記録';const status=p.source==='team-adopted'?'参考記録採用':p.review?`差 ${p.spread}ms`:`${p.count}名計測`;
    return `<tr><td>${esc(p.teamNo)} ${esc(p.teamName)}</td><td>${p.leg}/15</td><td>${esc(runnerFor(p.teamNo,p.leg)?.name||'')}</td><td>${fmtTimeOfDay(p.officialAt)}${p.override?' *':''}</td><td>${fmtClock(lapTime(p))}</td><td>${esc(reason)}</td><td>${esc(status)}</td><td><button class="text-btn" data-edit-time="${esc(p.eventId)}">時刻修正</button>${p.source==='team-adopted'?` <button class="text-btn" data-unadopt="${esc(p.eventId)}">採用取消</button>`:''}</td></tr>`;
  }).join('')}</tbody></table>`;
  el.querySelectorAll('[data-edit-time]').forEach(b=>b.addEventListener('click',()=>editPassTime(b.dataset.editTime)));
  el.querySelectorAll('[data-unadopt]').forEach(b=>b.addEventListener('click',()=>{const id=b.dataset.unadopt;queueWrite(`adoptions/${id}`,null,true);queueWrite(`overrides/${id}`,null,true);toast('チーム参考記録の採用を取り消しました');}));
}
function editPassTime(eventId){
  const p=computedPasses().find(x=>x.eventId===eventId);if(!p)return;const val=prompt('正式通過時刻を HH:MM:SS.cc で入力してください。',fmtTimeOfDay(p.officialAt));if(val==null)return;const ts=parseTimeOfDay(val,state.meta.startAt||p.officialAt);if(!ts){toast('時刻形式を確認してください');return;}queueWrite(`overrides/${eventId}`,{officialAt:ts,updatedAt:syncedNow()});toast('正式時刻を修正しました');
}
function renderRawOfficialLog(){
  const rows=activeOfficialMeasurements().sort((a,b)=>b.at-a.at).slice(0,120),el=document.getElementById('rawOfficialLog');if(!rows.length){el.innerHTML='<div class="empty-state">まだ運営側の生計測はありません。</div>';return;}
  const options=teamList().map(t=>`<option value="${esc(t.teamNo)}">${esc(t.teamNo)} ${esc(t.teamName)}</option>`).join('');
  el.innerHTML=`<table class="data-table"><thead><tr><th>時刻</th><th>計測係</th><th>チーム</th><th>操作</th></tr></thead><tbody>${rows.map(m=>`<tr><td>${fmtTimeOfDay(m.at)}</td><td>${esc(m.operator)}</td><td><select class="inline-select" data-raw-team="${esc(m.id)}">${options}</select></td><td><button class="text-btn" data-save-raw="${esc(m.id)}">変更</button> <button class="text-btn danger-text" data-delete-raw="${esc(m.id)}">削除</button></td></tr>`).join('')}</tbody></table>`;
  rows.forEach(m=>{const s=el.querySelector(`[data-raw-team="${CSS.escape(m.id)}"]`);if(s)s.value=String(m.teamNo);});
  el.querySelectorAll('[data-save-raw]').forEach(b=>b.addEventListener('click',()=>{const id=b.dataset.saveRaw,s=el.querySelector(`[data-raw-team="${CSS.escape(id)}"]`),m=state.officialMeasurements[id];if(!m||!s)return;queueWrite(`officialMeasurements/${id}`,{...m,teamNo:s.value,teamName:getTeam(s.value)?.teamName||m.teamName});toast('チームを修正しました');}));
  el.querySelectorAll('[data-delete-raw]').forEach(b=>b.addEventListener('click',()=>{if(confirm('この生計測データを削除しますか？')){queueWrite(`officialMeasurements/${b.dataset.deleteRaw}`,null,true);toast('削除しました');}}));
}
function renderTeamBackupLog(){
  const groups=teamList().flatMap(t=>teamGroups(t.teamNo)).sort((a,b)=>b.at-a.at),el=document.getElementById('teamBackupLog');if(!groups.length){el.innerHTML='<div class="empty-state">チーム参考計測はまだありません。</div>';return;}
  el.innerHTML=`<table class="data-table"><thead><tr><th>チーム</th><th>参考時刻</th><th>状態</th><th>操作</th></tr></thead><tbody>${groups.map(g=>{const adopted=!!state.adoptions?.[g.eventId]?.active,matched=isTeamGroupMatched(g);return `<tr><td>${esc(g.teamNo)} ${esc(getTeam(g.teamNo)?.teamName||'')}</td><td>${fmtTimeOfDay(g.at)}</td><td>${adopted?'正式記録に採用済':matched?'運営記録あり':'未照合'}</td><td>${adopted?`<button class="text-btn" data-backup-unadopt="${esc(g.eventId)}">採用取消</button>`:matched?'—':`<button class="text-btn" data-backup-adopt="${esc(g.eventId)}">正式記録に採用</button>`}</td></tr>`;}).join('')}</tbody></table>`;
  el.querySelectorAll('[data-backup-adopt]').forEach(b=>b.addEventListener('click',()=>{if(confirm('このチーム参考記録を正式記録の補完として採用しますか？')){queueWrite(`adoptions/${b.dataset.backupAdopt}`,{active:true,adoptedAt:syncedNow()});toast('正式記録に採用しました');}}));
  el.querySelectorAll('[data-backup-unadopt]').forEach(b=>b.addEventListener('click',()=>{queueWrite(`adoptions/${b.dataset.backupUnadopt}`,null,true);toast('採用を取り消しました');}));
}

// ---------- CSV temporary entry ----------
document.getElementById('downloadCsvBtn').addEventListener('click',()=>{
  const rows=[['team_no','team_name','team_code','runner_name','sex','age_group','leg'],['1','大豊A','1001','山田 太郎','男','中学生','1'],['1','大豊A','1001','佐藤 花子','女','一般','2']];downloadText('\uFEFF'+rows.map(r=>r.join(',')).join('\r\n'),'ekiden_entry_template_v02.csv','text/csv;charset=utf-8');
});
document.getElementById('csvInput').addEventListener('change',async e=>{const f=e.target.files?.[0];if(!f)return;try{csvPending=parseEntryCsv(await f.text());renderCsvPreview(csvPending);document.getElementById('commitCsvBtn').disabled=!csvPending.valid;}catch(err){csvPending=null;document.getElementById('csvPreview').innerHTML=`<b>読み込みエラー：</b>${esc(err.message)}`;document.getElementById('commitCsvBtn').disabled=true;}});
document.getElementById('commitCsvBtn').addEventListener('click',()=>{if(!csvPending?.valid)return;queueWrite('teams',csvPending.teams);clearRaceMeasurements();csvPending=null;document.getElementById('commitCsvBtn').disabled=true;toast('チームデータを登録しました');});
function parseEntryCsv(text){
  const lines=parseCsv(text.replace(/^\uFEFF/,''));if(lines.length<2)throw new Error('データ行がありません。');const headers=lines[0].map(x=>x.trim());const req=['team_no','team_name','runner_name','sex','age_group','leg'];req.forEach(h=>{if(!headers.includes(h))throw new Error(`列「${h}」がありません。`);});const idx=Object.fromEntries(headers.map((h,i)=>[h,i]));const hasCode=headers.includes('team_code'),errors=[],rows=[];
  lines.slice(1).filter(r=>r.some(v=>String(v).trim())).forEach((r,n)=>{const row=Object.fromEntries(req.map(h=>[h,(r[idx[h]]??'').trim()]));row.team_code=hasCode?(r[idx.team_code]??'').trim():'';row.team_no=zenToHan(row.team_no);row.leg=zenToHan(row.leg);if(!row.team_no||!row.team_name||!row.runner_name||!row.leg)errors.push(`${n+2}行目：必須項目が空欄です。`);if(/[.#$\/[\]]/.test(row.team_no))errors.push(`${n+2}行目：team_noに使用できない記号があります。`);if(!(Number(row.leg)>=1&&Number(row.leg)<=15))errors.push(`${n+2}行目：legは1〜15で入力してください。`);rows.push(row);});
  const teams={};rows.forEach(r=>{const k=teamKey(r.team_no);if(!teams[k])teams[k]={teamNo:r.team_no,teamName:r.team_name,accessCode:r.team_code||randomNumericCode(),runners:[]};if(r.team_code&&teams[k].accessCode!==r.team_code)errors.push(`チーム${r.team_no}：team_codeが行によって異なります。`);teams[k].runners.push({name:r.runner_name,sex:r.sex,ageGroup:r.age_group,leg:Number(r.leg)});});
  Object.values(teams).forEach(t=>{const legs=t.runners.map(r=>r.leg),dup=legs.find((x,i)=>legs.indexOf(x)!==i);if(dup)errors.push(`チーム${t.teamNo}：第${dup}区間が重複しています。`);});return {valid:!errors.length,errors,rows,teams};
}
function zenToHan(s){return String(s).replace(/[０-９]/g,x=>String.fromCharCode(x.charCodeAt(0)-0xFEE0));}
function randomNumericCode(){const a=new Uint32Array(1);crypto.getRandomValues(a);return String(100000+(a[0]%900000));}
function parseCsv(text){const out=[];let row=[],cell='',q=false;for(let i=0;i<text.length;i++){const c=text[i];if(q){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')q=false;else cell+=c;}else{if(c==='"')q=true;else if(c===','){row.push(cell);cell='';}else if(c==='\n'){row.push(cell.replace(/\r$/,''));out.push(row);row=[];cell='';}else cell+=c;}}row.push(cell.replace(/\r$/,''));if(row.some(v=>v!==''))out.push(row);return out;}
function renderCsvPreview(x){const el=document.getElementById('csvPreview');el.classList.remove('empty');if(x.errors.length){el.innerHTML=`<b>${x.errors.length}件のエラー</b><ul>${x.errors.slice(0,10).map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`;return;}el.innerHTML=`<b>登録可能：</b>${Object.keys(x.teams).length}チーム / ${x.rows.length}区間分<br><small>チーム用コードが空欄の場合は6桁で自動発行します。</small>`;}
function clearRaceMeasurements(){queueWrite('officialMeasurements',{});queueWrite('teamMeasurements',{});queueWrite('adoptions',{});queueWrite('overrides',{});queueWrite('meta',{...state.meta,raceStatus:'before',startAt:null,finishAt:null});}

// ---------- Official timer ----------
function renderTimer(){
  document.getElementById('operatorLabel').textContent=`計測係 ${currentOperator||'-'}`;document.getElementById('racePhaseLabel').textContent=statusLabel();document.getElementById('timerNote').textContent=state.meta.raceStatus==='running'?'接近するチームを声かけで押し分けてください。複数人の計測値は自動統合されます。':state.meta.raceStatus==='finished'?'競技は終了しています。':'管理者が一斉スタートを押すと計測できます。';
  const wrap=document.getElementById('teamButtons'),teams=teamList();if(!teams.length)wrap.innerHTML='<div class="empty-state" style="grid-column:1/-1">チームが未登録です。</div>';else wrap.innerHTML=teams.map(t=>{const leg=teamProgress(t.teamNo)+1;return `<button class="team-btn ${leg>15?'finished':''}" data-team="${esc(t.teamNo)}" ${state.meta.raceStatus!=='running'||leg>15?'disabled':''}><strong>${esc(t.teamNo)}</strong><span>${esc(t.teamName)}</span><span class="leg">${leg>15?'FINISH':`次：第${leg}区間`}</span></button>`;}).join('');wrap.querySelectorAll('[data-team]').forEach(b=>b.addEventListener('click',()=>recordOfficialMeasurement(b.dataset.team)));renderTimerLog();
}
function recordOfficialMeasurement(teamNo){
  if(state.meta.raceStatus!=='running'||!currentOperator)return;const t=getTeam(teamNo);if(!t)return;const id=makeId('om'),rec={id,teamNo:String(t.teamNo),teamName:t.teamName,operator:currentOperator,at:syncedNow(),localAt:Date.now(),deviceId:DEVICE_ID,status:'active'};queueWrite(`officialMeasurements/${id}`,rec);toast(`${t.teamName} を記録`);
}
function renderTimerLog(){
  const mine=activeOfficialMeasurements().filter(m=>m.operator===currentOperator).sort((a,b)=>b.at-a.at).slice(0,10);document.getElementById('operatorRecordCount').textContent=`${activeOfficialMeasurements().filter(m=>m.operator===currentOperator).length}件`;document.getElementById('timerLog').innerHTML=mine.length?`<div class="log-list">${mine.map(m=>`<div class="log-item"><span class="log-time">${fmtTimeOfDay(m.at)}</span><span>${esc(m.teamName)}</span><span class="measure-badge">${esc(m.operator)}</span></div>`).join('')}</div>`:'<div class="empty-state">まだ記録がありません。</div>';document.getElementById('undoBtn').disabled=!mine.length;
}
document.getElementById('undoBtn').addEventListener('click',()=>{const last=activeOfficialMeasurements().filter(m=>m.operator===currentOperator).sort((a,b)=>b.at-a.at)[0];if(!last)return;queueWrite(`officialMeasurements/${last.id}`,null,true);toast('直前の記録を取り消しました');});
document.getElementById('timerLogoutBtn').addEventListener('click',async()=>{await releaseCurrentLock();go('top');});

// ---------- Team backup timer ----------
function renderTeamTimer(){
  const t=getTeam(currentTeamNo);if(!t){document.getElementById('teamTimerName').textContent='未登録';return;}document.getElementById('teamTimerNo').textContent=`チーム ${t.teamNo}`;document.getElementById('teamTimerName').textContent=t.teamName;const groups=teamGroups(t.teamNo);const next=groups.length+1;document.getElementById('teamPassLeg').textContent=next>15?'FINISH':`第${next}区間`;document.getElementById('teamPassBtn').disabled=state.meta.raceStatus!=='running'||next>15;document.getElementById('teamTimerNote').textContent=state.meta.raceStatus==='running'?'自チームの選手が計測地点を通過した瞬間に押してください。':state.meta.raceStatus==='finished'?'競技は終了しています。':'管理者が一斉スタートを押すと計測できます。';document.getElementById('teamRecordCount').textContent=`${groups.length}件`;document.getElementById('teamTimerLog').innerHTML=groups.length?`<div class="log-list">${groups.slice().reverse().slice(0,15).map((g,i)=>`<div class="log-item"><span class="log-time">${fmtTimeOfDay(g.at)}</span><span>${esc(t.teamName)}</span><span class="measure-badge">参考</span></div>`).join('')}</div>`:'<div class="empty-state">まだ参考記録がありません。</div>';document.getElementById('teamUndoBtn').disabled=!groups.length;
}
document.getElementById('teamPassBtn').addEventListener('click',()=>{const t=getTeam(currentTeamNo);if(!t||state.meta.raceStatus!=='running')return;const id=makeId('tm'),rec={id,teamNo:String(t.teamNo),teamName:t.teamName,at:syncedNow(),localAt:Date.now(),deviceId:DEVICE_ID,status:'active'};queueWrite(`teamMeasurements/${teamKey(t.teamNo)}/${id}`,rec);toast('チーム参考タイムを記録しました');});
document.getElementById('teamUndoBtn').addEventListener('click',()=>{const rows=activeTeamMeasurements(currentTeamNo).sort((a,b)=>b.at-a.at);const last=rows[0];if(!last)return;queueWrite(`teamMeasurements/${teamKey(currentTeamNo)}/${last.id}`,null,true);toast('直前の参考記録を取り消しました');});
document.getElementById('teamLogoutBtn').addEventListener('click',async()=>{await releaseCurrentLock();go('top');});

// ---------- Participant ----------
function renderParticipant(){
  renderParticipantNotices();
  const ranking=teamList().map(t=>({team:t,legs:teamProgress(t.teamNo),total:teamTotal(t.teamNo),passes:passesForTeam(t.teamNo)})).sort((a,b)=>b.legs-a.legs||((a.total??Infinity)-(b.total??Infinity))||naturalCompare(a.team.teamNo,b.team.teamNo));
  const el=document.getElementById('participantTeamList'); if(!el)return;
  if(!ranking.length){el.innerHTML='<div class="empty-state">まだチームが登録されていません。</div>';return;}
  el.innerHTML=ranking.map((r,i)=>{
    const progress=r.legs===0?'未通過':r.legs>=15?'FINISH':`第${r.legs}区間`;
    const records=r.passes.length?r.passes.map(p=>{const runner=runnerFor(p.teamNo,p.leg)||{};return `<div class="team-record-row"><span class="record-leg">第${p.leg}区間</span><span class="record-runner">${esc(runner.name||'走者未登録')}</span><span class="record-lap">${fmtClock(lapTime(p))}</span><span class="record-total">累積 ${state.meta.startAt?fmtClock(p.officialAt-state.meta.startAt):'--:--'}</span></div>`;}).join(''):'<div class="team-record-empty">まだ通過記録はありません。</div>';
    return `<details class="participant-team-item"><summary><div class="team-rank-badge">${i+1}<small>位</small></div><div class="team-summary-name"><strong>${esc(r.team.teamName)}</strong><span>チーム ${esc(r.team.teamNo)}</span></div><div class="team-summary-progress"><span>${progress}</span><strong>${r.total!=null?fmtClock(r.total):'--:--'}</strong></div><b class="disclosure-mark">＋</b></summary><div class="team-record-body">${records}</div></details>`;
  }).join('');
}

// ---------- Demo / reset / export ----------
const demoNames=['大豊A','大杉A','豊永A','清流A','北山A','南風A','桜丘A','みどりA','希望A','つばさA','大豊B','大杉B'];
function demoTeams(){const obj={};demoNames.forEach((name,i)=>{const no=String(i+1);obj[teamKey(no)]={teamNo:no,teamName:name,accessCode:String(1001+i),runners:Array.from({length:15},(_,j)=>({name:`選手${j+1}`,sex:j%2?'女':'男',ageGroup:j%3===0?'小学生':j%3===1?'中学生':'一般',leg:j+1}))};});return obj;}
document.getElementById('loadDemoBtn').addEventListener('click',()=>{if(!confirm('デモ12チームを読み込み、現在の計測データを初期化しますか？'))return;queueWrite('teams',demoTeams());clearRaceMeasurements();toast('デモ12チームを読み込みました');});
document.getElementById('resetBtn').addEventListener('click',()=>{if(!confirm('申込・チーム・計測記録・設定をすべて初期化します。よろしいですか？'))return;const f=freshState();['meta','settings','applications','teams','officialMeasurements','teamMeasurements','adoptions','overrides','credentials','locks','notices'].forEach(k=>queueWrite(k,f[k]));toast('初期化しました');});
document.getElementById('exportResultsBtn').addEventListener('click',()=>{
  const out=[['team_no','team_name','leg','runner_name','sex','age_group','lap_time','total_time','source']];computedPasses().sort((a,b)=>naturalCompare(a.teamNo,b.teamNo)||a.leg-b.leg).forEach(p=>{const r=runnerFor(p.teamNo,p.leg)||{};out.push([p.teamNo,p.teamName,p.leg,r.name||'',r.sex||'',r.ageGroup||'',fmtClock(lapTime(p)),fmtClock(p.officialAt-state.meta.startAt),p.source]);});downloadText('\uFEFF'+out.map(r=>r.map(csvEscape).join(',')).join('\r\n'),'ekiden_results_v02.csv','text/csv;charset=utf-8');
});
function csvEscape(v){const s=String(v??'');return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;}
function downloadText(text,name,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}

// ---------- Clocks / cross-tab ----------
function renderElapsed(){
  const end=state.meta.raceStatus==='finished'&&state.meta.finishAt?state.meta.finishAt:syncedNow();const v=state.meta.startAt?fmtClock(Math.max(0,end-state.meta.startAt)):'00:00:00.00';const a=document.getElementById('elapsedClock'),b=document.getElementById('teamElapsedClock');if(a)a.textContent=v;if(b)b.textContent=v;
}
setInterval(()=>{renderElapsed();if(currentScreen==='participant')renderParticipant();},250);
window.addEventListener('storage',e=>{if(firebaseMode)return;if(e.key===STORAGE_KEY){state=loadLocalState();renderCurrent();}});
window.addEventListener('beforeunload',()=>{});

renderElapsed();renderSyncStatus();initFirebase();
const initialScreen=new URLSearchParams(location.search).get('screen');if(initialScreen==='entry')go('entry');else renderTopStatus();
