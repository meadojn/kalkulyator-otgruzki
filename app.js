
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js'));
}
const $ = (id) => document.getElementById(id);

let inputRefs = {};
let keypadState = null;

const state = {
  shifts: 3,
  people: 4,
  bonus: 1000,
  responsibles: [0],
  names: [],
  personIds: [],
  shiftDates: [],
  earnings: [],
  lastResult: null,
  showShiftTransfers: false,
  reportTheme: 'dark',
  showShiftResult: false,
  reportIncludeShifts: true
};

function loadState() {
  try {
    const raw = localStorage.getItem('ko_state');
    if (!raw) return;
    Object.assign(state, JSON.parse(raw));
  } catch {}
}
function saveState() { localStorage.setItem('ko_state', JSON.stringify(state)); }

function fmtNum(x){ return (Math.round(x*100)/100).toFixed(2); }
function fmtMoney(x){
  const n = Math.round(Number(x)*100)/100;
  const parts = n.toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return parts.join('.') + ' ₽';
}
function cents(x){ return Math.round(x*100); }
function dec(c){ return c/100; }

function vibrate(ms){ try{ if(navigator.vibrate) navigator.vibrate(ms); }catch{} }

function clampInt(v,a,b){ const n=parseInt(v,10); if(Number.isNaN(n)) return a; return Math.max(a,Math.min(b,n)); }
function safeName(i){ const n=(state.names[i]||'').trim(); return n? n : `Человек${i+1}`; }

function ensureArrays(){
  state.shifts = clampInt(state.shifts,1,10);
  state.people = clampInt(state.people,2,12);

  while(state.names.length < state.people) state.names.push('');
  if(state.names.length > state.people) state.names = state.names.slice(0,state.people);

  if(!Array.isArray(state.personIds)) state.personIds = [];
  while(state.personIds.length < state.people) state.personIds.push('');
  if(state.personIds.length > state.people) state.personIds = state.personIds.slice(0,state.people);

  if(!Array.isArray(state.shiftDates)) state.shiftDates = [];
  while(state.shiftDates.length < state.shifts) state.shiftDates.push('');
  if(state.shiftDates.length > state.shifts) state.shiftDates = state.shiftDates.slice(0,state.shifts);

  const newE=[];
  for(let s=0;s<state.shifts;s++){
    const row=[];
    const old=state.earnings[s]||[];
    for(let p=0;p<state.people;p++) row.push(old[p] ?? '');
    newE.push(row);
  }
  state.earnings=newE;
  state.responsibles = (state.responsibles||[]).filter(i=>i>=0 && i<state.people);
  if(state.responsibles.length===0) state.responsibles=[0];
}


function downloadBlob(blob, filename){
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 1500);
}


function splitEvenCents(totalCents, participants){
  const k=participants.length;
  const base=Math.floor(totalCents/k);
  const rem=totalCents%k;
  const res=new Map();
  participants.forEach(i=>res.set(i,base));
  for(let j=0;j<rem;j++){
    const i=participants[j];
    res.set(i,res.get(i)+1);
  }
  return res;
}

function applyBonusExactDiff(targets, participants, responsible, bonusCents){
  if(bonusCents<=0) return {targets, applied:false};
  if(!participants.includes(responsible)) return {targets, applied:false};
  const k=participants.length;
  if(k<2) return {targets, applied:false};

  const subEach=Math.floor(bonusCents/k);
  const subRem=bonusCents%k;
  const t=new Map(targets);

  participants.forEach(i=>t.set(i, t.get(i)-subEach));
  for(let j=0;j<subRem;j++){
    const i=participants[j];
    t.set(i, t.get(i)-1);
  }
  t.set(responsible, t.get(responsible)+bonusCents);

  let minVal=Infinity;
  participants.forEach(i=>minVal=Math.min(minVal,t.get(i)));
  if(minVal<0) return {targets, applied:false};
  return {targets:t, applied:true};
}

function settleTransfers(names, balances){
  const payers=[], receivers=[];
  for(let i=0;i<balances.length;i++){
    const b=Math.round(balances[i]*100)/100;
    if(b < -0.0001) payers.push({idx:i, amt:-b});
    else if(b > 0.0001) receivers.push({idx:i, amt:b});
  }
  const out=[];
  let pi=0, ri=0;
  while(pi<payers.length && ri<receivers.length){
    const p=payers[pi], r=receivers[ri];
    const amt=Math.min(p.amt, r.amt);
    if(amt>0.0001) out.push({from:names[p.idx], to:names[r.idx], amount:amt});
    p.amt=Math.round((p.amt-amt)*100)/100;
    r.amt=Math.round((r.amt-amt)*100)/100;
    if(p.amt<=0.0001) pi++;
    if(r.amt<=0.0001) ri++;
  }
  return out;
}

function compute(){
  const n=state.people, m=state.shifts;
  const bonusC=cents(Number(state.bonus||0));
  const names=Array.from({length:n}, (_,i)=>safeName(i));
  const totalsBefore=Array(n).fill(0);
  const balances=Array(n).fill(0);
  const perShiftAfter=[];
  const perShiftTransfers=[];

  const earn=[];
  for(let s=0;s<m;s++){
    const row=[];
    for(let p=0;p<n;p++){
      const t=(state.earnings[s][p]||'').trim().replace(',', '.');
      row.push(t===''? null : Number(t));
      if(t!=='' && !Number.isFinite(row[p])) throw new Error(`Некорректное число (смена ${s+1}, ${names[p]})`);
    }
    earn.push(row);
  }

  for(let s=0;s<m;s++){
    const participants=[];
    let shiftTotal=0;
    for(let p=0;p<n;p++){
      const v=earn[s][p];
      if(v!=null){
        participants.push(p);
        shiftTotal += v;
        totalsBefore[p] += v;
      }
    }
    if(participants.length<2){
      const lines=participants.map(i=>({name:names[i], before:earn[s][i]??0, after:earn[s][i]??0, delta:0}));
      perShiftAfter.push({shiftIndex:s+1, shiftTotal, lines, note: participants.length===0 ? "никто не был" : "1 человек (без выравнивания)"});
      perShiftTransfers.push({shiftIndex:s+1, transfers: []});
      continue;
    }

    let targetsBase=splitEvenCents(cents(shiftTotal), participants);

    // --- Бонусы ответственных (можно несколько). Бонус одинаковый для всех.
    const respSet = new Set((state.responsibles||[]).filter(i=>participants.includes(i)));
    const respCount = respSet.size;
    if(respCount>0 && bonusC>0){
      const totalBonusC = bonusC * respCount;
      const totalC = cents(shiftTotal);
      if(totalC < totalBonusC) throw new Error(`Сумма смены меньше суммарного бонуса ответственных (смена ${s+1})`);
      targetsBase = splitEvenCents(totalC - totalBonusC, participants);
      respSet.forEach(i=>targetsBase.set(i, targetsBase.get(i) + bonusC));
    }
    let targets = targetsBase;

    let residual=0;
    const lines=participants.map(i=>{
      const before=earn[s][i]??0;
      const after=dec(targets.get(i));
      const delta=Math.round((after-before)*100)/100;
      balances[i]+=delta;
      residual += delta;
      return {name:names[i], before:Math.round(before*100)/100, after:Math.round(after*100)/100, delta};
    });
    if(Math.abs(residual)>0.0001) balances[participants[participants.length-1]] -= residual;

    // переводы ТОЛЬКО за эту смену (по дельтам этой смены)
    const shiftBalances = Array(n).fill(0);
    participants.forEach((i, idx) => {
      shiftBalances[i] = lines[idx].delta;
    });
    const shiftTransfers = settleTransfers(names, shiftBalances);
    perShiftTransfers.push({ shiftIndex: s+1, transfers: shiftTransfers });

    perShiftAfter.push({shiftIndex:s+1, shiftTotal, lines, note:""});
  }

  const grandTotal = earn.reduce((a,row)=>a+row.reduce((b,v)=>b+(v??0),0),0);

  const people = names.map((name,i)=>{
    const before=Math.round(totalsBefore[i]*100)/100;
    const after=Math.round((totalsBefore[i]+balances[i])*100)/100;
    const delta=Math.round((after-before)*100)/100;
    return {name, before, after, delta};
  });
  const transfers = settleTransfers(names, balances);
  return { names, perShiftAfter, perShiftTransfers, people, transfers, grandTotal,
 bonusPerShift:Number(state.bonus||0), responsibles:(state.responsibles||[]).map(i=>names[i]).filter(Boolean) };
}

