const STORAGE_KEY = 'ekiden_timer_v01';
const DEFAULT_NOTICE = '開会式は、体育館で10時からとなっています。参加者は、5分前にはお集まりください。';
const state = loadState();
let currentScreen = 'top';
let currentOperator = null;
let csvPending = null;
let elapsedTimer = null;

function freshState(){
  return {version:1, raceStatus:'before', startAt:null, finishAt:null, notice:DEFAULT_NOTICE, teams:[], measurements:[], passes:[]};
}
function loadState(){
  try { return {...freshState(), ...JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}')}; } catch { return freshState(); }
}
function persist(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); window.dispatchEvent(new CustomEvent('ekiden-state')); }
function fmtClock(ms){
  if(ms==null || ms<0) return '00:00:00.00';
  const cs=Math.floor(ms/10)%100, s=Math.floor(ms/1000)%60, m=Math.floor(ms/60000)%60, h=Math.floor(ms/3600000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}
function fmtTimeOfDay(ts){ return new Date(ts).toLocaleTimeString('ja-JP',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}) + '.' + String(Math.floor(ts%1000/10)).padStart(2,'0'); }
function toast(msg){ const el=document.getElementById('toast'); el.textContent=msg; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),1800); }
function esc(s=''){ return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

const screens = [...document.querySelectorAll('.screen')];
function go(name){
  currentScreen=name; screens.forEach(s=>s.classList.toggle('active',s.id===`screen-${name}`));
  const topbar=document.getElementById('appTopbar'); topbar.classList.toggle('hidden',name==='top');
  const titles={
    'admin-login':'管理者ログイン','timer-login':'計測係ログイン','admin':'管理者画面','timer':'計測係画面','participant':'参加者・閲覧画面'
  }; document.getElementById('topbarTitle').textContent=titles[name]||'駅伝タイム計測';
  if(name==='admin') renderAdmin(); if(name==='timer') renderTimer(); if(name==='participant') renderParticipant();
  window.scrollTo({top:0,behavior:'smooth'});
}
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.go)));
document.getElementById('homeBtn').addEventListener('click',()=>go('top'));
document.getElementById('menuBtn').addEventListener('click',()=>go('top'));

document.getElementById('adminLoginBtn').addEventListener('click',()=>{
  if(document.getElementById('adminPin').value==='1234') go('admin'); else toast('PINが違います');
});
document.querySelectorAll('#operatorSelector button').forEach(btn=>btn.addEventListener('click',()=>{
  currentOperator=btn.dataset.op; document.querySelectorAll('#operatorSelector button').forEach(b=>b.classList.toggle('selected',b===btn)); document.getElementById('timerEnterBtn').disabled=false;
}));
document.getElementById('timerEnterBtn').addEventListener('click',()=>go('timer'));

function statusLabel(){ return state.raceStatus==='running'?'計測中':state.raceStatus==='finished'?'終了':'開始前'; }
function teamProgress(teamNo){
  const ps=state.passes.filter(p=>String(p.teamNo)===String(teamNo)&&p.status!=='deleted');
  return ps.length;
}
function finalizedPasses(){ return state.passes.filter(p=>p.status!=='deleted'); }
function teamTotal(teamNo){
  const ps=finalizedPasses().filter(p=>String(p.teamNo)===String(teamNo));
  if(!ps.length || !state.startAt) return null;
  const latest=ps.slice().sort((a,b)=>a.leg-b.leg).at(-1); return latest.officialAt-state.startAt;
}
function runnerFor(teamNo,leg){ const t=state.teams.find(t=>String(t.teamNo)===String(teamNo)); return t?.runners?.find(r=>Number(r.leg)===Number(leg)); }

function renderAdmin(){
  document.getElementById('adminTeamCount').textContent=state.teams.length;
  document.getElementById('adminPassCount').textContent=finalizedPasses().length;
  const pill=document.getElementById('raceStatusPill'); pill.textContent=statusLabel(); pill.className='status-pill '+(state.raceStatus==='running'?'running':state.raceStatus==='finished'?'finished':'');
  document.getElementById('noticeInput').value=state.notice||'';
  document.getElementById('startRaceBtn').disabled=state.raceStatus==='running';
  document.getElementById('finishRaceBtn').disabled=state.raceStatus!=='running';
  renderAdminLog();
}

