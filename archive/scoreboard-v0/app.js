import { createMatch, applyCommand, tally } from '/engine.js';
const rules = { durationMs: 60000, shidoLimit: 3, wazaForIppon: 2, enabledScores: ['YUKO','WAZA_ARI','IPPON'], holdThresholds: [{ms:5000,score:'YUKO'},{ms:10000,score:'WAZA_ARI'},{ms:20000,score:'IPPON'}] };
let state = createMatch(rules), anchor = performance.now(), lastSignature = '';
const $ = id => document.getElementById(id);
const names = {WHITE:'Спортсмен А',BLUE:'Спортсмен Б'};
const labels = {YUKO:'Юко',WAZA_ARI:'Ваза-ари',IPPON:'Иппон',SHIDO:'Шидо'};
const statuses = {READY:'Готова к запуску',RUNNING:'Схватка идёт',PAUSED:'Время остановлено',DECISION:'Необходимо решение',PROVISIONAL:'Предварительный результат',CONFIRMED:'Деморезультат подтверждён'};
const reasons = {IPPON:'Иппон',COMBINATION:'Комбинация оценок',TIME:'Преимущество по истечении времени',ACCUMULATED_SHIDO:'Накопление Shido',GOLDEN_SCORE:'Оценка в Golden Score'};
function dispatch(action) { state = applyCommand(state,{...action,id:crypto.randomUUID(),expectedVersion:state.version}); }
function syncClock() {
 const now = performance.now();
 const ms = Math.floor(now-anchor);
 if (state.status === 'RUNNING') {
  if(ms>0) { dispatch({type:'ADVANCE',ms}); anchor += ms; }
 } else anchor = now;
}
function send(action) {
 try { syncClock(); dispatch(action); anchor=performance.now(); $('error').textContent=''; }
 catch(e) { $('error').textContent = ({RESOLVE_HOLD_FIRST:'Сначала завершите удержание кнопкой «Токета».',INVALID_TRANSITION:'Состояние изменилось. Проверьте табло перед следующим действием.',CORRECTION_REQUIRES_REVIEW:'Это исправление требует рассмотрения судьи; процедура ещё не реализована.'})[e.message] || 'Действие недоступно: '+e.message; }
 render();
}
function format(ms) { const tenths=Math.floor(Math.max(0,ms)/100); return `${String(Math.floor(tenths/600)).padStart(2,'0')}:${String(Math.floor(tenths/10)%60).padStart(2,'0')}.${tenths%10}`; }
for(const panel of document.querySelectorAll('[data-side]')) {
 const side=panel.dataset.side;
 panel.querySelector('.scores').innerHTML=['IPPON','WAZA_ARI','YUKO'].map(k=>`<div><strong data-score="${k}">0</strong><small>${k.replace('_','-')}</small></div>`).join('');
 for(const kind of ['YUKO','WAZA_ARI','IPPON','SHIDO']) {
  const b=document.createElement('button'); b.textContent='+ '+labels[kind]; b.dataset.award=''; b.setAttribute('aria-label',`${labels[kind]} — ${side==='WHITE'?'белый':'синий'}`); b.onclick=()=>send({type:'AWARD',side,kind}); panel.querySelector('.actions').append(b);
 }
 const h=document.createElement('button'); h.textContent='Удержание'; h.dataset.hold=''; h.setAttribute('aria-label',`Удержание — ${side==='WHITE'?'белый':'синий'}`); h.onclick=()=>send({type:'HOLD',side}); panel.querySelector('.actions').append(h);
}
function render() {
 $('time').textContent=format(state.phase==='REGULAR'?rules.durationMs-state.elapsedMs:state.goldenMs);
 $('phase').textContent=state.phase==='REGULAR'?'ОСНОВНОЕ ВРЕМЯ':'GOLDEN SCORE';
 $('status').textContent=statuses[state.status];
 $('toggle').textContent=state.status==='RUNNING'?'Остановить время':state.status==='READY'?'Начать схватку':'Продолжить';
 $('toggle').disabled=!['READY','PAUSED','RUNNING'].includes(state.status)||!!state.hold;
 $('golden').hidden=state.status!=='DECISION';
 $('hold-label').textContent=state.hold?`УДЕРЖАНИЕ · ${state.hold.side==='WHITE'?'БЕЛЫЙ':'СИНИЙ'}`:'УДЕРЖАНИЕ';
 $('hold-time').textContent=state.hold?format(state.hold.elapsedMs):'—';
 $('toketa').disabled=!state.hold;
 for(const panel of document.querySelectorAll('[data-side]')) {
  const t=tally(state,panel.dataset.side);
  for(const el of panel.querySelectorAll('[data-score]')) el.textContent=t[el.dataset.score];
  panel.querySelector('.penalties').textContent='SHIDO '+ '●'.repeat(t.SHIDO)+'○'.repeat(Math.max(0,3-t.SHIDO));
  for(const b of panel.querySelectorAll('[data-award]')) b.disabled=!['RUNNING','PAUSED','DECISION'].includes(state.status);
  panel.querySelector('[data-hold]').disabled=state.status!=='RUNNING'||!!state.hold;
 }
 $('result').hidden=!state.outcome;
 if(state.outcome){ $('result-status').textContent=statuses[state.status]; $('winner').textContent='Победитель: '+names[state.outcome.winner]; $('reason').textContent=reasons[state.outcome.reason]; }
 $('confirm').hidden=state.status!=='PROVISIONAL';
 const signature=JSON.stringify([state.awards,state.status,state.phase,!!state.hold]);
 if(signature!==lastSignature) {
  lastSignature=signature; $('history').replaceChildren(); $('empty').hidden=state.awards.length>0;
  for(const a of [...state.awards].reverse()) {
   const li=document.createElement('li'), span=document.createElement('span');
   span.textContent=`${names[a.side]} · ${labels[a.kind]}${a.active?'':' · отменено'}`; li.append(span);
   if(!a.active) li.className='revoked';
   if(a.active){const b=document.createElement('button');b.textContent='Отменить';b.disabled=state.status==='CONFIRMED'||!!state.hold||state.phase==='GOLDEN';b.onclick=()=>{if(confirm(`Отменить ${labels[a.kind]}: ${names[a.side]}? Время останется остановленным.`))send({type:'REVOKE',awardId:a.id});};li.append(b);}
   $('history').append(li);
  }
 }
}
$('toggle').onclick=()=>send({type:state.status==='RUNNING'?'STOP':'START'});
$('toketa').onclick=()=>send({type:'TOKETA'});
$('golden').onclick=()=>send({type:'GOLDEN'});
$('confirm').onclick=()=>send({type:'CONFIRM'});
$('theme').onclick=()=>{$('theme').textContent=document.body.classList.toggle('light')?'Тёмная тема':'Светлая тема';};
$('view').onclick=()=>{$('view').textContent=document.body.classList.toggle('spectator')?'Вернуться к управлению':'Зрительский вид';};
$('reset').onclick=()=>{if(confirm('Начать новую демонстрацию? Текущие данные будут удалены.')){state=createMatch(rules);anchor=performance.now();$('error').textContent='';render();}};
setInterval(()=>{syncClock();render();},100);
render();