/* UI */
function displayName(name, responsibles){
  const safe = escapeHtml(name);
  const set = new Set(responsibles||[]);
  // responsibles passed as array of names
  return set.has(name) ? (safe + ' <span class="badge" title="Ответственный">⭐</span>') : safe;
}

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[m])); }

function th(text){ const el=document.createElement('th'); el.textContent=text; return el; }

function buildNames(){
  const wrap=$('names');
  wrap.innerHTML='';
  for(let i=0;i<state.people;i++){
    const div=document.createElement('div');
    div.className='row';
    div.innerHTML = `
      <label class="grow">Имя #${i+1}<input data-name="${i}" type="text" value="${escapeHtml(state.names[i]||'')}" /></label>
      <label style="max-width:130px">ID (для скринов)<input data-pid="${i}" type="text" inputmode="numeric" placeholder="напр. 1305748" value="${escapeHtml(state.personIds[i]||'')}" /></label>
    `;
    wrap.appendChild(div);
  }
  wrap.querySelectorAll('input[data-name]').forEach(inp=>{
    inp.addEventListener('input', (e)=>{
      const idx=Number(e.target.dataset.name);
      state.names[idx]=e.target.value;
      buildResponsibles();
      buildTable();
      saveState();
    });
  });
  wrap.querySelectorAll('input[data-pid]').forEach(inp=>{
    inp.addEventListener('input', (e)=>{
      const idx=Number(e.target.dataset.pid);
      state.personIds[idx]=e.target.value.replace(/\s+/g,'');
      saveState();
    });
  });
}


function buildResponsibles(){
  const wrap = $('responsibles');
  if(!wrap) return;
  wrap.innerHTML = '';
  const chosen = new Set(state.responsibles||[]);
  for(let i=0;i<state.people;i++){
    const chip = document.createElement('label');
    chip.className = 'chip';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = chosen.has(i);
    cb.dataset.idx = String(i);
    const span = document.createElement('span');
    span.textContent = safeName(i);
    chip.appendChild(cb);
    chip.appendChild(span);
    wrap.appendChild(chip);
  }
  wrap.querySelectorAll('input[type="checkbox"][data-idx]').forEach(cb=>{
    cb.addEventListener('change', e=>{
      const i = Number(e.target.dataset.idx);
      const set = new Set(state.responsibles||[]);
      if(e.target.checked) set.add(i); else set.delete(i);
      state.responsibles = Array.from(set).sort((a,b)=>a-b);
      if(state.responsibles.length===0){ state.responsibles=[0]; buildResponsibles(); }
      saveState();
    });
  });
}


function buildTable(){
  const wrap = $('earningsCards');
  const tbl = $('earningsTable');
  if(tbl) tbl.innerHTML=''; // legacy safety
  if(!wrap) return;

  const names = Array.from({length:state.people}, (_,i)=>safeName(i));
  const respSet = new Set(state.responsibles||[]);
  inputRefs = {};

  wrap.innerHTML = '';
  for(let s=0; s<state.shifts; s++){
    const card = document.createElement('div');
    card.className = 'shiftCard';

    const head = document.createElement('div');
    head.className = 'shiftCardHeader';
    head.innerHTML = `
      <div class="shiftCardTitle">Смена ${s+1}</div>
      <label class="shiftDateLabel">Дата
        <input type="date" class="shiftDateInput" data-shift-date="${s}" value="${escapeHtml(state.shiftDates[s]||'')}" />
      </label>
    `;
    card.appendChild(head);
    head.querySelector('.shiftDateInput').addEventListener('change', (e)=>{
      state.shiftDates[s] = e.target.value;
      saveState();
    });

    const actions = document.createElement('div');
    actions.className = 'shiftCardActions';
    const fillBtn = document.createElement('button');
    fillBtn.type = 'button';
    fillBtn.className = 'btn secondary';
    fillBtn.textContent = 'Заполнить всем одинаково';
    fillBtn.addEventListener('click', ()=> openKeypad({ mode:'fillAll', shift:s }));
    actions.appendChild(fillBtn);
    if(s>0){
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn secondary';
      copyBtn.textContent = 'Скопировать с прошлой смены';
      copyBtn.addEventListener('click', ()=>{
        state.earnings[s] = state.earnings[s-1].map(v=>v);
        saveState();
        buildTable();
        vibrate(8);
      });
      actions.appendChild(copyBtn);
    }
    card.appendChild(actions);

    const hint = document.createElement('div');
    hint.className = 'small';
    hint.style.marginBottom = '10px';
    hint.textContent = 'Пусто = человек не был в смене';
    card.appendChild(hint);

    const rows = document.createElement('div');
    rows.className = 'shiftRows';

    for(let p=0; p<state.people; p++){
      const row = document.createElement('div');
      row.className = 'shiftRow' + (respSet.has(p) ? ' resp' : '');
      const nameHtml = respSet.has(p) ? `${escapeHtml(names[p])} <span class="badge" title="Ответственный">⭐</span>` : escapeHtml(names[p]);

      const top = document.createElement('div');
      top.className = 'shiftRowTop';
      top.innerHTML = `<div class="shiftRowName">${nameHtml}</div>`;

      const inp = document.createElement('input');
      inp.type = 'text';
      inp.inputMode = 'none';   // системная клавиатура не открывается — работает наша
      inp.readOnly = true;
      inp.value = state.earnings[s][p] ?? '';
      inp.placeholder = '—';
      inp.dataset.shift = String(s);
      inp.dataset.person = String(p);
      inp.dataset.rowEl = '';
      inp.addEventListener('click', ()=> openKeypad({ mode:'field', shift:s, person:p }));
      top.appendChild(inp);
      row.appendChild(top);

      inputRefs[`${s}_${p}`] = { input: inp, row };
      rows.appendChild(row);
    }

    card.appendChild(rows);
    wrap.appendChild(card);
  }
}

/* ---- Кастомная цифровая клавиатура ---- */
function fmtBufferDisplay(buf){
  if(buf==='' || buf==null) return '—';
  return buf.replace('.', ',') + ' ₽';
}

function flattenOrder(){
  const order = [];
  for(let s=0;s<state.shifts;s++) for(let p=0;p<state.people;p++) order.push([s,p]);
  return order;
}

