
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js'));
}
const $ = (id) => document.getElementById(id);

const state = {
  shifts: 3,
  people: 4,
  bonus: 1000,
  responsibles: [0],
  names: [],
  earnings: [],
  seniorBonuses: [],
  lastResult: null
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

function clampInt(v,a,b){ const n=parseInt(v,10); if(Number.isNaN(n)) return a; return Math.max(a,Math.min(b,n)); }
function safeName(i){ const n=(state.names[i]||'').trim(); return n? n : `Человек${i+1}`; }

function ensureArrays(){
  state.shifts = clampInt(state.shifts,1,10);
  state.people = clampInt(state.people,2,12);

  while(state.names.length < state.people) state.names.push('');
  if(state.names.length > state.people) state.names = state.names.slice(0,state.people);

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

  // старший отгрузки: бонусы по сменам (не влияет на расчёты команды)
  if(!Array.isArray(state.seniorBonuses)) state.seniorBonuses = [];
  while(state.seniorBonuses.length < state.shifts) state.seniorBonuses.push(0);
  if(state.seniorBonuses.length > state.shifts) state.seniorBonuses = state.seniorBonuses.slice(0,state.shifts);
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
    // ---- Бонус старшего отгрузки: вычитается ТОЛЬКО из суммы ответственного, затем идёт выравнивание ----
    const seniorBonus = Number((state.seniorBonuses||[])[s]||0);
    if(seniorBonus>0){
      const r = (state.responsibles && state.responsibles.length) ? state.responsibles[0] : 0;
      if(earn[s] && earn[s][r]!=null){
        const net = Number(earn[s][r]) - seniorBonus;
        if(!Number.isFinite(net)) throw new Error(`Некорректный бонус старшего (смена ${s+1})`);
        if(net < 0) throw new Error(`Бонус старшего больше суммы ответственного (смена ${s+1})`);
        earn[s][r] = net;
      }
    }
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
  

  // ---- Старший отгрузки (ОТДЕЛЬНЫЙ экран). НЕ влияет на расчёт команды.
  // ВАЖНО: бонус старшего вычитается только из суммы ответственного (см. выше), здесь мы лишь показываем кому сколько скинуть старшему.
  const seniorPerShift = [];
  let seniorTotalCents = 0;
  for(let s=0; s<m; s++){
    const L = cents(Number((state.seniorBonuses||[])[s]||0));
    const block = { shiftIndex: s+1, bonus: dec(L), lines: [] };
    if(L<=0){
      seniorPerShift.push(block);
      continue;
    }
    const r = (state.responsibles && state.responsibles.length) ? state.responsibles[0] : 0;
    const rName = names[r];
    // Если ответственный не был в смене (ячейка пустая), то показать предупреждение
    const was = (earn[s] && earn[s][r] != null);
    if(!was){
      block.note = 'Ответственного не было в этой смене — некому списать бонус старшего.';
      seniorPerShift.push(block);
      continue;
    }
    seniorTotalCents += L;
    block.lines.push({ from: rName, amount: dec(L) });
    seniorPerShift.push(block);
  }
  const seniorTotals = names.map((name,i)=>({ name, total: ((state.responsibles&&state.responsibles.length)?state.responsibles[0]:0)===i ? dec(seniorTotalCents) : 0 }));



const people = names.map((name,i)=>{
    const before=Math.round(totalsBefore[i]*100)/100;
    const after=Math.round((totalsBefore[i]+balances[i])*100)/100;
    const delta=Math.round((after-before)*100)/100;
    return {name, before, after, delta};
  });
  const transfers = settleTransfers(names, balances);
  return { names, perShiftAfter, perShiftTransfers, people, transfers, grandTotal,
 senior: { perShift: seniorPerShift, totals: seniorTotals },
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
    div.innerHTML = `<label class="grow">Имя #${i+1}<input data-name="${i}" type="text" value="${escapeHtml(state.names[i]||'')}" /></label>`;
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
  const tbl=$('earningsTable');
  const names=Array.from({length:state.people}, (_,i)=>safeName(i));

  const thead=document.createElement('thead');
  const trh=document.createElement('tr');
  trh.appendChild(th('Смена'));
  names.forEach(n=>trh.appendChild(th(n)));
  thead.appendChild(trh);

  const tbody=document.createElement('tbody');
  for(let s=0;s<state.shifts;s++){
    const tr=document.createElement('tr');
    const td0=document.createElement('td');
    td0.innerHTML=`<strong>Смена ${s+1}</strong>`;
    tr.appendChild(td0);
    for(let p=0;p<state.people;p++){
      const td=document.createElement('td');
      const inp=document.createElement('input');
      inp.type='text';
      inp.inputMode='decimal';
      inp.value=state.earnings[s][p] ?? '';
      inp.placeholder='—';
      inp.dataset.shift=String(s);
      inp.dataset.person=String(p);
      inp.addEventListener('input', (e)=>{
        const ss=Number(e.target.dataset.shift);
        const pp=Number(e.target.dataset.person);
        state.earnings[ss][pp]=e.target.value.replace(/[^\d.,]/g,'');
        saveState();
      });
      td.appendChild(inp);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  tbl.innerHTML='';
  tbl.appendChild(thead);
  tbl.appendChild(tbody);
}


function buildSeniorInputs(){
  const wrap = $('seniorInputs');
  if(!wrap) return;
  wrap.innerHTML = '';
  for(let s=0; s<state.shifts; s++){
    const box = document.createElement('div');
    box.className = 'row';
    box.style.alignItems='center';
    box.style.justifyContent='space-between';
    box.innerHTML = `
      <label class="grow">Смена ${s+1}:
        <input class="seniorBonus" data-shift="${s}" type="number" min="0" step="1" value="${Number(state.seniorBonuses[s]||0)}" />
      </label>
    `;
    wrap.appendChild(box);
  }
  wrap.querySelectorAll('input.seniorBonus').forEach(inp=>{
    inp.addEventListener('input', e=>{
      const idx = Number(e.target.dataset.shift);
      state.seniorBonuses[idx] = Number(e.target.value||0);
      saveState();
    });
  });
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
  setTab(t);
  if(state.lastResult){
    if(t==='result' || t==='transfers') renderResult(state.lastResult);
    if(t==='senior') renderSenior(state.lastResult);
  }
}));


function renderSenior(res){
  const wrap = $('seniorPerShift');
  const totals = $('seniorTotals');
  if(!wrap || !totals) return;
  wrap.innerHTML = '';
  totals.innerHTML = '';
  const data = res && res.senior ? res.senior : { perShift: [], totals: [] };

  (data.perShift||[]).forEach(block=>{
    const card = document.createElement('div');
    card.className = 'card';
    const bonusTxt = fmtMoney(block.bonus||0);
    card.innerHTML = `
      <div class="row space">
        <div><strong>Смена ${block.shiftIndex}</strong> <span class="badge">бонус: ${bonusTxt}</span></div>
        ${block.note ? `<span class="small">${escapeHtml(block.note)}</span>` : ``}
      </div>
    `;
    if(block.lines && block.lines.length){
      const list=document.createElement('div');
      block.lines.forEach(ln=>{
        const row=document.createElement('div');
        row.className='row space';
        row.innerHTML = `<div>${displayName(ln.from, res.responsibles)}</div>`+
          `<div class="mono"><span class="badge bad">-${fmtMoney(ln.amount)}</span> <span class="small">старшему</span></div>`;
        list.appendChild(row);
      });
      card.appendChild(list);
    } else if(!block.note) {
      const sm=document.createElement('div');
      sm.className='small';
      sm.style.marginTop='8px';
      sm.textContent='Нет начислений старшему в этой смене.';
      card.appendChild(sm);
    }
    wrap.appendChild(card);
  });

  const head=document.createElement('h3');
  head.style.margin='0 0 10px 0';
  head.textContent='Итог по участникам';
  totals.appendChild(head);

  (data.totals||[]).forEach(p=>{
    if(!p.total) return;
    const row=document.createElement('div');
    row.className='row space';
    row.innerHTML = `<div>${displayName(p.name, res.responsibles)}</div>`+
      `<div class="mono"><span class="badge bad">-${fmtMoney(p.total)}</span> <span class="small">старшему</span></div>`;
    totals.appendChild(row);
  });

  if(!(data.totals||[]).some(p=>p.total)){
    const sm=document.createElement('div');
    sm.className='small';
    sm.textContent='Пока нет начислений старшему.';
    totals.appendChild(sm);
  }
}

function renderResult(res){
  const wrap=$('perShiftAfter');
  wrap.innerHTML='';
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
      row.innerHTML = `<div>${displayName(ln.name, res.responsibles)}</div>`+
        `<div class="mono"><span class="small">${fmtMoney(ln.before)} → ${fmtMoney(ln.after)}</span> `+
        `<span class="badge ${cls}">${ln.delta>=0?'+':''}${fmtMoney(ln.delta)}</span></div>`;
      list.appendChild(row);
    });
    card.appendChild(list);
    wrap.appendChild(card);
  });

  const overall=$('overall');
  overall.innerHTML = `
    <div class="row">
      <span class="badge">Ответственный: ${escapeHtml(res.responsibles)}</span>
      <span class="badge">Бонус/смена: ${fmtMoney(res.bonusPerShift)}</span>
      <span class="badge">Общая сумма: ${fmtMoney(res.grandTotal)}</span>
    </div>
    <div style="margin-top:10px"></div>
  `;
  res.people.forEach(p=>{
    const row=document.createElement('div');
    row.className='row space';
    const cls = (p.delta>=0)?'good':'bad';
    row.innerHTML=`<div>${displayName(p.name, res.responsibles)}</div>`+
      `<div class="mono"><span class="small">${fmtMoney(p.before)} → ${fmtMoney(p.after)}</span> <span class="badge ${cls}">${p.delta>=0?'+':''}${fmtMoney(p.delta)}</span></div>`;
    overall.appendChild(row);
  });

  // переводы за каждую смену (отдельно). Общий блок ниже НЕ трогаем.
  const pst = $('perShiftTransfers');
  // заголовок

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
  out += `Ответственный: ${res.responsibles}\n`;
  out += `Бонус/смена: ${fmtMoney(res.bonusPerShift)}\n`;
  out += `Общая сумма: ${fmtMoney(res.grandTotal)}\n\n`;
  out += `ИТОГО ПО СМЕНАМ (после выравнивания):\n`;
  res.perShiftAfter.forEach(b=>{
    out += `Смена ${b.shiftIndex} (сумма ${fmt(b.shiftTotal)}):\n`;
    b.lines.forEach(ln=> out += `- ${ln.name}: ${fmtMoney(ln.before)} -> ${fmtMoney(ln.after)} (${ln.delta>=0?'+':''}${fmtMoney(ln.delta)})\n`);
    out += `\n`;
  });
  out += `ОБЩИЙ ИТОГ:\n`;
  res.people.forEach(p=> out += `- ${p.name}: ${fmtMoney(p.before)} -> ${fmtMoney(p.after)} (${p.delta>=0?'+':''}${fmtMoney(p.delta)})\n`);
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
function bind(){
  $('shifts').addEventListener('change', e=>{ state.shifts=e.target.value; ensureArrays(); buildNames(); buildResponsibles(); buildTable(); buildSeniorInputs(); saveState(); });
  $('people').addEventListener('change', e=>{ state.people=e.target.value; ensureArrays(); buildNames(); buildResponsibles(); buildTable(); buildSeniorInputs(); saveState(); });
  $('bonus').addEventListener('input', e=>{ state.bonus=e.target.value; saveState(); });
  
  const seniorPanel = $('seniorPanel');
  const btnSeniorToggle = $('btnSeniorToggle');
  if(btnSeniorToggle && seniorPanel){
    btnSeniorToggle.addEventListener('click', ()=>{
      seniorPanel.classList.toggle('hidden');
    });
  }


  $('btnResize').addEventListener('click', ()=>{ ensureArrays(); buildNames(); buildResponsibles(); buildTable(); buildSeniorInputs(); showError(''); saveState(); });
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
      renderSenior(res);
      setTab('result');
      btn.disabled = false;
      btn.textContent = 'Посчитать';
    }catch(err){
      showError(err.message || String(err));
      setTab('input');
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

  const themeToggle=$('themeToggle');
  const savedTheme=localStorage.getItem('ko_theme') || 'dark';
  if(savedTheme==='light'){ document.documentElement.classList.add('light'); themeToggle.checked=true; }
  themeToggle.addEventListener('change', ()=>{
    const light=themeToggle.checked;
    document.documentElement.classList.toggle('light', light);
    localStorage.setItem('ko_theme', light ? 'light' : 'dark');
  });
}

/* Init */
loadState();
ensureArrays();

$('shifts').value=state.shifts;
$('people').value=state.people;
$('bonus').value=state.bonus;

buildNames();
buildResponsibles();
buildTable();
buildSeniorInputs();
bind();

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
  renderSenior(state.lastResult);
}