document.getElementById('startRaceBtn').addEventListener('click',()=>{
  if(!state.teams.length && !confirm('チーム登録がありません。このまま開始しますか？')) return;
  if(!confirm('全チーム一斉スタートとして計測を開始します。よろしいですか？')) return;
  state.raceStatus='running'; state.startAt=Date.now(); state.finishAt=null; persist(); renderAdmin(); toast('一斉スタートしました');
});
document.getElementById('finishRaceBtn').addEventListener('click',()=>{state.raceStatus='finished';state.finishAt=Date.now();persist();renderAdmin();toast('競技終了にしました');});
document.getElementById('saveNoticeBtn').addEventListener('click',()=>{state.notice=document.getElementById('noticeInput').value.trim();persist();toast('お知らせを更新しました');});

document.getElementById('downloadCsvBtn').addEventListener('click',()=>{
  const rows=[['team_no','team_name','runner_name','sex','age_group','leg'],['1','大豊A','山田 太郎','男','中学生','1'],['1','大豊A','佐藤 花子','女','一般','2']];
  downloadText('\uFEFF'+rows.map(r=>r.join(',')).join('\r\n'),'ekiden_entry_template.csv','text/csv;charset=utf-8');
});
document.getElementById('csvInput').addEventListener('change', async e=>{
  const file=e.target.files?.[0]; if(!file)return; const text=await file.text();
  try{ csvPending=parseEntryCsv(text); renderCsvPreview(csvPending); document.getElementById('commitCsvBtn').disabled=!csvPending.valid; }
  catch(err){ csvPending=null; document.getElementById('csvPreview').innerHTML=`<b>読み込みエラー：</b>${esc(err.message)}`; document.getElementById('commitCsvBtn').disabled=true; }
});
document.getElementById('commitCsvBtn').addEventListener('click',()=>{
  if(!csvPending?.valid)return; state.teams=csvPending.teams; state.measurements=[]; state.passes=[]; state.raceStatus='before'; state.startAt=null; state.finishAt=null; persist(); csvPending=null; document.getElementById('commitCsvBtn').disabled=true; renderAdmin(); toast('エントリーデータを登録しました');
});
function parseEntryCsv(text){
  const lines=parseCsv(text.replace(/^\uFEFF/,'')); if(lines.length<2) throw new Error('データ行がありません。');
  const headers=lines[0].map(x=>x.trim()); const req=['team_no','team_name','runner_name','sex','age_group','leg']; req.forEach(h=>{if(!headers.includes(h)) throw new Error(`列「${h}」がありません。`)});
  const idx=Object.fromEntries(headers.map((h,i)=>[h,i])); const errors=[]; const rows=[];
  lines.slice(1).filter(r=>r.some(v=>String(v).trim())).forEach((r,n)=>{
    const row=Object.fromEntries(req.map(h=>[h,(r[idx[h]]??'').trim()])); row.team_no=row.team_no.replace(/[０-９]/g,s=>String.fromCharCode(s.charCodeAt(0)-0xFEE0)); row.leg=row.leg.replace(/[０-９]/g,s=>String.fromCharCode(s.charCodeAt(0)-0xFEE0));
    if(!row.team_no||!row.team_name||!row.runner_name||!row.leg) errors.push(`${n+2}行目：必須項目が空欄です。`);
    if(!(Number(row.leg)>=1&&Number(row.leg)<=15)) errors.push(`${n+2}行目：legは1〜15で入力してください。`);
    rows.push(row);
  });
  const byTeam=new Map(); rows.forEach(r=>{const k=r.team_no;if(!byTeam.has(k))byTeam.set(k,{teamNo:k,teamName:r.team_name,runners:[]});byTeam.get(k).runners.push({name:r.runner_name,sex:r.sex,ageGroup:r.age_group,leg:Number(r.leg)});});
  byTeam.forEach(t=>{ const legs=t.runners.map(r=>r.leg); const dup=legs.find((x,i)=>legs.indexOf(x)!==i); if(dup)errors.push(`チーム${t.teamNo}：第${dup}区間が重複しています。`); });
  return {valid:errors.length===0,errors,rows,teams:[...byTeam.values()].sort((a,b)=>Number(a.teamNo)-Number(b.teamNo))};
}
function parseCsv(text){
  const out=[];let row=[],cell='',q=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(q){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')q=false;else cell+=c;}else{if(c==='"')q=true;else if(c===','){row.push(cell);cell='';}else if(c==='\n'){row.push(cell.replace(/\r$/,''));out.push(row);row=[];cell='';}else cell+=c;}}
  row.push(cell.replace(/\r$/,''));if(row.some(v=>v!==''))out.push(row);return out;
}
function renderCsvPreview(x){
  const el=document.getElementById('csvPreview'); el.classList.remove('empty');
  if(x.errors.length){el.innerHTML=`<b>${x.errors.length}件のエラー</b><ul>${x.errors.slice(0,8).map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`;return;}
  el.innerHTML=`<b>登録可能：</b>${x.teams.length}チーム / ${x.rows.length}区間分<br><small>${x.teams.slice(0,6).map(t=>`${esc(t.teamNo)} ${esc(t.teamName)}（${t.runners.length}区間）`).join('　')}</small>`;
}

function renderAdminLog(){
  const rows=state.passes.slice().sort((a,b)=>b.officialAt-a.officialAt).slice(0,80);
  const el=document.getElementById('adminLog'); if(!rows.length){el.innerHTML='<div class="empty-state">まだ計測記録はありません。</div>';return;}
  el.innerHTML=`<table class="data-table"><thead><tr><th>チーム</th><th>区間</th><th>走者</th><th>正式通過</th><th>区間タイム</th><th>計測値</th><th>状態</th><th>操作</th></tr></thead><tbody>${rows.map(p=>{
    const prev=state.passes.find(x=>String(x.teamNo)===String(p.teamNo)&&x.leg===p.leg-1&&x.status!=='deleted'); const base=prev?.officialAt??state.startAt; const lap=base?fmtClock(p.officialAt-base):'---'; const ms=state.measurements.filter(m=>p.measurementIds.includes(m.id));
    return `<tr><td>${esc(p.teamNo)} ${esc(p.teamName)}</td><td>${p.leg}/15</td><td>${esc(runnerFor(p.teamNo,p.leg)?.name||'')}</td><td>${fmtTimeOfDay(p.officialAt)}</td><td>${lap}</td><td>${ms.map(m=>`${m.operator}:${fmtTimeOfDay(m.at)}`).join(' / ')}</td><td>${p.review?'⚠ 要確認':'✓'}</td><td><button class="text-btn" data-delete-pass="${p.id}">削除</button></td></tr>`;
  }).join('')}</tbody></table>`;
  el.querySelectorAll('[data-delete-pass]').forEach(b=>b.addEventListener('click',()=>{const p=state.passes.find(x=>x.id===b.dataset.deletePass); if(p&&confirm(`${p.teamName} 第${p.leg}区間の記録を削除しますか？`)){p.status='deleted';persist();renderAdmin();}}));
}

document.getElementById('exportResultsBtn').addEventListener('click',()=>{
  const out=[['team_no','team_name','leg','runner_name','sex','age_group','lap_time','total_time']];
  state.teams.forEach(t=>{for(let leg=1;leg<=15;leg++){const p=state.passes.find(x=>String(x.teamNo)===String(t.teamNo)&&x.leg===leg&&x.status!=='deleted');if(!p)continue;const prev=state.passes.find(x=>String(x.teamNo)===String(t.teamNo)&&x.leg===leg-1&&x.status!=='deleted');const base=prev?.officialAt??state.startAt;const r=runnerFor(t.teamNo,leg)||{};out.push([t.teamNo,t.teamName,leg,r.name||'',r.sex||'',r.ageGroup||'',base?fmtClock(p.officialAt-base):'',state.startAt?fmtClock(p.officialAt-state.startAt):'']);}});
  downloadText('\uFEFF'+out.map(r=>r.map(csvEscape).join(',')).join('\r\n'),'ekiden_results.csv','text/csv;charset=utf-8');
});
function csvEscape(v){const s=String(v??'');return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;}
function downloadText(text,name,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}

function renderTimer(){
  document.getElementById('operatorLabel').textContent=`計測係 ${currentOperator||'-'}`; document.getElementById('racePhaseLabel').textContent=statusLabel();
  document.getElementById('timerNote').textContent=state.raceStatus==='running'?'チーム番号を押すと、その端末の計測時刻を記録します。':state.raceStatus==='finished'?'競技は終了しています。':'管理者が一斉スタートを押すと計測できます。';
  const wrap=document.getElementById('teamButtons');
  if(!state.teams.length){wrap.innerHTML='<div class="empty-state" style="grid-column:1/-1">チームが未登録です。管理者画面からCSVまたはデモデータを登録してください。</div>';}
  else wrap.innerHTML=state.teams.map(t=>{const leg=teamProgress(t.teamNo)+1;return `<button class="team-btn ${leg>15?'finished':''}" data-team="${esc(t.teamNo)}" ${state.raceStatus!=='running'||leg>15?'disabled':''}><strong>${esc(t.teamNo)}</strong><span>${esc(t.teamName)}</span><span class="leg">${leg>15?'FINISH':`次：第${leg}区間`}</span></button>`}).join('');
  wrap.querySelectorAll('[data-team]').forEach(b=>b.addEventListener('click',()=>recordMeasurement(b.dataset.team)));
  renderTimerLog();
}
function recordMeasurement(teamNo){
  if(state.raceStatus!=='running'||!currentOperator)return;
  const t=state.teams.find(x=>String(x.teamNo)===String(teamNo)); if(!t)return;
  const leg=teamProgress(teamNo)+1; if(leg>15)return;
  const at=Date.now(), id=`m_${at}_${currentOperator}_${Math.random().toString(36).slice(2,6)}`;
  const m={id,teamNo:t.teamNo,teamName:t.teamName,leg,operator:currentOperator,at}; state.measurements.push(m);
  const candidates=state.measurements.filter(x=>String(x.teamNo)===String(teamNo)&&x.leg===leg&&Math.abs(x.at-at)<=2500);
  // 同じ計測係の連打は1件として扱う
  const latestByOp={}; candidates.sort((a,b)=>a.at-b.at).forEach(x=>latestByOp[x.operator]=x); const uniq=Object.values(latestByOp);
  let pass=state.passes.find(p=>String(p.teamNo)===String(teamNo)&&p.leg===leg&&p.status!=='deleted');
  const times=uniq.map(x=>x.at).sort((a,b)=>a-b); let officialAt=times[Math.floor((times.length-1)/2)]; if(times.length===2) officialAt=Math.round((times[0]+times[1])/2);
  const spread=times.length>1?times.at(-1)-times[0]:0;
  if(!pass){pass={id:`p_${teamNo}_${leg}_${at}`,teamNo:t.teamNo,teamName:t.teamName,leg,officialAt,measurementIds:uniq.map(x=>x.id),review:uniq.length<3||spread>500,status:'active'};state.passes.push(pass);}
  else{pass.officialAt=officialAt;pass.measurementIds=uniq.map(x=>x.id);pass.review=uniq.length<3||spread>500;}
  persist(); renderTimer(); toast(`${t.teamName} 第${leg}区間を記録`);
}
function renderTimerLog(){
  const mine=state.measurements.filter(m=>m.operator===currentOperator).sort((a,b)=>b.at-a.at).slice(0,8); document.getElementById('operatorRecordCount').textContent=`${state.measurements.filter(m=>m.operator===currentOperator).length}件`;
  const el=document.getElementById('timerLog'); el.innerHTML=mine.length?`<div class="log-list">${mine.map(m=>`<div class="log-item"><span class="log-time">${fmtTimeOfDay(m.at)}</span><span>${esc(m.teamName)} <small>第${m.leg}区間</small></span><span class="measure-badge">${m.operator}</span></div>`).join('')}</div>`:'<div class="empty-state">まだ記録がありません。</div>';
  document.getElementById('undoBtn').disabled=!mine.length;
}
document.getElementById('undoBtn').addEventListener('click',()=>{
  const mine=state.measurements.filter(m=>m.operator===currentOperator).sort((a,b)=>b.at-a.at); const last=mine[0]; if(!last)return;
  state.measurements=state.measurements.filter(m=>m.id!==last.id); const pass=state.passes.find(p=>p.measurementIds.includes(last.id)&&p.status!=='deleted'); if(pass){const remain=pass.measurementIds.map(id=>state.measurements.find(m=>m.id===id)).filter(Boolean).sort((a,b)=>a.at-b.at); if(!remain.length)state.passes=state.passes.filter(p=>p.id!==pass.id);else{const times=remain.map(x=>x.at).sort((a,b)=>a-b);pass.officialAt=times.length===2?Math.round((times[0]+times[1])/2):times[Math.floor((times.length-1)/2)];pass.measurementIds=remain.map(x=>x.id);pass.review=true;}}
  persist();renderTimer();toast('直前の記録を取り消しました');
});

function renderParticipant(){
  document.getElementById('participantNotice').textContent=state.notice||'現在、お知らせはありません。';
  const ranking=state.teams.map(t=>({team:t,legs:teamProgress(t.teamNo),total:teamTotal(t.teamNo)})).sort((a,b)=>b.legs-a.legs || ((a.total??Infinity)-(b.total??Infinity)) || Number(a.team.teamNo)-Number(b.team.teamNo));
  const el=document.getElementById('rankingTable'); if(!ranking.length){el.innerHTML='<div class="empty-state">まだチームが登録されていません。</div>';return;}
  el.innerHTML=ranking.map((r,i)=>`<div class="rank-row"><div class="rank-num">${i+1}位</div><div><div class="rank-team">${esc(r.team.teamName)}</div><div class="rank-meta">チーム ${esc(r.team.teamNo)}</div></div><div class="rank-meta">${r.legs>=15?'FINISH':`第${r.legs}区間`}</div><div class="rank-time">${r.total!=null?fmtClock(r.total):'--:--'}</div></div>`).join('');
}

function renderElapsed(){
  const el=document.getElementById('elapsedClock'); if(!el)return; const end=state.raceStatus==='finished'&&state.finishAt?state.finishAt:Date.now(); el.textContent=state.startAt?fmtClock(Math.max(0,end-state.startAt)):'00:00:00.00';
}
setInterval(()=>{renderElapsed();if(currentScreen==='participant')renderParticipant();},250);
window.addEventListener('storage',e=>{if(e.key===STORAGE_KEY){const incoming=loadState();Object.keys(state).forEach(k=>delete state[k]);Object.assign(state,incoming); if(currentScreen==='admin')renderAdmin();if(currentScreen==='timer')renderTimer();if(currentScreen==='participant')renderParticipant();}});

const demoNames=['大豊A','大杉A','豊永A','清流A','北山A','南風A','桜丘A','みどりA','希望A','つばさA','大豊B','大杉B'];
function demoTeams(){return demoNames.map((name,i)=>({teamNo:String(i+1),teamName:name,runners:Array.from({length:15},(_,j)=>({name:`選手${j+1}`,sex:j%2?'女':'男',ageGroup:j%3===0?'小学生':j%3===1?'中学生':'一般',leg:j+1}))}));}
document.getElementById('loadDemoBtn').addEventListener('click',()=>{state.teams=demoTeams();state.measurements=[];state.passes=[];state.raceStatus='before';state.startAt=null;persist();renderAdmin();toast('デモ12チームを読み込みました');});
document.getElementById('resetBtn').addEventListener('click',()=>{if(!confirm('エントリー・計測記録をすべて初期化します。よろしいですか？'))return;Object.assign(state,freshState());persist();renderAdmin();toast('初期化しました');});

// Firebase接続は第2段階で有効化。設定値がある場合は画面上に準備済み表示。
if(window.EKIDEN_FIREBASE_CONFIG){document.getElementById('syncBadge').textContent='Firebase設定あり（接続実装準備済み）';}else{document.getElementById('syncBadge').textContent='ローカル試作モード';}
renderElapsed();