function openKeypad(opts){
  keypadState = { mode: opts.mode, shift: opts.shift, person: opts.person, buffer: '' };

  document.querySelectorAll('.shiftRow.editing').forEach(r=>r.classList.remove('editing'));

  const labelEl = document.querySelector('.keypadTargetLabel');
  if(opts.mode==='field'){
    const cur = state.earnings[opts.shift][opts.person];
    keypadState.buffer = (cur==null?'':String(cur)).replace(',', '.');
    const ref = inputRefs[`${opts.shift}_${opts.person}`];
    if(ref){ ref.row.classList.add('editing'); ref.row.scrollIntoView({block:'center', behavior:'smooth'}); }
    if(labelEl) labelEl.textContent = `Смена ${opts.shift+1} · ${safeName(opts.person)}`;
  } else if(opts.mode==='fillAll'){
    if(labelEl) labelEl.textContent = `Смена ${opts.shift+1} · всем одинаково`;
  }

  updateKeypadDisplay();
  $('keypadBackdrop').classList.remove('hidden');
  $('keypad').classList.remove('hidden');
}

function updateKeypadDisplay(){
  if(!keypadState) return;
  const t = $('keypadTarget');
  if(t) t.textContent = fmtBufferDisplay(keypadState.buffer);
  if(keypadState.mode==='field'){
    const ref = inputRefs[`${keypadState.shift}_${keypadState.person}`];
    if(ref) ref.input.value = keypadState.buffer.replace('.', ',');
  }
}

function closeKeypad(){
  const bd = $('keypadBackdrop'), kp = $('keypad');
  if(bd) bd.classList.add('hidden');
  if(kp) kp.classList.add('hidden');
  document.querySelectorAll('.shiftRow.editing').forEach(r=>r.classList.remove('editing'));
  keypadState = null;
}

function commitKeypad(advance){
  if(!keypadState) return;
  if(keypadState.mode==='field'){
    state.earnings[keypadState.shift][keypadState.person] = keypadState.buffer;
    saveState();
    if(advance){
      const order = flattenOrder();
      const idx = order.findIndex(([s,p])=> s===keypadState.shift && p===keypadState.person);
      if(idx>=0 && idx+1<order.length){
        const [ns,np] = order[idx+1];
        openKeypad({ mode:'field', shift:ns, person:np });
        return;
      }
    }
    closeKeypad();
  } else if(keypadState.mode==='fillAll'){
    const s = keypadState.shift;
    for(let p=0;p<state.people;p++) state.earnings[s][p] = keypadState.buffer;
    saveState();
    buildTable();
    closeKeypad();
  }
}

function bindKeypad(){
  document.querySelectorAll('.keypadGrid button[data-key]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(!keypadState) return;
      const key = btn.dataset.key;
      if(key==='back'){
        keypadState.buffer = keypadState.buffer.slice(0,-1);
      } else if(key===','){
        if(!keypadState.buffer.includes('.')) keypadState.buffer += (keypadState.buffer===''?'0.':'.');
      } else {
        const parts = keypadState.buffer.split('.');
        if(parts[1] && parts[1].length>=2) return; // не больше 2 знаков после запятой
        if(keypadState.buffer==='0') keypadState.buffer = key;
        else keypadState.buffer += key;
      }
      updateKeypadDisplay();
      vibrate(4);
    });
  });

  document.querySelectorAll('#keypad .quickBtn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(!keypadState) return;
      const amt = btn.dataset.qamt;
      if(amt==='clear'){
        keypadState.buffer='';
      } else {
        const cur = parseFloat(keypadState.buffer||'0') || 0;
        keypadState.buffer = String(cur + Number(amt));
      }
      updateKeypadDisplay();
      vibrate(8);
    });
  });

  const doneBtn = $('keypadDone');
  if(doneBtn) doneBtn.addEventListener('click', ()=>{ vibrate(8); commitKeypad(true); });

  const backdrop = $('keypadBackdrop');
  if(backdrop) backdrop.addEventListener('click', ()=> commitKeypad(false));
}



function showError(msg){
  const e=$('error');
  e.hidden = !msg;
  e.textContent = msg || '';
}

function setTab(tab){
  const current = document.querySelector('.screen.active');
  const next = $('screen-'+tab);
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  if(current === next) return;

  if(current){
    current.classList.remove('enter');
    current.classList.add('exit');
    setTimeout(()=>{
      current.classList.remove('active','exit');
      next.classList.add('active','enter');
      // animate cards in next screen
      const cards = Array.from(next.querySelectorAll('.card'));
      cards.forEach((c,i)=>{
        c.classList.remove('pop');
        setTimeout(()=>c.classList.add('pop'), 40*i);
      });
      setTimeout(()=>next.classList.remove('enter'), 260);
    }, 160);
  }else{
    next.classList.add('active','enter');
    const cards = Array.from(next.querySelectorAll('.card'));
    cards.forEach((c,i)=> setTimeout(()=>c.classList.add('pop'), 40*i));
    setTimeout(()=>next.classList.remove('enter'), 260);
  }
}


document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click', ()=>{
  const t = btn.dataset.tab;
  vibrate(6);
  setTab(t);
  if(state.lastResult){
    if(t==='result' || t==='transfers') { renderResult(state.lastResult); }  }
}));




function renderResult(res){
  const sticky = $('stickySummary');
  if(sticky){
    if(res && Array.isArray(res.people)){
      sticky.classList.remove('hidden');
      const peopleCount = res.people.length;
      sticky.innerHTML = `
        <div>
          <div class="ssLabel">Итого по всем сменам</div>
          <div class="ssAmount">${fmtMoney(res.grandTotal||0)}</div>
        </div>
        <div class="ssMeta">${peopleCount} ${peopleCount===1?'участник':'участников'}</div>
      `;
    } else {
      sticky.classList.add('hidden');
      sticky.innerHTML='';
    }
  }
  const tgl = $('toggleShiftResult');
  if(tgl) tgl.checked = !!state.showShiftResult;
  const wrap=$('perShiftAfter');
  if(wrap){
    wrap.classList.toggle('show', !!state.showShiftResult);
    wrap.innerHTML='';
    if(state.showShiftResult){
      res.perShiftAfter.forEach(block=>{
    const card=document.createElement('div');
    card.className='card';
    card.innerHTML = `
      <div class="row space">
        <div><strong>Смена ${block.shiftIndex}</strong> <span class="badge">сумма: ${fmtMoney(block.shiftTotal)}</span></div>
        ${block.note ? `<span class="small">${escapeHtml(block.note)}</span>` : ``}
      </div>
      <div class="small">После выравнивания (до → после → разница)</div>
    `;
    const list=document.createElement('div');
    block.lines.forEach(ln=>{
      const row=document.createElement('div');
      row.className='row space';
      const cls = (ln.delta>=0)?'good':'bad';
      row.innerHTML = `
        <div class="resName">${displayName(ln.name, res.responsibles)}</div>
        <div class="resRight">
          <span class="resArrow">${fmtMoney(ln.before)} → ${fmtMoney(ln.after)}</span>
          <span class="badge ${cls} mono">${ln.delta>=0?'+':''}${fmtMoney(ln.delta)}</span>
        </div>`;
      list.appendChild(row);
    });
    card.appendChild(list);
    wrap.appendChild(card);
      });
    }
  }

  const overall=$('overall');
  overall.innerHTML = `
    <div class="row">
      <span class="badge">Ответственные: ${escapeHtml(Array.isArray(res.responsibles)?res.responsibles.join(', '):res.responsibles)}</span>
      <span class="badge">Бонус/смена: ${fmtMoney(res.bonusPerShift)}</span>
      <span class="badge">Общая сумма: ${fmtMoney(res.grandTotal)}</span>
    </div>
    <div style="margin-top:10px"></div>
  `;
  res.people.forEach(p=>{
    const row=document.createElement('div');
    row.className='resRow';
    const cls = (p.delta>=0)?'good':'bad';
    row.innerHTML = `
        <div class="resName">${displayName(p.name, res.responsibles)}</div>
        <div class="resRight">
          <span class="resArrow">${fmtMoney(p.before)} → ${fmtMoney(p.after)}</span>
          <span class="badge ${cls} mono">${p.delta>=0?'+':''}${fmtMoney(p.delta)}</span>
        </div>`;
    overall.appendChild(row);
  });

  // переводы за каждую смену (по желанию)
  const pst = $('perShiftTransfers');
  if(pst){
    pst.classList.toggle('show', !!state.showShiftTransfers);
    pst.innerHTML = '';
    if(state.showShiftTransfers){
      pst.innerHTML = '<h3 style="margin:0 0 10px 0">Переводы по сменам</h3>';
      if (res.perShiftTransfers && res.perShiftTransfers.length) {
        res.perShiftTransfers.forEach(block => {
          const card = document.createElement('div');
          card.className = 'card';
          card.innerHTML = `<div class="row space"><strong>Смена ${block.shiftIndex}</strong><span class="badge">переводы за смену</span></div>`;
          const body = document.createElement('div');

          if (!block.transfers || !block.transfers.length) {
            const p = document.createElement('div');
            p.className = 'small';
            p.textContent = 'Переводы не нужны.';
            body.appendChild(p);
          } else {
            block.transfers.forEach(t => {
              const row = document.createElement('div');
              row.className = 'row space';
              row.innerHTML = `<div>${displayName(t.from, res.responsibles)} → ${displayName(t.to, res.responsibles)}</div><div class="amount mono">${fmtMoney(t.amount)}</div>`;
              body.appendChild(row);
            });
          }

          card.appendChild(body);
          pst.appendChild(card);
        });
      } else {
        pst.innerHTML += '<div class="small">Нет данных по переводам за смены (нажми «Посчитать»).</div>';
      }
    }
  }

  const tWrap=$('transfers');
  tWrap.innerHTML='';
  if(!res.transfers.length) tWrap.textContent='Переводы не нужны.';
  else res.transfers.forEach(t=>{
    const row=document.createElement('div');
    row.className='row space';
    row.innerHTML=`<div>${displayName(t.from, res.responsibles)} → ${displayName(t.to, res.responsibles)}</div><div class="amount mono">${fmtMoney(t.amount)}</div>`;
    tWrap.appendChild(row);
  });
}

function buildCopyText(res){
  let out='';
  out += `Ответственные: ${res.responsibles}\n`;
  out += `Бонус/смена: ${fmtMoney(res.bonusPerShift)}\n`;
  out += `Общая сумма: ${fmtMoney(res.grandTotal)}\n\n`;
  out += `ИТОГО ПО СМЕНАМ (после выравнивания):\n`;
  res.perShiftAfter.forEach(b=>{
    out += `Смена ${b.shiftIndex} (сумма ${fmt(b.shiftTotal)}):\n`;
    b.lines.forEach(ln=> out += `- ${ln.name}: ${fmtMoney(ln.before)} -> ${fmtMoney(ln.after)} \n`);
    out += `\n`;
  });
  out += `ОБЩИЙ ИТОГ:\n`;
  res.people.forEach(p=> out += `- ${p.name}: ${fmtMoney(p.before)} -> ${fmtMoney(p.after)} \n`);
  return out.trim();
}
function buildTransfersText(res){
  let out='Переводы:\n';
  if(!res.transfers.length) return out + '- Переводы не нужны.';
  res.transfers.forEach(t=> out += `- ${t.from} -> ${t.to}: ${fmtMoney(t.amount)}\n`);
  return out.trim();
}

function toast(msg){
  const el=document.createElement('div');
  el.textContent=msg;
  el.style.position='fixed';
  el.style.left='50%';
  el.style.bottom='78px';
  el.style.transform='translateX(-50%)';
  el.style.background='rgba(0,0,0,.8)';
  el.style.color='white';
  el.style.padding='10px 12px';
  el.style.borderRadius='12px';
  el.style.zIndex='9999';
  document.body.appendChild(el);
  setTimeout(()=>el.remove(), 900);
}

/* Bind */
/* ---- Резервная копия: экспорт/импорт состояния ---- */
function exportPayload(){
  // Экспортируем весь state как есть — все данные приложения и так лежат в одном объекте.
  return JSON.stringify(state, null, 2);
}

function applyImportedState(raw){
  let obj;
  try{ obj = JSON.parse(raw); }
  catch{ throw new Error('Это не похоже на корректный JSON.'); }
  if(!obj || typeof obj!=='object' || Array.isArray(obj)) throw new Error('Некорректный формат резервной копии.');
  if(typeof obj.shifts==='undefined' || typeof obj.people==='undefined'){
    throw new Error('В файле нет данных калькулятора.');
  }
  Object.assign(state, obj);
  ensureArrays();
  saveState();
  $('shifts').value = state.shifts;
  $('people').value = state.people;
  $('bonus').value = state.bonus;
  buildNames();
  buildResponsibles();
  buildTable();
  if(state.lastResult) renderResult(state.lastResult);
}

function bindBackup(){
  const status = $('backupStatus');
  const setStatus = (msg)=>{ if(status) status.textContent = msg; };

  const btnExportFile = $('btnExportFile');
  if(btnExportFile) btnExportFile.addEventListener('click', ()=>{
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const blob = new Blob([exportPayload()], {type:'application/json'});
    downloadBlob(blob, `kalkulyator-otgruzki-backup-${stamp}.json`);
    setStatus('Файл сохранён.');
    vibrate(8);
  });

  const btnExportCopy = $('btnExportCopy');
  if(btnExportCopy) btnExportCopy.addEventListener('click', async ()=>{
    try{
      await navigator.clipboard.writeText(exportPayload());
      setStatus('Скопировано в буфер обмена.');
      vibrate(8);
    }catch{
      setStatus('Не удалось скопировать — попробуй скачать файл.');
    }
  });

  const fileInput = $('importFileInput');
  const btnImportFile = $('btnImportFile');
  if(btnImportFile && fileInput){
    btnImportFile.addEventListener('click', ()=> fileInput.click());
    fileInput.addEventListener('change', async ()=>{
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if(!file) return;
      if(!confirm('Импорт заменит текущие настройки в этом браузере. Продолжить?')) return;
      try{
        const text = await file.text();
        applyImportedState(text);
        setStatus('Импортировано из файла.');
        vibrate([10,40,10]);
      }catch(e){
        setStatus('Ошибка импорта: ' + (e.message||String(e)));
      }
    });
  }

  const btnImportPaste = $('btnImportPaste');
  if(btnImportPaste) btnImportPaste.addEventListener('click', ()=>{
    const text = prompt('Вставь текст резервной копии:');
    if(!text) return;
    if(!confirm('Импорт заменит текущие настройки в этом браузере. Продолжить?')) return;
    try{
      applyImportedState(text);
      setStatus('Импортировано из текста.');
      vibrate([10,40,10]);
    }catch(e){
      setStatus('Ошибка импорта: ' + (e.message||String(e)));
    }
  });
}

/* ---- OCR-импорт скринов выработки ---- */
let ocrWorker = null;
let ocrResults = [];

function loadTesseract(){
  if(window.Tesseract) return Promise.resolve();
  return new Promise((resolve, reject)=>{
    const s = document.createElement('script');
    // Внимание: у меня в песочнице нет сети, поэтому эту загрузку и версию
    // библиотеки я не смог протестировать вживую — если Tesseract сменит
    // формат API в новой версии, возможно потребуется поправить вызовы ниже.
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Не удалось загрузить библиотеку распознавания (нужен интернет).'));
    document.head.appendChild(s);
  });
}

async function getOcrWorker(){
  if(ocrWorker) return ocrWorker;
  await loadTesseract();
  // Скрины содержат кириллицу ("id", "Дата", "Сумма оказанных услуг" и т.д.).
  // С воркером только на 'eng' Tesseract вообще не распознаёт кириллические
  // строки (они просто выпадают из результата), из-за чего "id" и "Сумма"
  // не находятся регулярками ниже. Нужны обе модели: rus — для кириллицы,
  // eng — для служебных латинских слов вроде "id".
  ocrWorker = await Tesseract.createWorker('rus+eng');
  return ocrWorker;
}

function parseOcrText(text){
  // ID: "id: 1 305 748" — латиница, группы цифр через пробел/неразрывный пробел
  const idMatch = text.match(/id\s*[:;]?\s*([\d][\d\s\u00A0\u202F]{2,12}\d)/i);
  const id = idMatch ? idMatch[1].replace(/\D/g,'') : null;

  // Дата: строго формат ДД.ММ.ГГГГ (только у "Дата" в деталях, а не у надписи сверху словом)
  const dateMatch = text.match(/(\d{2})[.\/](\d{2})[.\/](20\d{2})/);
  const dateISO = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : null;

  // Сумма: предпочитаем со знаком "+", иначе любое число вида 1 234.56
  let amtMatch = text.match(/\+\s*([\d][\d\s\u00A0\u202F]{0,9}[.,]\d{2})/);
  if(!amtMatch) amtMatch = text.match(/([\d][\d\s\u00A0\u202F]{0,9}[.,]\d{2})/);
  let amount = null;
  if(amtMatch){
    const digits = amtMatch[1].replace(/[^\d.,]/g,'').replace(',', '.');
    const n = parseFloat(digits);
    if(Number.isFinite(n)) amount = n;
  }

  return { id, dateISO, amount };
}

function findPersonByOcrId(id){
  if(!id) return -1;
  return (state.personIds||[]).findIndex(pid => pid && pid.replace(/\D/g,'') === id);
}
function findShiftByDate(dateISO){
  if(!dateISO) return -1;
  return (state.shiftDates||[]).findIndex(d => d === dateISO);
}

function renderOcrReview(){
  const list = $('ocrReviewList');
  list.innerHTML = '';
  ocrResults.forEach((r, idx)=>{
    const item = document.createElement('div');
    const matched = r.personIdx>=0 && r.shiftIdx>=0 && r.amount!=null;
    item.className = 'ocrItem ' + (matched ? 'matched' : 'needsAttention');

    const personOptions = Array.from({length:state.people}, (_,i)=>
      `<option value="${i}" ${i===r.personIdx?'selected':''}>${escapeHtml(safeName(i))}</option>`
    ).join('') + `<option value="-1" ${r.personIdx<0?'selected':''}>— не выбрано —</option>`;

    const shiftOptions = Array.from({length:state.shifts}, (_,i)=>
      `<option value="${i}" ${i===r.shiftIdx?'selected':''}>Смена ${i+1}${state.shiftDates[i]?' ('+state.shiftDates[i]+')':''}</option>`
    ).join('') + `<option value="-1" ${r.shiftIdx<0?'selected':''}>— не выбрано —</option>`;

    item.innerHTML = `
      <div class="ocrItemRow">
        <span class="ocrItemStatus ${matched?'ok':'warn'}">${matched?'✓ Распознано':'⚠ Проверь вручную'}</span>
      </div>
      <div class="ocrItemRow">
        <span class="ocrItemLabel">Файл</span>
        <span class="small">${escapeHtml(r.filename)}</span>
      </div>
      <div class="ocrItemRow">
        <span class="ocrItemLabel">Человек</span>
        <select data-field="person" data-idx="${idx}">${personOptions}</select>
      </div>
      <div class="ocrItemRow">
        <span class="ocrItemLabel">Смена</span>
        <select data-field="shift" data-idx="${idx}">${shiftOptions}</select>
      </div>
      <div class="ocrItemRow">
        <span class="ocrItemLabel">Сумма</span>
        <input type="text" inputmode="decimal" data-field="amount" data-idx="${idx}" value="${r.amount!=null?String(r.amount):''}" placeholder="не распознано" />
      </div>
    `;
    list.appendChild(item);
  });

  list.querySelectorAll('select[data-field="person"]').forEach(sel=>{
    sel.addEventListener('change', e=>{
      ocrResults[Number(e.target.dataset.idx)].personIdx = Number(e.target.value);
      renderOcrReview();
    });
  });
  list.querySelectorAll('select[data-field="shift"]').forEach(sel=>{
    sel.addEventListener('change', e=>{
      ocrResults[Number(e.target.dataset.idx)].shiftIdx = Number(e.target.value);
      renderOcrReview();
    });
  });
  list.querySelectorAll('input[data-field="amount"]').forEach(inp=>{
    inp.addEventListener('input', e=>{
      const v = e.target.value.replace(',', '.');
      const n = parseFloat(v);
      ocrResults[Number(e.target.dataset.idx)].amount = Number.isFinite(n) ? n : null;
    });
  });

  $('ocrReviewBackdrop').classList.remove('hidden');
  $('ocrReviewPanel').classList.remove('hidden');
}

function closeOcrReview(){
  $('ocrReviewBackdrop').classList.add('hidden');
  $('ocrReviewPanel').classList.add('hidden');
  ocrResults = [];
}

function bindOcrImport(){
  const btn = $('btnImportScreens');
  const fileInput = $('screensFileInput');
  const status = $('ocrStatus');
  if(!btn || !fileInput) return;

  btn.addEventListener('click', ()=> fileInput.click());

  fileInput.addEventListener('change', async ()=>{
    const files = Array.from(fileInput.files || []);
    fileInput.value = '';
    if(!files.length) return;

    btn.disabled = true;
    ocrResults = [];
    try{
      status.textContent = 'Загружаю модуль распознавания…';
      const worker = await getOcrWorker();

      for(let i=0;i<files.length;i++){
        status.textContent = `Распознаю ${i+1} из ${files.length}…`;
        const { data:{ text } } = await worker.recognize(files[i]);
        const { id, dateISO, amount } = parseOcrText(text);
        ocrResults.push({
          filename: files[i].name,
          id, dateISO, amount,
          personIdx: findPersonByOcrId(id),
          shiftIdx: findShiftByDate(dateISO)
        });
      }
      status.textContent = `Готово: ${files.length} скрин(ов). Проверь и подтверди.`;
      vibrate([10,40,10]);
      renderOcrReview();
    }catch(e){
      status.textContent = 'Ошибка: ' + (e.message || String(e));
    }finally{
      btn.disabled = false;
    }
  });

  $('btnOcrClose').addEventListener('click', closeOcrReview);
  $('ocrReviewBackdrop').addEventListener('click', closeOcrReview);

  $('btnOcrApply').addEventListener('click', ()=>{
    let applied = 0, skipped = 0;
    ocrResults.forEach(r=>{
      if(r.personIdx>=0 && r.shiftIdx>=0 && r.amount!=null){
        state.earnings[r.shiftIdx][r.personIdx] = String(r.amount);
        applied++;
      } else {
        skipped++;
      }
    });
    saveState();
    buildTable();
    closeOcrReview();
    vibrate([10,40,10]);
    if(status) status.textContent = `Применено: ${applied}. Пропущено (не выбран человек/смена/сумма): ${skipped}.`;
  });
}

function bind(){
  $('shifts').addEventListener('change', e=>{ state.shifts=e.target.value; ensureArrays(); buildNames(); buildResponsibles(); buildTable(); saveState(); });
  $('people').addEventListener('change', e=>{ state.people=e.target.value; ensureArrays(); buildNames(); buildResponsibles(); buildTable(); saveState(); });
  $('bonus').addEventListener('input', e=>{ state.bonus=e.target.value; saveState(); });

  $('btnResize').addEventListener('click', ()=>{ ensureArrays(); buildNames(); buildResponsibles(); buildTable(); showError(''); saveState(); });
  $('btnClear').addEventListener('click', ()=>{ state.earnings=Array.from({length:state.shifts}, ()=>Array.from({length:state.people}, ()=>'')); buildTable(); state.lastResult=null; saveState(); });

  $('btnCompute').addEventListener('click', async ()=>{
    try{
      showError('');
      const btn = $('btnCompute');
      btn.disabled = true;
      const oldText = btn.textContent;
      btn.textContent = 'Считаю…';
      await new Promise(r=>setTimeout(r, 10));
      const res=compute();
      state.lastResult=res;
      saveState();
      renderResult(res);
      setTab('result');
      vibrate([10,40,10]);
      btn.disabled = false;
      btn.textContent = 'Посчитать';
    }catch(err){
      showError(err.message || String(err));
      setTab('shifts');
      const btn = $('btnCompute');
      btn.disabled = false;
      btn.textContent = 'Посчитать';
    }
  });

  $('btnCopyResult').addEventListener('click', async ()=>{
    if(!state.lastResult) return;
    await navigator.clipboard.writeText(buildCopyText(state.lastResult));
    toast('Скопировано');
  });
  $('btnCopyTransfers').addEventListener('click', async ()=>{
    if(!state.lastResult) return;
    await navigator.clipboard.writeText(buildTransfersText(state.lastResult));
    toast('Скопировано');
  });

  
  const toggleShift = $('toggleShiftTransfers');
  if(toggleShift){
    toggleShift.checked = !!state.showShiftTransfers;
    toggleShift.addEventListener('change', ()=>{
      state.showShiftTransfers = !!toggleShift.checked;
      saveState();
      if(state.lastResult) renderResult(state.lastResult);
    });
  }

function buildReportData(res){
  const now = new Date();
  const pad = (n)=>String(n).padStart(2,'0');
  const dateStr = `${pad(now.getDate())}.${pad(now.getMonth()+1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const respNames = Array.isArray(res.responsibles) ? res.responsibles : [];
  const respSet = new Set(respNames);

  // counts per shift (match calculation) + unique participants by names
  const counts = [];
  const unique = new Set();
  const psRaw = Array.isArray(res.perShiftAfter) ? res.perShiftAfter : [];
  for(let s=0; s<state.shifts; s++){
    const blk = psRaw.find(b=>Number(b.shiftIndex)===s+1) || psRaw[s];
    const lines = (blk && Array.isArray(blk.lines)) ? blk.lines : [];
    counts.push(lines.length);
    lines.forEach(l=>{ if(l && l.name) unique.add(String(l.name)); });
  }
  const same = counts.length ? counts.every(x=>x===counts[0]) : true;
  const headerCounts = { same, counts, totalUnique: unique.size };

  const perShift = psRaw.map(ps => ({
    shiftIndex: ps.shiftIndex,
    lines: (ps.lines||[]).map(ln => ({
      name: ln.name,
      before: Number(ln.before ?? 0),
      after: Number(ln.after ?? 0),
      delta: Number(ln.delta ?? (Number(ln.after ?? 0)-Number(ln.before ?? 0))),
      isResponsible: respSet.has(ln.name)
    }))
  }));

  const overall = (Array.isArray(res.people) ? res.people : []).map(p => ({
    name: p.name,
    before: Number(p.before ?? 0),
    after: Number(p.after ?? 0),
    delta: Number(p.delta ?? (Number(p.after ?? 0)-Number(p.before ?? 0))),
    isResponsible: respSet.has(p.name)
  }));

  const totalBefore = overall.reduce((a,x)=>a+Number(x.before||0),0);
  const totalAfter  = overall.reduce((a,x)=>a+Number(x.after||0),0);

  const transfers = Array.isArray(res.transfers) ? res.transfers.map(t=>({
    from: t.from, to: t.to, amount: Number(t.amount||0)
  })) : [];

  return { dateStr, headerCounts, perShift, overall, transfers, totalBefore, totalAfter };
}




function fitText(ctx, text, maxWidth){
  if(ctx.measureText(text).width <= maxWidth) return text;
  const ell='…';
  let t=text;
  while(t.length>1 && ctx.measureText(t+ell).width>maxWidth){ t=t.slice(0,-1); }
  return t+ell;
}


async function renderReportSummaryToPng(theme){
  if(!state.lastResult) throw new Error('Сначала нажми «Посчитать».');
  const data = buildReportData(state.lastResult);

  const W = 1080;
  const margin = 56;
  const colors = (theme==='light') ? {
    bg:'#EDE6D3', card:'#FBF7EC', text:'#221D16', muted:'#6b6151', border:'rgba(34,29,22,.18)', accent:'#B23A2E'
  } : {
    bg:'#0c0a08', card:'#1b1712', text:'#F3EFE4', muted:'rgba(243,239,228,.68)', border:'rgba(243,239,228,.14)', accent:'#FFC72C'
  };

  const rowH = 54;
  const headH = 210;

  const perShift = []; // summary has no shift cards
  const ovLines = data.overall || [];
  const tr = data.transfers || [];

  const ovH = 130 + ovLines.length*rowH;
  const trH = 120 + Math.max(1,tr.length)*44;

  const H = margin*2 + headH + 18 + ovH + 18 + trH + 90;

  const canvas=document.createElement('canvas');
  canvas.width=W; canvas.height=H;
  const ctx=canvas.getContext('2d');

  ctx.fillStyle=colors.bg; ctx.fillRect(0,0,W,H);

  let y=margin;
  // Header
  ctx.fillStyle=colors.card; roundRect(ctx, margin, y, W-margin*2, headH, 22); ctx.fill();
  ctx.strokeStyle=colors.border; ctx.lineWidth=2; ctx.stroke();

  ctx.textAlign='left';
  ctx.fillStyle=colors.text; ctx.font='700 44px system-ui, -apple-system, Segoe UI, Roboto, Arial';
  ctx.fillText('Отчёт по сменам', margin+32, y+70);

  ctx.font='400 28px system-ui, -apple-system, Segoe UI, Roboto, Arial';
  ctx.fillStyle=colors.muted;
  ctx.fillText(`Дата: ${data.dateStr}`, margin+32, y+115);
  ctx.fillText(`Смен: ${state.shifts}`, margin+32, y+150);

  const hc = data.headerCounts;
  if(hc.same){
    ctx.fillText(`Участников: ${hc.totalUnique}`, margin+32, y+185);
  }else{
    ctx.fillText(`Участники: менялись (всего ${hc.totalUnique})`, margin+32, y+185);
    ctx.textAlign='right';
    ctx.fillText(hc.counts.map((c,i)=>`Смена ${i+1}: ${c}`).join('   '), W-margin-32, y+150);
    ctx.textAlign='left';
  }
  y += headH + 18;

  // Overall
  ctx.fillStyle=colors.card; roundRect(ctx, margin, y, W-margin*2, ovH, 22); ctx.fill();
  ctx.strokeStyle=colors.border; ctx.lineWidth=2; ctx.stroke();
  ctx.fillStyle=colors.text; ctx.font='700 34px system-ui, -apple-system, Segoe UI, Roboto, Arial';
  ctx.fillText('Итого', margin+32, y+56);

  let oy=y+92;
  ovLines.forEach(l=>{
    const isResp=!!l.isResponsible;
    ctx.textAlign='left';
    ctx.font=isResp?'700 30px system-ui, -apple-system, Segoe UI, Roboto, Arial':'600 30px system-ui, -apple-system, Segoe UI, Roboto, Arial';
    ctx.fillStyle=colors.text;
    ctx.fillText(isResp?`${l.name} ⭐`:l.name, margin+32, oy);

    ctx.textAlign='right';
    ctx.font='700 28px system-ui, -apple-system, Segoe UI, Roboto, Arial';
    ctx.fillStyle=colors.text;
    ctx.fillText(`${fmtMoney(l.before)} → ${fmtMoney(l.after)} (${l.delta>=0?'+':''}${fmtMoney(l.delta)})`, W-margin-32, oy);

    ctx.strokeStyle=colors.border; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(margin+24, oy+24); ctx.lineTo(W-margin-24, oy+24); ctx.stroke();
    oy += rowH;
  });
  y += ovH + 18;

  // Transfers
  ctx.fillStyle=colors.card; roundRect(ctx, margin, y, W-margin*2, trH, 22); ctx.fill();
  ctx.strokeStyle=colors.border; ctx.lineWidth=2; ctx.stroke();
  ctx.textAlign='left';
  ctx.fillStyle=colors.text; ctx.font='700 34px system-ui, -apple-system, Segoe UI, Roboto, Arial';
  ctx.fillText('Переводы (итог)', margin+32, y+56);

  let ty=y+92;
  if(!tr.length){
    ctx.fillStyle=colors.muted; ctx.font='500 28px system-ui, -apple-system, Segoe UI, Roboto, Arial';
    ctx.fillText('Переводы не нужны.', margin+32, ty);
  }else{
    tr.forEach(t=>{
      ctx.textAlign='left';
      ctx.font='600 30px system-ui, -apple-system, Segoe UI, Roboto, Arial';
      ctx.fillStyle=colors.text;
      const left=`${t.from} → ${t.to}`;
      const maxLeft=(W-margin*2)-32-220;
      ctx.fillText(fitText(ctx,left,maxLeft), margin+32, ty);

      ctx.textAlign='right';
      ctx.font='700 30px system-ui, -apple-system, Segoe UI, Roboto, Arial';
      ctx.fillText(fmtMoney(Number(t.amount||0)), W-margin-32, ty);

      ctx.strokeStyle=colors.border;
      ctx.beginPath(); ctx.moveTo(margin+24, ty+14); ctx.lineTo(W-margin-24, ty+14); ctx.stroke();
      ty += 44;
    });
  }
  y += trH;

  ctx.textAlign='left';
  ctx.fillStyle=colors.muted; ctx.font='500 22px system-ui, -apple-system, Segoe UI, Roboto, Arial';
  ctx.fillText('Сгенерировано Калькулятором Отгрузки', margin+32, H - margin/2);

  return new Promise((resolve)=>canvas.toBlob((blob)=>resolve(blob),'image/png'));
}

async function renderReportShiftsToPng(theme){
  // ВАЖНО: тут только смены (без итога и переводов)
  if(!state.lastResult) throw new Error('Сначала нажми «Посчитать».');
  const data = buildReportData(state.lastResult);

  const W = 1080;
  const margin = 56;
  const colors = (theme==='light') ? {
    bg:'#EDE6D3', card:'#FBF7EC', text:'#221D16', muted:'#6b6151', border:'rgba(34,29,22,.18)', accent:'#B23A2E'
  } : {
    bg:'#0c0a08', card:'#1b1712', text:'#F3EFE4', muted:'rgba(243,239,228,.68)', border:'rgba(243,239,228,.14)', accent:'#FFC72C'
  };

  const rowH=54;
  const ps = (state.lastResult.perShiftAfter||[]);
  const shiftsH = ps.reduce((s,b)=> s + (120 + (b.lines||[]).length*rowH) + 18, 0);
  const H = margin*2 + 130 + 18 + shiftsH + 70;

  const canvas=document.createElement('canvas');
  canvas.width=W; canvas.height=H;
  const ctx=canvas.getContext('2d');
  ctx.fillStyle=colors.bg; ctx.fillRect(0,0,W,H);

  let y=margin;
  // small header
  ctx.fillStyle=colors.card; roundRect(ctx, margin, y, W-margin*2, 130, 22); ctx.fill();
  ctx.strokeStyle=colors.border; ctx.lineWidth=2; ctx.stroke();
  ctx.textAlign='left';
  ctx.fillStyle=colors.text; ctx.font='700 38px system-ui, -apple-system, Segoe UI, Roboto, Arial';
  ctx.fillText('Смены', margin+32, y+62);
  ctx.font='400 26px system-ui, -apple-system, Segoe UI, Roboto, Arial';
  ctx.fillStyle=colors.muted;
  ctx.fillText(`Дата: ${data.dateStr}`, margin+32, y+100);

  y += 130 + 18;

  const respSet = new Set((state.lastResult.responsibles||[]));
  ps.forEach(b=>{
    const lines=b.lines||[];
    const cardH=120 + lines.length*rowH;
    ctx.fillStyle=colors.card; roundRect(ctx, margin, y, W-margin*2, cardH, 22); ctx.fill();
    ctx.strokeStyle=colors.border; ctx.lineWidth=2; ctx.stroke();

    ctx.textAlign='left';
    ctx.fillStyle=colors.text; ctx.font='700 34px system-ui, -apple-system, Segoe UI, Roboto, Arial';
    ctx.fillText(`Смена ${b.shiftIndex}`, margin+32, y+56);

    let ry=y+92;
    lines.forEach(l=>{
      const isResp=respSet.has(l.name)||!!l.isResponsible;
      const delta = Number(l.delta ?? (Number(l.after||0)-Number(l.before||0)));

      ctx.textAlign='left';
      ctx.font=isResp?'700 30px system-ui, -apple-system, Segoe UI, Roboto, Arial':'600 30px system-ui, -apple-system, Segoe UI, Roboto, Arial';
      ctx.fillStyle=colors.text;
      ctx.fillText(isResp?`${l.name} ⭐`:l.name, margin+32, ry);

      ctx.textAlign='right';
      ctx.font='700 28px system-ui, -apple-system, Segoe UI, Roboto, Arial';
      ctx.fillStyle=colors.text;
      ctx.fillText(`${fmtMoney(l.before)} → ${fmtMoney(l.after)} (${delta>=0?'+':''}${fmtMoney(delta)})`, W-margin-32, ry);

      ctx.strokeStyle=colors.border;
      ctx.beginPath(); ctx.moveTo(margin+24, ry+24); ctx.lineTo(W-margin-24, ry+24); ctx.stroke();
      ry += rowH;
    });

    y += cardH + 18;
  });

  ctx.textAlign='left';
  ctx.fillStyle=colors.muted; ctx.font='500 22px system-ui, -apple-system, Segoe UI, Roboto, Arial';
  ctx.fillText('Сгенерировано Калькулятором Отгрузки', margin+32, H - margin/2);

  return new Promise((resolve)=>canvas.toBlob((blob)=>resolve(blob),'image/png'));
}

async function renderReportBlobs(theme){
  const items = [{ blob: await renderReportSummaryToPng(theme), filename: 'otchet_smen.png' }];
  if(state.reportIncludeShifts){
    items.push({ blob: await renderReportShiftsToPng(theme), filename: 'otchet_smen_smeny.png' });
  }
  return items;
}

// Backward compatible:
async function renderReportToPng(theme){
  return (await renderReportBlobs(theme))[0].blob;
}




// rounded rect helper for canvas
function roundRect(ctx, x, y, w, h, r){
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+rr, y);
  ctx.arcTo(x+w, y, x+w, y+h, rr);
  ctx.arcTo(x+w, y+h, x, y+h, rr);
  ctx.arcTo(x, y+h, x, y, rr);
  ctx.arcTo(x, y, x+w, y, rr);
  ctx.closePath();
}



  // Report theme segmented + actions
  const rtDark = $('reportThemeDark');
  const rtLight = $('reportThemeLight');
  const setReportThemeUI = ()=>{
    const th = (state.reportTheme==='light') ? 'light' : 'dark';
    state.reportTheme = th;
    if(rtDark) rtDark.classList.toggle('active', th==='dark');
    if(rtLight) rtLight.classList.toggle('active', th==='light');
  };
  if(rtDark) rtDark.addEventListener('click', ()=>{ state.reportTheme='dark'; saveState(); setReportThemeUI(); });
  if(rtLight) rtLight.addEventListener('click', ()=>{ state.reportTheme='light'; saveState(); setReportThemeUI(); });
  setReportThemeUI();
  const includeSh = $('includeShiftInReport');
  if(includeSh){
    includeSh.checked = !!state.reportIncludeShifts;
    includeSh.addEventListener('change', ()=>{ state.reportIncludeShifts = !!includeSh.checked; saveState(); });
  }

  const status = $('reportStatus');
  const saveBtn = $('btnSaveReport');
  const shareBtn = $('btnShareReport');

  async function makeReportBlobs(){
    if(status) status.textContent = 'Генерирую отчёт…';
    const items = await renderReportBlobs(state.reportTheme);
    if(!items || !items.length || !items[0] || !items[0].blob){
      throw new Error('Не удалось создать PNG.');
    }
    if(status) status.textContent = (items.length>1) ? 'Отчёты готовы (2 PNG).' : 'Отчёт готов.';
    return items;
  }

  if(saveBtn) saveBtn.addEventListener('click', async ()=>{
    try{
      const items = await makeReportBlobs();
      items.forEach(it=> downloadBlob(it.blob, it.filename));
      vibrate([10,40,10]);
    }catch(e){
      if(status) status.textContent = 'Ошибка: ' + (e && e.message ? e.message : String(e));
    }
  });

  if(shareBtn) shareBtn.addEventListener('click', async ()=>{
    try{
      const items = await makeReportBlobs();
      const files = items.map(it=> new File([it.blob], it.filename, {type:'image/png'}));
      if(navigator.share && navigator.canShare && navigator.canShare({files})){
        await navigator.share({ files, title:'Отчёт по сменам' });
        vibrate([10,40,10]);
      }else{
        files.forEach(f=> downloadBlob(f, f.name));
        if(status) status.textContent = 'Поделиться не поддерживается — PNG скачан.';
      }
    }catch(e){
      if(status) status.textContent = 'Ошибка: ' + (e && e.message ? e.message : String(e));
    }
  });


  const toggleShiftRes = $('toggleShiftResult');
  if(toggleShiftRes){
    toggleShiftRes.checked = !!state.showShiftResult;
    toggleShiftRes.addEventListener('change', ()=>{
      state.showShiftResult = !!toggleShiftRes.checked;
      saveState();
      if(state.lastResult) renderResult(state.lastResult);
    });
  }

const themeToggle=$('themeToggle');
  const savedTheme=localStorage.getItem('ko_theme') || 'dark';
  if(savedTheme==='light'){ document.documentElement.classList.add('light'); themeToggle.checked=true; }
  themeToggle.addEventListener('change', ()=>{
    const light=themeToggle.checked;
    document.documentElement.classList.toggle('light', light);
    localStorage.setItem('ko_theme', light ? 'light' : 'dark');
  });
}

/* Topbar height -> CSS var, so sticky summary sits right under it */
function updateTopbarHeightVar(){
  const tb = document.querySelector('.topbar');
  if(tb) document.documentElement.style.setProperty('--topbar-h', tb.offsetHeight+'px');
}
window.addEventListener('resize', updateTopbarHeightVar);

/* Свайп между вкладками */
(function swipeTabs(){
  const order = ['settings','shifts','result','transfers'];
  const app = document.querySelector('.app');
  if(!app) return;
  let startX=0, startY=0, tracking=false, decided=false, horizontal=false;

  function switchByDelta(dx){
    const current = document.querySelector('.tab.active');
    const curTab = current ? current.dataset.tab : 'settings';
    let idx = order.indexOf(curTab);
    if(idx===-1) idx = 0;
    idx = dx < 0 ? Math.min(order.length-1, idx+1) : Math.max(0, idx-1);
    const nextTab = order[idx];
    if(nextTab === curTab) return;
    vibrate(6);
    setTab(nextTab);
    if(state.lastResult && (nextTab==='result' || nextTab==='transfers')) renderResult(state.lastResult);
  }

  app.addEventListener('touchstart', (e)=>{
    if(e.touches.length!==1) return;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    tracking = true; decided = false; horizontal = false;
  }, {passive:true});

  app.addEventListener('touchmove', (e)=>{
    if(!tracking || e.touches.length!==1) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if(!decided && (Math.abs(dx) > 12 || Math.abs(dy) > 12)){
      decided = true;
      horizontal = Math.abs(dx) > Math.abs(dy) * 1.3;
    }
    // Как только поняли, что жест горизонтальный — забираем его себе,
    // иначе iOS на середине жеста решает, что это скролл, и отменяет его (touchcancel),
    // из-за чего свайп на страницах с длинным контентом (например "Переводы") не срабатывал.
    if(horizontal && e.cancelable) e.preventDefault();
  }, {passive:false});

  app.addEventListener('touchend', (e)=>{
    if(!tracking) return;
    tracking = false;
    if(!horizontal) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    if(Math.abs(dx) < 60) return;
    switchByDelta(dx);
  }, {passive:true});

  app.addEventListener('touchcancel', ()=>{ tracking=false; horizontal=false; }, {passive:true});
})();

/* Init */
loadState();
ensureArrays();

$('shifts').value=state.shifts;
$('people').value=state.people;
$('bonus').value=state.bonus;

buildNames();
buildResponsibles();
buildTable();
bind();
bindBackup();
bindKeypad();
bindOcrImport();
updateTopbarHeightVar();

if(state.lastResult){
  // если старый результат без переводов по сменам — пересчитаем из текущих данных
  try {
    if (!state.lastResult.perShiftTransfers) {
      const res = compute();
      state.lastResult = res;
      saveState();
    }
  } catch {}
  renderResult(state.lastResult);
}
