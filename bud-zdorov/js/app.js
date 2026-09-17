/* ============================================================
   Будь здоров — основная логика
   Разработчик: Zakharevich Igor, +375293371413, csl.by
   ============================================================ */

(function(){
  const $  = (s,r=document)=>r.querySelector(s);
  const $$ = (s,r=document)=>[...r.querySelectorAll(s)];

  // =============================================================
  // Android bridge: reliable file picker for APK builds (camera/gallery).
  // On some MIUI/Samsung/Huawei firmwares WebView's onShowFileChooser is broken
  // and <input type=file> just does nothing. The Android Java side exposes
  // window.AndroidBridge.takePhoto() and window.AndroidBridge.pickPhoto(multi)
  // which call the native camera/gallery intents directly, then deliver the
  // resulting files as base64 data URLs via Bridge._onFiles([...]). This JS
  // layer converts them to real File objects and dispatches them onto the
  // hidden <input type=file> elements, so the existing change handlers keep working.
  // =============================================================
  (function setupAndroidBridge(){
    const AB = (typeof window !== 'undefined') ? window.AndroidBridge : null;
    if(!AB) return; // running in browser/PWA — use standard <input type=file> only
    window.Bridge = {
      _pendingTarget: null,
      _err(msg){ alert('Ошибка: '+msg); },
      _onCancel(){},
      take(targetId, multiple){
        // targetId is the <input type=file> id. Override its click to use native bridge.
        const inp = document.getElementById(targetId);
        if(!inp) return;
        this._pendingTarget = inp;
        // Hide the input's own click handling (we fire via native intent)
        try{
          if(/cam/i.test(targetId)) AB.takePhoto();
          else AB.pickPhoto(!!multiple || inp.multiple);
        }catch(e){ alert('Не удалось открыть: '+e); }
      },
      _onFiles(arr){
        const inp = this._pendingTarget;
        this._pendingTarget = null;
        if(!inp || !arr || !arr.length) return;
        // Convert {name,mime,dataUrl} → File objects
        const files = arr.map(o=>{
          const [meta,b64] = o.dataUrl.split(',');
          const mime = o.mime || (meta.match(/data:([^;]+)/)||[])[1] || 'image/jpeg';
          const bin = atob(b64);
          const u8 = new Uint8Array(bin.length);
          for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
          return new File([u8], o.name || ('photo_'+Date.now()+'.jpg'), {type:mime});
        });
        // Build a FileList-like object (DataTransfer works in modern WebView)
        try{
          const dt = new DataTransfer();
          files.forEach(f=>dt.items.add(f));
          inp.files = dt.files;
        }catch(e){
          // Fallback: assign directly
          try{ Object.defineProperty(inp, 'files', {value:files, configurable:true}); }catch(_){}
        }
        // Fire change event so the existing addEventListener('change') handlers run
        inp.dispatchEvent(new Event('change', {bubbles:true}));
      }
    };
    // Intercept clicks on the file inputs' LABEL buttons so they use the native bridge.
    // We do this by preventing default on <label> clicks for these inputs and calling Bridge.take().
    function wire(){
      ['labPhotoCam','labPhotoGal','ecgCamera','ecgGalleryInput','ecvGalleryQuick'].forEach(id=>{
        const inp = document.getElementById(id);
        if(!inp) return;
        // Find the wrapping <label> that activates the input
        const lbl = inp.closest('label');
        if(!lbl) return;
        if(lbl.dataset.bridgeWired) return;
        lbl.dataset.bridgeWired='1';
        lbl.addEventListener('click', function(e){
          if(!window.AndroidBridge) return; // let default label behavior work in browser
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          window.Bridge.take(id);
        }, true);
      });
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
    // Re-wire after any DOM changes (lazy renderers)
    new MutationObserver(wire).observe(document.documentElement, {childList:true, subtree:true});
  })();

  // ---- Storage bridge ----
  // When running in APK, window.NativeStorage (provided via @JavascriptInterface)
  // persists the important keys in the app's private SharedPreferences — данные
  // переживают любые обновления приложения (но НЕ uninstall; для переноса между
  // устройствами используйте Экспорт/Импорт JSON).
  // Otherwise (PWA/browser) we fall back to localStorage.
  const FileStorage = {
    _native: (typeof window !== 'undefined' && window.NativeStorage) ? window.NativeStorage : null,
    _mem: {},
    get(k){
      try{
        if (this._native){
          const v = this._native.getItem(k);
          return (v===null || v==="null" || v==="undefined") ? null : v;
        }
        return localStorage.getItem(k);
      }catch(e){ return localStorage.getItem(k); }
    },
    set(k,v){
      try{
        if (v===null || v===undefined){ this.remove(k); return; }
        const s = typeof v==='string' ? v : JSON.stringify(v);
        if (this._native){ this._native.setItem(k, s); return; }
        localStorage.setItem(k, s);
      }catch(e){ try{ localStorage.setItem(k, v); }catch(_){} }
    },
    remove(k){
      try{
        if (this._native){ this._native.removeItem(k); return; }
        localStorage.removeItem(k);
      }catch(e){ localStorage.removeItem(k); }
    }
  };
  // Override localStorage getItem/setItem for our keys so that old code that uses
  // localStorage transparently reads/writes to file-based storage when in APK.
  (function(){
    if (!FileStorage._native) return;
    const _origGet = Storage.prototype.getItem;
    const _origSet = Storage.prototype.setItem;
    const _origRem = Storage.prototype.removeItem;
    const PERSIST_KEYS = ['budzdorov_history','budzdorov_draft','budzdorov_fz','budzdorov_pin','budzdorov_lastcheck','budzdorov_lastversion'];
    Storage.prototype.getItem = function(k){
      if (PERSIST_KEYS.indexOf(k)>=0){ const v=FileStorage.get(k); return v===null?null:v; }
      return _origGet.call(this,k);
    };
    Storage.prototype.setItem = function(k,v){
      if (PERSIST_KEYS.indexOf(k)>=0){ FileStorage.set(k,v); return; }
      return _origSet.call(this,k,v);
    };
    Storage.prototype.removeItem = function(k){
      if (PERSIST_KEYS.indexOf(k)>=0){ FileStorage.remove(k); return; }
      return _origRem.call(this,k);
    };
  })();

  const today = new Date();
  const isoDate = today.toISOString().slice(0,10);

  // --- Font size control ---
  const FZ_KEY = 'budzdorov_fz';
  function setFontSize(mult){
    mult = Math.max(0.8, Math.min(1.6, mult));
    document.documentElement.style.setProperty('--fz', mult);
    localStorage.setItem(FZ_KEY, String(mult));
    $$('.fbtn').forEach(b=>b.classList.remove('active'));
    if (mult === 1) $('#fontReset').classList.add('active');
  }
  const savedFz = parseFloat(localStorage.getItem(FZ_KEY)) || 1;
  setFontSize(savedFz);
  $('#fontMinus').addEventListener('click',()=>{
    const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fz'))||1;
    setFontSize(Math.round((cur-0.1)*10)/10);
  });
  $('#fontPlus').addEventListener('click',()=>{
    const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fz'))||1;
    setFontSize(Math.round((cur+0.1)*10)/10);
  });
  $('#fontReset').addEventListener('click',()=>setFontSize(1));

  // Tabs
  $$('.tab').forEach(btn=>{
    btn.addEventListener('click',()=>switchTab(btn.dataset.tab));
  });

  // Build groups UI
  const container = $('#tab-analyses');
  ANALYSIS_GROUPS.forEach(group=>{
    const head = document.createElement('div');
    head.className = 'group-header';
    head.innerHTML = `<span>${group.title}</span><span style="font-size:12px;font-weight:500;opacity:.8">${group.tests.length} показателей</span>`;
    container.appendChild(head);

    group.tests.forEach(t=>{
      const row = document.createElement('div');
      row.className = 'test-row';
      row.dataset.group = group.id;
      row.dataset.test = t.id;

      let inputHtml;
      if (t.type === 'select'){
        inputHtml = `<select class="test-input" data-type="select">${t.options.map(o=>`<option value="${o}">${o}</option>`).join('')}</select>`;
      } else {
        inputHtml = `<input class="test-input" type="number" step="any" inputmode="decimal" placeholder="—" data-type="number" />`;
      }

      let rangeLabel = '';
      if (t.ranges){
        if (t.ranges.any) rangeLabel = `Норма: ${fmt(t.ranges.any[0])}–${fmt(t.ranges.any[1])} ${t.unit||''}`;
        else rangeLabel = `Норма: м ${fmt(t.ranges.m[0])}–${fmt(t.ranges.m[1])} / ж ${fmt(t.ranges.f[0])}–${fmt(t.ranges.f[1])} ${t.unit||''}`;
      } else if (t.normal) {
        rangeLabel = `Норма: ${t.normal.join(', ')}`;
      }

      row.innerHTML = `
        <div class="test-name">${t.name}<span class="test-range">${rangeLabel}</span></div>
        ${inputHtml}
        <div class="test-status" data-status>—</div>
      `;
      container.appendChild(row);

      const input = $('.test-input',row);
      input.addEventListener('input',()=>evaluateRow(group,t,row));
    });
  });

  function fmt(v){ return (v===0||v) ? Number(v).toString() : ''; }
  function parseValue(val){
    if (val===''||val===null||val===undefined||val==='—') return null;
    const s = String(val).trim().replace(',','.');
    if (s==='') return null;
    const n = parseFloat(s);
    return isNaN(n) ? s : n;
  }

  function getRange(t){
    if (!t.ranges) return null;
    if (t.ranges.any) return t.ranges.any;
    const sex = $('#patientSex').value;
    return (sex==='f' && t.ranges.f) ? t.ranges.f : t.ranges.m;
  }

  function evaluateRow(group,t,row){
    if (!t) return; // защита от нерезолвленных data-group/data-test (см. CODE_REVIEW A1)
    const input = $('.test-input',row);
    const status = $('[data-status]',row);
    input.classList.remove('low','high');
    status.className = 'test-status';

    if (t.type === 'select'){
      const v = input.value;
      if (!v||v==='—'){ status.textContent='—'; return; }
      if (t.normal && t.normal.includes(v)){ status.textContent='В норме'; status.classList.add('status-ok'); return; }
      status.textContent='Отклонение';
      status.classList.add('status-high');
      input.classList.add('high');
      return;
    }
    const v = parseValue(input.value);
    if (v === null){ status.textContent='—'; return; }
    const range = getRange(t);
    if (!range){ status.textContent='—'; return; } // у показателя нет числовых норм
    if (v < range[0]){
      status.textContent = `↓ < ${fmt(range[0])}`;
      status.classList.add('status-low'); input.classList.add('low');
    } else if (v > range[1]){
      status.textContent = `↑ > ${fmt(range[1])}`;
      status.classList.add('status-high'); input.classList.add('high');
    } else {
      status.textContent = 'В норме';
      status.classList.add('status-ok');
    }
  }

  $('#patientSex').addEventListener('change',()=>{
    $$('.test-row').forEach(row=>{
      const g = ANALYSIS_GROUPS.find(g=>g.id===row.dataset.group);
      if (!g) return;
      const t = g.tests.find(t=>t.id===row.dataset.test);
      if (!t) return;
      evaluateRow(g,t,row);
    });
  });
  $('#analysisDate').value = isoDate;

  // ---------- ECG (camera + gallery; works in WebView via proper input attrs) ----------
  const ecgGallery = $('#ecgGallery');
  const ecgImages = [];

  // ---------- Decode button (use event delegation on document so it works no matter when element is present) ----------
  function refreshEcgDecodeBtn(){
    const b = document.getElementById('ecgDecode');
    const h = document.getElementById('ecgDecodeHint');
    if(!b) return;
    if (ecgImages.length===0){
      b.setAttribute('disabled','disabled');
      b.classList.add('btn-disabled');
      b.style.opacity='0.55';
      b.style.cursor='not-allowed';
      b.style.pointerEvents='auto';
      if(h) h.textContent='Загрузите хотя бы один скан ЭКГ (камера или галерея), после чего кнопка «🩺 Расшифровать ЭКГ» станет активной.';
    } else {
      b.removeAttribute('disabled');
      b.classList.remove('btn-disabled');
      b.style.opacity='';
      b.style.cursor='';
      b.style.pointerEvents='auto';
      if(h) h.textContent='Нажмите «🩺 Расшифровать ЭКГ», чтобы открыть анализатор плёнки. Для точности можно предварительно нажать ✂ обрезать и 📐 откалибровать по калибровочному прямоугольнику.';
    }
  }
  document.addEventListener('click',function(e){
    const b = e.target.closest('#ecgDecode');
    if (!b) return;
    if (b.hasAttribute('disabled')){ e.preventDefault(); refreshEcgDecodeBtn(); return; }
    if (ecgImages.length===0){ refreshEcgDecodeBtn(); alert('Сначала загрузите скан ЭКГ (камера или галерея).'); return; }
    try{
      const item = ecgImages[ecgImages.length-1];
      openEcgViewer(item,{runAuto:true});
    }catch(err){ console.error(err); alert('Не удалось открыть анализатор: '+err); }
  });
  // Crop scissors button on each thumbnail — via delegation (capturing phase so it fires BEFORE image click)
  document.addEventListener('click',function(e){
    const b = e.target.closest('#ecgGallery button[data-crop]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const idx = parseInt(b.getAttribute('data-crop'),10);
    if (isNaN(idx)||!ecgImages[idx]) return;
    openEcgViewer(ecgImages[idx],{crop:true,cropIndex:idx});
  }, true);
  // Delete (X) button on each thumbnail — via delegation (capturing phase)
  document.addEventListener('click',function(e){
    const b = e.target.closest('#ecgGallery button[data-i]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const idx = parseInt(b.getAttribute('data-i'),10);
    ecgImages.splice(idx,1); renderEcg();
  }, true);

  function addFiles(files){
    const arr = [...files];
    arr.forEach((f,i)=>{
      const reader = new FileReader();
      reader.onload = ev=>{
        ecgImages.push({
          dataUrl: ev.target.result,
          name: f.name || ('ecg_'+Date.now()+'_'+i+'.jpg'),
          date: new Date().toISOString(),
          note: ''
        });
        renderEcg();
      };
      reader.readAsDataURL(f);
    });
  }
  $('#ecgCamera').addEventListener('change',e=>{ if(e.target.files) addFiles(e.target.files); e.target.value=''; });
  $('#ecgGalleryInput').addEventListener('change',e=>{ if(e.target.files) addFiles(e.target.files); e.target.value=''; });
  $('#ecgClear').addEventListener('click',()=>{ if(confirm('Удалить все сканы ЭКГ из этой записи?')){ ecgImages.length=0; renderEcg(); }});
  function renderEcg(){
    if (!ecgGallery) return;
    ecgGallery.innerHTML='';
    ecgImages.forEach((it,i)=>{
      const d = document.createElement('div');
      d.className='ecg-item';
      const date = (it.date||'').slice(0,10);
      d.innerHTML = `<img src="${it.dataUrl}" alt="ЭКГ" style="cursor:zoom-in"/>
        <div class="ecg-date">${date}</div>
        <button data-crop="${i}" title="Обрезать" class="ecg-crop-btn">✂</button>
        <button data-i="${i}" class="ecg-del-btn">✕</button>`;
      ecgGallery.appendChild(d);
    });
    refreshEcgDecodeBtn();
  }
  refreshEcgDecodeBtn();

  // ---------- Contextual Analyze FAB ----------
  // On the Complaints tab this button triggers complaint analysis;
  // on other tabs it runs analysis (recommendations/recs) as before.
  const recContent = $('#tabRecContent');
  $('#fabAnalyze').addEventListener('click',()=>{
    const activeTab = document.querySelector('.tab.active');
    const activeName = activeTab? activeTab.dataset.tab : '';
    if(activeName==='complaints'){
      const btn = document.getElementById('complaintsGo');
      if(btn) btn.click();
      return;
    }
    if(activeName==='reference') return;
    switchTab('rec');
    analyze();
  });
  $('#btnAnalyzeTab').addEventListener('click',analyze);
  $('#btnAnalyzeEcg').addEventListener('click',()=>{ switchTab('rec'); analyze(true); });

  function switchTab(name){
    $$('.tab').forEach(b=>b.classList.toggle('active', b.dataset.tab===name));
    $$('.tab-content').forEach(c=>c.classList.toggle('active', c.id==='tab-'+name));
    // Hide the FAB on tabs where its fixed position blocks content (esp. ECG decoder with its own toolbar)
    const fab=$('#fabAnalyze');
    if(fab){
      // Hide FAB on tabs where it conflicts (decoder toolbar, already has big analyze button on rec page, reference tab, about)
      const hide = (name==='ecg-decode'||name==='ecg'||name==='rec'||name==='reference'||name==='about'||name==='history'||name==='dynamics');
      fab.style.display = hide ? 'none' : '';
      // Update label by tab context
      fab.textContent = (name==='complaints') ? '🔍 Проанализировать' : '🔬 Анализ';
    }
    if (name==='dynamics') renderDynamics();
    if (name==='ecg-decode'){
      // Ensure canvas event bindings are attached (they run once) and resize canvas once tab becomes visible
      _bindCanvasOnce();
      setTimeout(()=>{ _bindCanvasOnce(); if(ecv.img) drawCanvas(); }, 80);
    }
    window.scrollTo(0,0);
  }

  function collectCurrentItems(){
    const items=[];
    $$('.test-row').forEach(row=>{
      try{
        const gid = row.dataset.group;
        const tid = row.dataset.test;
        const g = ANALYSIS_GROUPS.find(g=>g.id===gid);
        if (!g) return;
        const t = g.tests.find(t=>t.id===tid);
        if (!t) return;
        const input = $('.test-input',row);
        if (!input) return;
        const val = input.value;
        if (t.type==='select'){
          const v = val;
          if (!v||v==='—'||(t.normal&&t.normal.includes(v))) return;
          const info = (t.abnormal||{})[v] || {};
          items.push({test:t, dir:'abnormal', value:v, info});
        } else {
          if (val===''||val===null||val===undefined) return;
          const v = parseFloat(String(val).replace(',','.'));
          if (isNaN(v)) return;
          const range = getRange(t);
          if (!range||range.length!==2) return;
          if (v>=range[0]&&v<=range[1]) return;
          const dir = v<range[0]?'low':'high';
          const info = t[dir] || {};
          items.push({test:t, dir, value:v, range, info});
        }
      }catch(e){ /* skip broken row */ }
    });
    return items;
  }

  function ecgHits(){
    const notes = ($('#ecgNotes').value||'').toLowerCase();
    return ECG_HINTS.filter(h=>notes.includes(h.keyword));
  }

  function analyze(ecgOnly){
    // make sure evaluateRow has been applied to every row so statuses reflect current values
    $$('.test-row').forEach(row=>{
      const g = ANALYSIS_GROUPS.find(g=>g.id===row.dataset.group);
      if (!g) return;
      const t = g.tests.find(t=>t.id===row.dataset.test);
      if (g&&t) evaluateRow(g,t,row);
    });

    const items = ecgOnly ? [] : collectCurrentItems();
    const hits = ecgHits();
    const hasAnyInput = hasAnyEntered();
    recContent.innerHTML='';

    if (items.length===0 && hits.length===0 && ecgImages.length===0){
      if (!hasAnyInput){
        recContent.innerHTML = `<div class="rec-item">
          <div class="tname">📌 Пока не введены результаты анализов</div>
          <p>Введите значения показателей на вкладке «🩸 Анализы», при необходимости добавьте сканы/заметки ЭКГ на вкладке «💓 ЭКГ», затем нажмите «🔍 Анализировать» — и здесь появятся персональные рекомендации: на что обратить внимание, какие заболевания могут быть причиной отклонений, их симптоматика и к какому врачу обратиться.</p>
          <div class="adv">⚠ Приложение даёт только справочную информацию. Окончательный диагноз ставит врач.</div>
        </div>`;
      } else {
        recContent.innerHTML = `<div class="rec-item">
          <div class="tname">✅ Все введённые показатели — в пределах референсных значений</div>
          <p>Продолжайте вести здоровый образ жизни: сбалансированное питание, сон 7–8 часов, регулярная физическая активность, отказ от вредных привычек. Не забывайте о профилактических осмотрах раз в год.</p>
          <div class="adv">⚠ Это не гарантирует отсутствие проблем. Если есть жалобы или плохое самочувствие — обратитесь к врачу, даже если показатели «в норме».</div>
        </div>`;
      }
      window.scrollTo({top:0, behavior:'smooth'});
      return;
    }

    if (items.length===0){
      recContent.innerHTML += `<div class="rec-item"><div class="tname">✅ Введённые показатели — в пределах нормы</div></div>`;
    }

    items.forEach(it=>{
      const cls = it.dir==='high'?'hi':(it.dir==='low'?'mi':'');
      let valText;
      if (it.test.type==='select'){
        valText = `Значение: <b>${it.value}</b>`;
      } else {
        valText = `Значение: <b>${it.value}</b> ${it.test.unit||''} &nbsp;·&nbsp; норма: ${fmt(it.range[0])}–${fmt(it.range[1])} ${it.test.unit||''}`;
      }
      const info = it.info||{};
      const diseasesHtml = (info.diseases&&info.diseases.length)
        ? `<ul>${info.diseases.map(d=>`<li><span class="dis">${d.name}.</span> Симптомы: ${d.symptoms} <em>→ К врачу: <b>${d.doctor}</b></em></li>`).join('')}</ul>`
        : '';
      const block = document.createElement('div');
      block.className='rec-item '+cls;
      block.innerHTML = `
        <div class="tname">${arrow(it.dir)} ${it.test.name}</div>
        <div class="tval">${valText}</div>
        ${diseasesHtml}
        ${info.advice?`<div class="adv">💡 ${info.advice}</div>`:''}
      `;
      recContent.appendChild(block);
    });

    if (ecgImages.length || hits.length){
      const block=document.createElement('div');
      block.className='rec-item ecg-rec';
      block.innerHTML = `<div class="tname">💓 ЭКГ${ecgImages.length?` (загружено сканов: ${ecgImages.length})`:''}</div>
        <p>Расшифровку ЭКГ проводит <b>кардиолог/функциональный диагност</b>. На приём возьмите саму плёнку и опишите жалобы: когда возникают неприятные ощущения, чем провоцируются, как долго длятся.</p>
        ${hits.length?hits.map(h=>`<p>🔎 <b class="dis">${h.keyword}:</b> ${h.advice}</p>`).join(''):''}
        <div class="adv">⚠ При острой боли за грудиной, холодном поте, одышке или потере сознания — немедленно вызывайте скорую (103).</div>`;
      recContent.appendChild(block);
    }

    const summaryBox = document.createElement('div');
    summaryBox.className='rec-item';
    const abnHigh = items.filter(i=>i.dir==='high').length;
    const abnLow  = items.filter(i=>i.dir==='low').length;
    let sumTxt = `<div class="tname">📊 Итого по текущему анализу</div>
      <p>Проанализировано показателей: <b>${$$('.test-row input.test-input, .test-row select.test-input').length}</b>. Выявлено отклонений: <b style="color:var(--red-700)">${items.length}</b> (выше нормы: ${abnHigh}, ниже нормы: ${abnLow}).</p>
      <div class="adv">Все отклонения показаны выше с описанием возможных причин, симптомов и рекомендациями по специалистам. Используйте эту информацию как подсказку для подготовки к визиту к врачу, а не как диагноз.</div>`;
    summaryBox.innerHTML = sumTxt;
    recContent.insertBefore(summaryBox, recContent.firstChild);

    const warn=document.createElement('div');
    warn.className='warning-box';
    warn.innerHTML='⚠ Информация основана на общедоступных медицинских справочниках и носит <b>ознакомительный характер</b>. Она не заменяет очный приём врача и не является руководством к самолечению. При острых состояниях звоните 103.';
    recContent.appendChild(warn);
    window.scrollTo({top:0, behavior:'smooth'});
  }

  // check whether any value has been entered
  function hasAnyEntered(){
    let any=false;
    $$('.test-row').forEach(row=>{
      const inp = $('.test-input',row);
      if (inp && String(inp.value).trim()!=='' && inp.value!=='—') any=true;
    });
    if ($('#ecgNotes').value && $('#ecgNotes').value.trim()!=='') any=true;
    if (ecgImages.length>0) any=true;
    return any;
  }
  function arrow(dir){ return dir==='low'?'↓':dir==='high'?'↑':'⚠'; }

  // ---------- Save / history ----------
  function gatherData(){
    const values={};
    $$('.test-row').forEach(row=>{
      values[row.dataset.group+'::'+row.dataset.test] = $('.test-input',row).value;
    });
    return {
      id: Date.now(),
      date: $('#analysisDate').value,
      patientName: $('#patientName').value,
      patientAge: $('#patientAge').value,
      patientSex: $('#patientSex').value,
      values,
      ecgNotes: $('#ecgNotes').value,
      ecg: ecgImages.slice()
    };
  }
  function loadHistory(){ try{return JSON.parse(localStorage.getItem('budzdorov_history')||'[]');}catch(e){return[];} }
  function saveHistory(h){ localStorage.setItem('budzdorov_history',JSON.stringify(h.slice(0,200))); }

  function abnormalCount(values){
    let n=0;
    for (const k in values){
      const [gid,tid] = k.split('::');
      const g = ANALYSIS_GROUPS.find(g=>g.id===gid); if(!g) continue;
      const t = g.tests.find(t=>t.id===tid); if(!t||!values[k]||values[k]==='—') continue;
      if (t.type==='select'){ if (t.normal && !t.normal.includes(values[k])) n++; }
      else {
        const num = parseFloat(values[k]);
        if (isNaN(num)) continue;
        const range = getRange(t);
        if (num<range[0]||num>range[1]) n++;
      }
    }
    return n;
  }

  function renderHistory(){
    const list = $('#historyList');
    const h = loadHistory();
    if (!h.length){ list.innerHTML='<p class="hint">Пока нет сохранённых записей. Сохраните первый результат анализа — после этого на вкладке «📈 Динамика» появится картина того, как лечение/диета/образ жизни влияют на показатели.</p>'; return; }
    list.innerHTML='';
    h.forEach(entry=>{
      const div=document.createElement('div');
      div.className='history-entry';
      const abn = abnormalCount(entry.values||{});
      const ecgCnt = (entry.ecg||[]).length;
      div.innerHTML = `
        <div class="hed">
          <span>${escHtml(entry.patientName||'Без имени')}${entry.patientAge?`, ${escHtml(entry.patientAge)} лет`:''} ${entry.patientSex==='m'?'♂':(entry.patientSex==='f'?'♀':'')}</span>
          <span>${entry.date||''}</span>
        </div>
        <div class="meta">Отклонений: ${abn} · ЭКГ сканов: ${ecgCnt}</div>
        <button class="btn" data-act="load">📂 Загрузить</button>
        <button class="btn" data-act="note">✏ Примечание</button>
        <button class="btn btn-danger" data-act="del">🗑 Удалить</button>`;
      div.querySelector('[data-act=load]').addEventListener('click',()=>loadSnapshot(entry));
      div.querySelector('[data-act=note]').addEventListener('click',()=>{
        const n = prompt('Примечание к записи (например: «начало приёма железа», «курс антибиотиков», «после диеты 2 мес.»):', entry.note||'');
        if (n!==null){ entry.note=n; const arr=loadHistory().map(x=>x.id===entry.id?entry:x); saveHistory(arr); renderHistory(); }
      });
      div.querySelector('[data-act=del]').addEventListener('click',()=>{
        if(confirm('Удалить запись?')){
          saveHistory(loadHistory().filter(x=>x.id!==entry.id));
          renderHistory();
        }
      });
      list.appendChild(div);
    });
  }

  // Группы-дубликаты переименованы в 1.8.49 (thyroid_full, vitamins_ext), чтобы ключи
  // сохранений «group::test» стали уникальными. Старые записи читаем через алиасы.
  const LEGACY_GROUP_RENAME = { thyroid:'thyroid_full', vitamins:'vitamins_ext' };
  function rowForKey(gid,tid){
    const row = $(`.test-row[data-group="${gid}"][data-test="${tid}"]`);
    if (row) return row;
    const alt = LEGACY_GROUP_RENAME[gid];
    return alt ? $(`.test-row[data-group="${alt}"][data-test="${tid}"]`) : null;
  }

  function loadSnapshot(entry){
    $('#analysisDate').value = entry.date||'';
    $('#patientName').value = entry.patientName||'';
    $('#patientAge').value = entry.patientAge||'';
    $('#patientSex').value = entry.patientSex||'';
    $('#ecgNotes').value = entry.ecgNotes||'';
    ecgImages.length=0;
    (entry.ecg||[]).forEach(e=>ecgImages.push(e));
    renderEcg();
    for (const k in entry.values){
      const [gid,tid]=k.split('::');
      const row = rowForKey(gid,tid);
      if (row){
        const inp = $('.test-input',row);
        inp.value = entry.values[k];
        const g = ANALYSIS_GROUPS.find(g=>g.id===row.dataset.group);
        const t = g && g.tests.find(t=>t.id===tid);
        evaluateRow(g,t,row);
      }
    }
    $$('.tab').forEach(b=>b.classList.remove('active'));
    $$('.tab-content').forEach(c=>c.classList.remove('active'));
    document.querySelector('.tab[data-tab="analyses"]').classList.add('active');
    $('#tab-analyses').classList.add('active');
  }

  $('#btnSave').addEventListener('click',()=>{
    const data = gatherData();
    const n = prompt('Примечание к записи (лечение, диета, самочувствие — чтобы потом видеть, как повлияло):', '');
    if (n!==null) data.note = n;
    const history = loadHistory();
    history.unshift(data);
    saveHistory(history);
    renderHistory();
    alert('Запись сохранена. Перейдите на вкладку «📈 Динамика», чтобы увидеть общую картину по всем записям.');
  });
  $('#btnClear').addEventListener('click',()=>{
    if(confirm('Очистить все поля текущей формы? История сохранённых записей не удалится.')){
      $('#patientName').value=''; $('#patientAge').value=''; $('#patientSex').value=''; $('#analysisDate').value=isoDate;
      $('#ecgNotes').value='';
      ecgImages.length=0; renderEcg();
      $$('.test-row').forEach(row=>{
        const inp=$('.test-input',row); inp.value=''; inp.classList.remove('low','high');
        const st=$('[data-status]',row); st.textContent='—'; st.className='test-status';
      });
    }
  });
  $('#btnExport').addEventListener('click',()=>{
    const data = { history: loadHistory(), version:'1.1.0', exported:new Date().toISOString(), app:'Будь здоров' };
    const blob = new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bud-zdorov-'+isoDate+'.json';
    a.click(); URL.revokeObjectURL(a.href);
  });
  $('#importFile').addEventListener('change',e=>{
    const f = e.target.files[0]; if(!f) return;
    const r = new FileReader();
    r.onload = ev=>{
      try{
        const d = JSON.parse(ev.target.result);
        if (d.history && Array.isArray(d.history)){
          const merged = mergeHistory(loadHistory(), d.history);
          saveHistory(merged);
          renderHistory();
          alert('Импортировано. Всего записей: '+merged.length);
        }
      }catch(err){alert('Ошибка импорта: неверный файл.');}
    };
    r.readAsText(f);
    e.target.value='';
  });
  function mergeHistory(a,b){
    const ids = new Set(a.map(x=>x.id));
    b.forEach(x=>{ if(!ids.has(x.id)) a.push(x); });
    a.sort((x,y)=>(y.id||0)-(x.id||0));
    return a;
  }
  renderHistory();

  // ---------- DYNAMICS ----------
  function findTest(gid,tid){
    let g = ANALYSIS_GROUPS.find(g=>g.id===gid);
    if (!g){
      const alt = LEGACY_GROUP_RENAME[gid];
      if (alt) g = ANALYSIS_GROUPS.find(g=>g.id===alt);
    }
    return g?g.tests.find(t=>t.id===tid):null;
  }
  function getNumRange(t, sex){
    if (!t || !t.ranges) return null;
    if (t.ranges.any) return t.ranges.any;
    return (sex==='f' && t.ranges.f) ? t.ranges.f : t.ranges.m;
  }
  function seriesFromHistory(testId, groupId, t){
    const hist = loadHistory().slice().reverse(); // oldest first
    const sex = detectSex();
    const range = getNumRange(t, sex);
    const pts=[];
    hist.forEach(h=>{
      const v = (h.values||{})[groupId+'::'+testId];
      if (v===undefined||v===''||v==='—') return;
      const n = parseFloat(v);
      if (isNaN(n)) return;
      pts.push({date:h.date||'', value:n, note:h.note||'', entry:h});
    });
    return {pts, range};
  }
  function detectSex(){
    const s = $('#patientSex').value;
    if (s) return s;
    const h = loadHistory();
    for (const e of h) if (e.patientSex) return e.patientSex;
    return 'any';
  }

  function trend(pts){
    if (pts.length<2) return {dir:'stable', delta:0, pct:0};
    const first = pts[0].value, last = pts[pts.length-1].value;
    const delta = last - first;
    const pct = first!==0 ? delta/Math.abs(first)*100 : 0;
    return {first,last,delta,pct};
  }

  function renderDynamics(){
    const sumBox = $('#dynSummary');
    const chartsBox = $('#dynCharts');
    const detailsBox = $('#dynDetails');
    const hist = loadHistory();

    if (hist.length<2){
      sumBox.innerHTML=`<div class="warning-box">📊 Нужно минимум <b>2 сохранённые записи</b>, чтобы оценить динамику. Сдайте анализы повторно (например, через 2–4 недели после начала лечения/диеты/приёма препаратов) и сохраните результат — тогда приложение покажет, как повлияло лечение на показатели.</div>`;
      chartsBox.innerHTML=''; detailsBox.innerHTML='';
      return;
    }

    // ---- summary stats ----
    let totalTests=0, improved=0, worsened=0, normalNow=0, chronAbn=[];
    const last = hist[0];
    const first = hist[hist.length-1];
    const allTestKeys = new Set([...Object.keys(last.values||{}), ...Object.keys(first.values||{})]);

    const byTestSeries = {};
    ANALYSIS_GROUPS.forEach(g=>g.tests.forEach(t=>{
      if (t.type==='select') return;
      const {pts,range} = seriesFromHistory(t.id, g.id, t);
      if (pts.length<2) return;
      byTestSeries[g.id+'::'+t.id] = {pts,range,t,g};
    }));

    let improvedTests=[], worsenedTests=[], chronic=[], stillAbnormal=[], nowNormal=[];
    Object.values(byTestSeries).forEach(({pts,range,t})=>{
      totalTests++;
      const f = pts[0].value, l = pts[pts.length-1].value;
      const fAbn = f<range[0]||f>range[1];
      const lAbn = l<range[0]||l>range[1];
      if (fAbn && !lAbn) { improvedTests.push(t); improved++; }
      else if (!fAbn && lAbn) { worsenedTests.push(t); worsened++; }
      else if (fAbn && lAbn) {
        chronic.push(t);
        const moved = Math.abs(l-range[0])+Math.abs(l-range[1]) - (Math.abs(f-range[0])+Math.abs(f-range[1]));
        if (moved<0) improvedTests.push(t); else worsenedTests.push(t);
      } else { nowNormal.push(t); normalNow++; }
    });

    const lastAbn = abnormalCount(last.values||{});
    const firstAbn = abnormalCount(first.values||{});
    const deltaAbn = lastAbn - firstAbn;

    const nEntries = hist.length;
    const dateFirst = first.date||'—';
    const dateLast  = last.date||'—';

    let bigImg = 'info';
    let bigText = 'Данных достаточно';
    if (improved>worsened && chronic.length===0){ bigImg=''; bigText='Положительная динамика 🎉'; }
    else if (worsened>improved){ bigImg='bad'; bigText='Есть негативные тренды'; }
    else if (chronic.length){ bigImg='warn'; bigText='Есть показатели вне нормы'; }

    sumBox.innerHTML = `
      <p><b>Период наблюдения:</b> с ${dateFirst} по ${dateLast} · всего записей: <b>${nEntries}</b>.</p>
      <div class="dyn-stat">
        <div class="box ${bigImg}"><div class="num">${nEntries}</div><div class="lbl">записей в журнале</div></div>
        <div class="box ${deltaAbn<=0?'':'bad'}"><div class="num">${lastAbn}</div><div class="lbl">отклонений в последнем анализе (было ${firstAbn})</div></div>
        <div class="box"><div class="num" style="color:var(--green-700)">${improved}</div><div class="lbl">показателей улучшилось / вошло в норму</div></div>
        <div class="box ${worsened?'bad':''}"><div class="num">${worsened}</div><div class="lbl">показателей ухудшилось / вышло из нормы</div></div>
      </div>
      ${chronic.length?`<div class="warning-box"><b>Хронически вне нормы (${chronic.length}):</b> ${chronic.slice(0,6).map(t=>t.name).join('; ')}${chronic.length>6?'…':''}. Нужно показаться врачу для корректировки лечения.</div>`:''}
      ${(improvedTests.length && !worsenedTests.length)?`<div class="rec-item"><div class="tname">🎉 Общая картина положительная</div><div class="adv">Судя по динамике, проводимое лечение/диета/образ жизни дают эффект: ряд показателей вернулся в референсные значения. Продолжайте под наблюдением лечащего врача, не отменяйте препараты самостоятельно.</div></div>`:''}
      ${worsenedTests.length?`<div class="rec-item hi"><div class="tname">⚠ На что обратить внимание</div><ul>${worsenedTests.slice(0,8).map(t=>`<li><span class="dis">${t.name}</span> — перешёл за границы нормы или сместился в сторону отклонения. Обсудите с врачом.</li>`).join('')}</ul><div class="adv">Возможные причины: корректировка дозировки, погрешности питания, обострение заболевания, присоединение новой болезни, нехватка микроэлементов, стресс, физические перегрузки.</div></div>`:''}
    `;

    // ---- charts: render simple inline SVG charts for all tracked numerical tests ----
    chartsBox.innerHTML='';
    detailsBox.innerHTML='';

    const toRender = Object.values(byTestSeries).sort((a,b)=>{
      // prioritize those with abnormalities / strong movement
      const sa = score(a), sb = score(b);
      return sb-sa;
    });

    toRender.forEach(({pts,range,t,g})=>{
      const tr = trend(pts);
      const first = pts[0].value, last = pts[pts.length-1].value;
      const firstAbn = first<range[0]||first>range[1];
      const lastAbn = last<range[0]||last>range[1];

      let trendClass='trend-stable', trendLabel='— стабильно';
      let bad = false;
      if (firstAbn && !lastAbn){ trendClass='trend-down'; trendLabel='✅ в норму'; }
      else if (!firstAbn && lastAbn){ trendClass='trend-badup'; trendLabel='⚠ вышло из нормы'; bad=true; }
      else if (firstAbn && lastAbn){
        // direction relative to norm
        const mid = (range[0]+range[1])/2;
        if (Math.abs(last-mid)<Math.abs(first-mid)){ trendClass='trend-down'; trendLabel='↘ к норме'; }
        else { trendClass='trend-badup'; trendLabel='↗ дальше от нормы'; bad=true; }
      } else {
        if (Math.abs(tr.pct)>10){ trendClass='trend-up'; trendLabel=(tr.delta>0?'↗':'↘')+' '+Math.round(Math.abs(tr.pct))+'%'; }
      }

      // build SVG chart
      const W=320,H=90,padL=34,padR=8,padT=10,padB=22;
      const innerW=W-padL-padR, innerH=H-padT-padB;
      const values = pts.map(p=>p.value);
      let min=Math.min(...values,range[0]);
      let max=Math.max(...values,range[1]);
      const span=(max-min)||1;
      min -= span*0.1; max += span*0.1;
      const xOf = i => padL + (pts.length===1?innerW/2:(innerW*i/(pts.length-1)));
      const yOf = v => padT + innerH - (v-min)/(max-min)*innerH;

      // normal band
      const yLow = yOf(range[0]);
      const yHigh = yOf(range[1]);
      const normalBand = `<rect x="${padL}" y="${Math.min(yLow,yHigh)}" width="${innerW}" height="${Math.abs(yHigh-yLow)}" fill="#c8e6c9" opacity=".7"/>`;

      // polyline
      const poly = pts.map((p,i)=>`${xOf(i)},${yOf(p.value)}`).join(' ');
      const circles = pts.map((p,i)=>{
        const abn = p.value<range[0]||p.value>range[1];
        return `<circle cx="${xOf(i)}" cy="${yOf(p.value)}" r="${abn?3.5:2.5}" fill="${abn?'#c62828':'#2e7d32'}"/>`;
      }).join('');

      // axis labels
      const lblTop = `<text x="${padL-4}" y="${padT+9}" text-anchor="end" font-size="9" fill="#616161">${shortNum(max)}</text>`;
      const lblBot = `<text x="${padL-4}" y="${H-padB+10}" text-anchor="end" font-size="9" fill="#616161">${shortNum(min)}</text>`;
      const lblLast = `<text x="${W-padR-2}" y="${yOf(pts[pts.length-1].value)-4}" text-anchor="end" font-size="10" fill="${lastAbn?'#c62828':'#2e7d32'}" font-weight="700">${shortNum(pts[pts.length-1].value)}</text>`;
      const firstDate = `<text x="${padL}" y="${H-6}" font-size="9" fill="#9e9e9e">${(pts[0].date||'').slice(5)}</text>`;
      const lastDate  = `<text x="${W-padR}" y="${H-6}" text-anchor="end" font-size="9" fill="#9e9e9e">${(pts[pts.length-1].date||'').slice(5)}</text>`;

      const chartCard = document.createElement('div');
      chartCard.className='chart-card';
      chartCard.innerHTML = `
        <div class="ch-head">
          <div class="ch-title">${t.name} <span style="font-weight:400;color:#9e9e9e">${t.unit||''} · норма ${fmt(range[0])}–${fmt(range[1])}</span></div>
          <div class="ch-trend ${trendClass}">${trendLabel}</div>
        </div>
        <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          ${normalBand}
          <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H-padB}" stroke="#e0e0e0"/>
          <line x1="${padL}" y1="${H-padB}" x2="${W-padR}" y2="${H-padB}" stroke="#e0e0e0"/>
          ${lblTop}${lblBot}
          <polyline points="${poly}" fill="none" stroke="#2e7d32" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
          ${circles}
          ${lblLast}${firstDate}${lastDate}
        </svg>`;
      chartsBox.appendChild(chartCard);

      // detailed narrative
      const det = document.createElement('div');
      det.className = 'dyn-test '+(bad?'bad':(firstAbn&&!lastAbn?'improved':(lastAbn?'warn':'')));
      det.innerHTML = `<div class="tname">${t.name} (${g.title.replace(/^[^\s]+\s/,'')})</div>
        <div class="thist">${pts.map(p=>`<span title="${escHtml(p.note||'')}">${(p.date||'').slice(5)}: <b>${shortNum(p.value)}</b>${p.value<range[0]?' ↓':(p.value>range[1]?' ↑':'')}${p.note?' 📝':''}</span>`).join(' · ')}</div>
        <div class="trep">${dynamicNarrative(t,pts,range)}</div>`;
      detailsBox.appendChild(det);
    });
  }

  function score({pts,range}){
    const first=pts[0].value, last=pts[pts.length-1].value;
    const fAbn = first<range[0]||first>range[1];
    const lAbn = last<range[0]||last>range[1];
    const mid=(range[0]+range[1])/2;
    let s=0;
    if (fAbn&&lAbn) s+=3+Math.abs(Math.abs(last-mid)-Math.abs(first-mid))*2;
    else if (!fAbn&&lAbn) s+=5;
    else if (fAbn&&!lAbn) s+=2;
    s += pts.filter(p=>p.value<range[0]||p.value>range[1]).length;
    return s;
  }

  function shortNum(v){
    if (v===null||v===undefined) return '';
    if (Math.abs(v)>=100) return Math.round(v).toString();
    if (Math.abs(v)>=10) return v.toFixed(1);
    return v.toFixed(2).replace(/\.?0+$/,'');
  }

  function relDir(v,range){
    if (v<range[0]) return 'ниже';
    if (v>range[1]) return 'выше';
    return 'в пределах нормы';
  }

  function dynamicNarrative(t,pts,range){
    const first=pts[0].value, last=pts[pts.length-1].value;
    const fAbn = first<range[0]||first>range[1];
    const lAbn = last<range[0]||last>range[1];
    const tr = trend(pts);
    const dirWord = tr.delta>0?'вырос':'снизился';
    const pctTxt = Math.abs(tr.pct)>=5?` (${dirWord} на ${Math.round(Math.abs(tr.pct))}% от начального значения)`:'';
    // find notes between first and last
    const notes = pts.filter(p=>p.note).map(p=>`${(p.date||'').slice(5)} — «${escHtml(p.note)}»`).slice(-3);

    let txt = `Показатель ${pctTxt}: с ${shortNum(first)} до ${shortNum(last)} ${t.unit||''}. Сейчас ${relDir(last,range)} (норма ${fmt(range[0])}–${fmt(range[1])} ${t.unit||''}). `;
    if (fAbn && !lAbn) txt += '✅ Вошёл в норму — это признак эффективности проводимой терапии/диеты/коррекции образа жизни. Продолжайте под контролем врача.';
    else if (!fAbn && lAbn) txt += '⚠ Вышел за границы нормы. Это может быть связано с погрешностями в питании, стрессом, приёмом препаратов, обострением заболевания или присоединением новой проблемы. Стоит пересдать анализ и обратиться к профильному специалисту.';
    else if (fAbn && lAbn){
      const mid=(range[0]+range[1])/2;
      if (Math.abs(last-mid)<Math.abs(first-mid)) txt += 'Идёт улучшение в сторону нормы, но до полной нормализации ещё далеко. Обсудите с врачом коррекцию дозировок/диеты.';
      else txt += 'Состояние не улучшилось или усугубилось. Требуется очная консультация для пересмотра тактики лечения.';
    } else {
      txt += 'Держится в пределах референсных значений — хороший признак.';
    }
    if (notes.length) txt += '<br><b>События в этом периоде:</b> '+notes.join('; ')+'. Сравнивайте изменения с датами начала/изменения лечения — так видно, как те или иные назначения/диета влияют на общую картину.';
    return txt;
  }

  // Auto-restore last draft
  const draft = localStorage.getItem('budzdorov_draft');
  if (draft){
    try{
      const d = JSON.parse(draft);
      $('#patientName').value=d.patientName||'';
      $('#patientAge').value=d.patientAge||'';
      $('#patientSex').value=d.patientSex||'';
      if (d.date) $('#analysisDate').value=d.date;
      $('#ecgNotes').value=d.ecgNotes||'';
      ecgImages.length=0;
      (d.ecg||[]).forEach(e=>ecgImages.push(e));
      renderEcg();
      if (d.values){
        for (const k in d.values){
          const [gid,tid]=k.split('::');
          const row = rowForKey(gid,tid);
          if (row){
            $('.test-input',row).value = d.values[k];
            const g = ANALYSIS_GROUPS.find(g=>g.id===row.dataset.group);
            const t = g && g.tests.find(t=>t.id===tid);
            if (g&&t) evaluateRow(g,t,row);
          }
        }
      }
    }catch(e){}
  }
  setInterval(()=>{ try{ localStorage.setItem('budzdorov_draft',JSON.stringify(gatherData())); }catch(e){} },5000);

  // ---------- SEARCH ----------
  const searchInput = $('#searchInput');
  const clearSearchBtn = $('#clearSearch');
  searchInput.addEventListener('input', applySearch);
  clearSearchBtn.addEventListener('click',()=>{ searchInput.value=''; applySearch(); searchInput.focus(); });
  function applySearch(){
    const q = (searchInput.value||'').trim().toLowerCase();
    clearSearchBtn.classList.toggle('show', q.length>0);
    const groups = $$('.group-header');
    const rows = $$('.test-row');
    if (!q){ groups.forEach(g=>g.classList.remove('hidden')); rows.forEach(r=>r.classList.remove('hidden')); removeNoResults(); return; }
    let any=false;
    groups.forEach(gh=>{ gh.classList.add('hidden'); });
    const groupVisible={};
    rows.forEach(row=>{
      const gid=row.dataset.group, tid=row.dataset.test;
      const g = ANALYSIS_GROUPS.find(g=>g.id===gid); if(!g) return;
      const t = g.tests.find(t=>t.id===tid); if(!t) return;
      const hay = (t.name+' '+g.title).toLowerCase();
      if (hay.includes(q)){ row.classList.remove('hidden'); groupVisible[gid]=true; any=true; }
      else row.classList.add('hidden');
    });
    groups.forEach(gh=>{
      const gid = gh.nextElementSibling && gh.nextElementSibling.dataset ? gh.nextElementSibling.dataset.group : null;
      // iterate all group headers and toggle by next rows presence
    });
    // Simpler: toggle group headers that precede visible test-rows
    let el = $('#tab-analyses').firstChild;
    let currentGroup=null;
    while(el){
      if (el.classList && el.classList.contains('group-header')){
        currentGroup=el; currentGroup.classList.add('hidden');
      } else if (el.classList && el.classList.contains('test-row') && !el.classList.contains('hidden') && currentGroup){
        currentGroup.classList.remove('hidden');
      }
      el = el.nextSibling;
    }
    removeNoResults();
    if (!any){
      const nr=document.createElement('div');
      nr.className='no-results';
      nr.id='noResults';
      nr.innerHTML=`Ничего не найдено по запросу «${searchInput.value}».<br><small>Попробуйте ввести часть названия (например: «желез», «витамин д», «ттг», «холест», «моча бел»).</small>`;
      $('#tab-analyses').appendChild(nr);
    }
    // Update group counters
    $$('.group-header').forEach(gh=>{
      const cnt=$$(`.test-row[data-group="${gh.dataset.group}"]:not(.hidden)`).length;
      let sp = gh.querySelector('.count');
      if (!sp){ sp=document.createElement('span'); sp.className='count'; gh.appendChild(sp); }
      sp.textContent = q ? `${cnt} найдено` : '';
    });
  }
  function removeNoResults(){ const n=$('#noResults'); if(n) n.remove(); }

  // ---------- PIN LOCK ----------
  const PIN_KEY='budzdorov_pin';
  const pinLock=$('#pinLock');
  const pinInput=$('#pinInput');
  const pinTitle=$('#pinTitle');
  const pinHint=$('#pinHint');
  const pinError=$('#pinError');
  const pinSetPanel=$('#pinSetPanel');
  let unlocked=false;
  function isPinSet(){ return !!localStorage.getItem(PIN_KEY); }
  function lockApp(){
    unlocked=false;
    pinLock.classList.remove('hidden');
    pinInput.value=''; pinError.textContent='';
    setTimeout(()=>pinInput.focus(),100);
    pinTitle.textContent = isPinSet()?'Введите PIN-код':'Защита PIN-кодом';
    pinHint.textContent = isPinSet()?'PIN защищает доступ к вашим медицинским данным.':'PIN ещё не установлен. Нажмите «Установить/сменить PIN», чтобы защитить данные.';
  }
  function unlockApp(){ unlocked=true; pinLock.classList.add('hidden'); }
  // PIN храним как солёный SHA-256, а не открытым текстом; старые plaintext-записи
  // прозрачно мигрируют при первом успешном вводе.
  async function hashPin(pin){
    try{
      if (window.crypto && crypto.subtle && crypto.subtle.digest){
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('budzdorov.pin.v1::'+pin));
        return 'sha256:'+Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
      }
    }catch(e){}
    return 'plain:'+pin; // страховка для очень старых WebView без WebCrypto
  }
  async function checkPin(pin){
    const stored = localStorage.getItem(PIN_KEY);
    if (!stored) return false;
    if (stored.indexOf('sha256:')===0) return stored === await hashPin(pin);
    if (stored === pin){ localStorage.setItem(PIN_KEY, await hashPin(pin)); return true; } // миграция со старого формата
    return false;
  }
  $('#pinOk').addEventListener('click',async ()=>{
    if (!isPinSet()){ unlockApp(); return; }
    if (await checkPin(pinInput.value)){ pinError.textContent=''; unlockApp(); }
    else { pinError.textContent='Неверный PIN. Попробуйте ещё раз.'; pinInput.value=''; pinInput.focus(); }
  });
  pinInput.addEventListener('keydown',e=>{ if(e.key==='Enter') $('#pinOk').click(); });
  $('#pinSet').addEventListener('click',()=>{
    $('#newPin1').value=''; $('#newPin2').value=''; $('#pinSetErr').textContent='';
    pinSetPanel.classList.remove('hidden');
  });
  $('#closePinSet').addEventListener('click',()=>pinSetPanel.classList.add('hidden'));
  $('#pinSetCancel').addEventListener('click',()=>pinSetPanel.classList.add('hidden'));
  $('#pinSetSave').addEventListener('click',async ()=>{
    const p1=$('#newPin1').value, p2=$('#newPin2').value;
    if (p1===''){ localStorage.removeItem(PIN_KEY); pinSetPanel.classList.add('hidden'); alert('PIN отключён.'); unlockApp(); lockApp(); return; }
    if (!/^\d{4,6}$/.test(p1)){ $('#pinSetErr').textContent='PIN должен содержать 4–6 цифр.'; return; }
    if (p1!==p2){ $('#pinSetErr').textContent='PIN не совпадает.'; return; }
    localStorage.setItem(PIN_KEY, await hashPin(p1));
    pinSetPanel.classList.add('hidden');
    alert('PIN установлен.'); unlockApp(); lockApp();
  });
  // Lock after 2 minutes of inactivity (if PIN is set)
  let idleTimer=null;
  function resetIdle(){ if(idleTimer)clearTimeout(idleTimer); if(isPinSet()&&unlocked){ idleTimer=setTimeout(lockApp, 2*60*1000); } }
  ['click','touchstart','input','keydown'].forEach(ev=>document.addEventListener(ev,resetIdle,{passive:true}));
  if (isPinSet()) lockApp(); else unlockApp();

  // Add PIN setting in "About" tab — insert a button there
  const aboutCard = document.querySelector('.about-card');
  if (aboutCard){
    const pinBtn = document.createElement('button');
    pinBtn.className='btn'; pinBtn.textContent=isPinSet()?'🔑 Сменить/отключить PIN':'🔑 Установить PIN';
    pinBtn.addEventListener('click',()=>$('#pinSet').click());
    aboutCard.insertBefore(pinBtn, aboutCard.querySelector('.version'));
  }

  // ---------- ECG DECODE TAB (uses static DOM in #tab-ecg-decode) ----------
  const ecv = {
    img:null, canvas:null, ctx:null, scale:1, pxPerMm:null,
    mode:'idle', rotation:0,
    calibClicks:0, calibStart:null, calibEnd:null,
    rrPoints:[], measurePairs:[], pendingStart:null,
    cropStart:null, cropEnd:null, cropDrag:null,
    cropIndex:-1, cropMode:false, sourceDataUrl:null, autoData:null,
    _dragging:false, _pendingAuto:false,
    list:[], index:-1
  };
  const _ecvIdMap = {
    ecvCanvas:'ecvCanvasTab', ecvCanvasWrap:'ecvCanvasWrap', ecvDec:'ecvDecTab', ecvHint:'ecvHintTab',
    ecvMeasurements:'ecvMeasurementsTab', ecvPxmm:'ecvPxmmTab',
    ecvSpeed:'ecvSpeedTab', ecvMv:'ecvMvTab',
    ecvCrop:'ecvCropTab', ecvApplyCrop:'ecvApplyCropTab', ecvCancelCrop:'ecvCancelCropTab',
    ecvCalib:'ecvCalibTab', ecvAuto:'ecvAutoTab', ecvReport:'ecvReportTab', ecvReset:'ecvResetTab',
    ecvRR:'ecvRRTab', ecvMeasure:'ecvMeasureTab'
  };
  function ecvEl(id){ return document.getElementById(_ecvIdMap[id]||id); }
  function ecvShow(){ switchTab('ecg-decode'); }
  function ecvHide(){ ecv.mode='idle'; resetClicks(); }
  function resetClicks(){
    ecv.calibClicks=0; ecv.calibStart=null; ecv.calibEnd=null;
    ecv.rrPoints=[]; ecv.measurePairs=[]; ecv.pendingStart=null;
    ecv.cropStart=null; ecv.cropEnd=null; ecv.cropDrag=null;
    _pendingTapPick=false;
  }

  function setHint(t){ ecvEl('ecvHint').innerHTML=t; }

  // Auto-rotate lab form to portrait (header horizontal, columns vertical).
  // Lab analysis forms are ALWAYS portrait in normal reading orientation —
  // Cyrillic words like "Показатель", "Результат", "Единицы", "Референс" must be
  // readable left-to-right (not top-to-bottom on edge). Try 0/90/180/270 and
  // pick the rotation where horizontal lines ("ink bands" = printed rows) dominate,
  // Cyrillic keyword hits are highest, and aspect is portrait.
  function detectBestRotation(srcImg, opts){
    opts = opts||{};
    const mode = opts.mode || 'ecg'; // 'ecg' = landscape (leads horizontal, rhythm strip L→R); 'lab' = portrait (form upright)
    // Sample at max ~320px on the long side for better accuracy on tiny text
    const maxSide=320;
    function scoreRot(rot){
      const c=document.createElement('canvas');
      const w=srcImg.naturalWidth, h=srcImg.naturalHeight;
      let dw=w, dh=h;
      if(rot===90||rot===270){ dw=h; dh=w; }
      const s=Math.min(1, maxSide/Math.max(dw,dh));
      c.width=Math.round(dw*s); c.height=Math.round(dh*s);
      const ctx=c.getContext('2d');
      const cw=c.width, ch=c.height;
      ctx.save();
      ctx.translate(cw/2,ch/2);
      if(rot===90) ctx.rotate(Math.PI/2);
      else if(rot===180) ctx.rotate(Math.PI);
      else if(rot===270) ctx.rotate(-Math.PI/2);
      ctx.drawImage(srcImg,-w*s/2,-h*s/2,w*s,h*s);
      ctx.restore();
      const W=c.width, H=c.height;
      const d=ctx.getImageData(0,0,W,H).data;
      // Row mean darkness
      const rowMean=new Float32Array(H);
      for(let y=0;y<H;y++){
        let s=0;
        for(let x=0;x<W;x++){
          const i=(y*W+x)*4;
          s += (d[i]*0.8+d[i+1]*1.2+d[i+2]*1.2)/3;
        }
        rowMean[y]=s/W;
      }
      const sorted=[...rowMean].sort((a,b)=>a-b);
      const bg=sorted[Math.floor(H*0.3)];
      const thr=8;
      // Detect horizontal ink bands (rows/grid/text baselines)
      let hBands=0, inB=false, gap=0, bandRows=0, largest=0, curStart=0;
      for(let y=0;y<H;y++){
        const ink=(bg-rowMean[y])>thr;
        if(ink){ if(!inB){inB=true; curStart=y;} gap=0; bandRows++; }
        else {
          if(inB){
            gap++;
            if(gap>3){
              inB=false;
              const bh=y-gap-curStart;
              if(bh>=Math.max(2,H*0.015)){ hBands++; if(bh>largest)largest=bh; }
              gap=0;
            } else bandRows++;
          }
        }
      }
      if(inB){ const bh=H-curStart; if(bh>=Math.max(2,H*0.015)){ hBands++; if(bh>largest)largest=bh; } }
      // Coverage
      let colCount=0;
      for(let x=0;x<W;x+=4){
        let has=false;
        for(let y=0;y<H;y++){
          const i=(y*W+x)*4;
          if(bg-(d[i]*0.8+d[i+1]*1.2+d[i+2]*1.2)/3>thr){ has=true; break; }
        }
        if(has) colCount++;
      }
      const cov=colCount/Math.ceil(W/4);
      // Count word-like horizontal runs (short dark segments = printed Cyrillic/Latin words readable L→R)
      let wordHits=0;
      const stripY0=Math.floor(H*0.08), stripY1=Math.floor(H*0.92);
      for(let y=stripY0;y<stripY1;y+=2){
        let run=0;
        for(let x=0;x<W;x++){
          const i=(y*W+x)*4;
          const dark=(bg-(d[i]*0.8+d[i+1]*1.2+d[i+2]*1.2)/3)>thr*0.7;
          if(dark) run++; else { if(run>=3 && run<=35) wordHits++; run=0; }
        }
        if(run>=3 && run<=35) wordHits++;
      }
      return {rot, hBands, cov, bandFrac:bandRows/H, largest:largest/H, W, H, wordHits};
    }
    const a=[scoreRot(0), scoreRot(90), scoreRot(180), scoreRot(270)];
    a.forEach(r=>{
      if(mode==='lab'){
        // Lab form: PORTRAIT (H>W), many horizontal bands (table rows + text lines),
        // many word-like runs. Penalize landscape and upside-down.
        const portrait = r.H>r.W ? 1.0 : 0.2;
        const hBandScore = r.hBands>=8 ? Math.min(1, r.hBands/25) : r.hBands/10;
        const wordScore = Math.min(1, r.wordHits/400);
        r.score = hBandScore*5 + wordScore*4 + r.cov*3 + portrait*2;
        // Upside-down penalty: text is still readable but numbers/keywords will be flipped;
        // Tesseract can handle it but portrait with words on top wins over flipped portrait.
        if(r.rot===180) r.score *= 0.85;
      } else {
        // ECG: LANDSCAPE (W>H), 3..8 horizontal lead bands, wide coverage.
        const landscape = r.W>r.H ? 1.2 : 0.4;
        const idealBands = r.hBands>=3 && r.hBands<=8 ? 3 : Math.max(0,2-Math.abs(r.hBands-5)/3);
        const giantPenalty = r.largest>0.55 ? 4 : 0;
        r.score = idealBands*3 + r.cov*6 + landscape - Math.abs(r.bandFrac-0.5)*0.3 - giantPenalty;
      }
    });
    a.sort((x,y)=>y.score-x.score);
    return a[0].rot;
  }

  function drawRotated(srcImg, rot){
    const c=ecvEl('ecvCanvas'); const ctx=c.getContext('2d');
    ecv.canvas=c; ecv.ctx=ctx;
    // delegate to common base renderer
    ecv.img=srcImg; ecv.rotation=rot;
    ctx_clearAndDrawRotatedBase();
  }

  function loadEcgImage(dataUrl){
    const img = new Image();
    img.onload = ()=>{
      // Auto-detect rotation based on ink layout
      const rot = detectBestRotation(img);
      ecv.img=img; ecv.rotation=rot;
      requestAnimationFrame(()=>{
        drawRotated(img, rot);
        detectPxPerMmAuto();
        if (ecv._pendingAuto){
          setTimeout(()=>{ try{ autoAnalyze(); renderReport(); }catch(e){ console.warn(e);} }, 250);
        }
      });
    };
    img.src = dataUrl;
  }

  function updateEcgNav(){
    const prev=ecvEl('ecvPrev'), next=ecvEl('ecvNext'), lbl=ecvEl('ecvNavLabel');
    if(!prev||!next||!lbl) return;
    const n=ecv.list.length;
    const hasNav = n>1;
    prev.style.display = hasNav?'':'';
    next.style.display = hasNav?'':'';
    lbl.style.display = hasNav?'':'none';
    prev.disabled = ecv.index<=0;
    next.disabled = ecv.index>=n-1;
    prev.style.opacity = prev.disabled?'0.4':'1';
    next.style.opacity = next.disabled?'0.4':'1';
    lbl.textContent = n?`Скан ${ecv.index+1} из ${n}`:'';
  }
  function loadEcvIndex(i){
    if(!ecv.list.length) return;
    ecv.index = Math.max(0,Math.min(ecv.list.length-1,i));
    const it = ecv.list[ecv.index];
    resetClicks(); ecv.autoData=null; ecv.cropMode=false; ecv._pendingAuto=false;
    const applyBtn=ecvEl('ecvApplyCrop'),cancelBtn=ecvEl('ecvCancelCrop');
    if(applyBtn) applyBtn.style.display='none'; if(cancelBtn) cancelBtn.style.display='none';
    ecvEl('ecvDec').innerHTML='<b>📊 ЭКГ-анализатор:</b> загрузите плёнку, откалибруйте и нажмите «🤖 Автоанализ» или «📋 Расшифровать». <span style="color:#b3261e"><b>Важно:</b> не замена врача! Острую боль в груди — 103.</span>';
    setHint('Загружен скан '+(ecv.index+1)+' из '+ecv.list.length+'. Если изображение повернуто — используйте ↻ для поворота.');
    updateEcgNav();
    ecv.sourceDataUrl = it.dataUrl;
    loadEcgImage(it.dataUrl);
    ecv.mode='idle';
  }

  function drawCanvas(){
    if (!ecv.img) return;
    drawRotated(ecv.img, ecv.rotation||0);
    // First run autocalibration on the rotated (but NOT yet enhanced) canvas so grid detection sees the actual grid
    let autoPx=null;
    try{ detectPxPerMmAuto(); autoPx=ecv.pxPerMm; }catch(e){}
    // Then enhance the image: boost contrast, suppress pink/red grid, darken ink
    try{ enhanceCanvas(); }catch(e){ console.warn('enhance',e); }
    drawMarkers();
    // If pending auto, run analysis after the image is enhanced and calibrated
    if(ecv._pendingAuto){
      ecv._pendingAuto=false;
      setTimeout(()=>{
        try{
          if(ecv.pxPerMm && ecv.pxPerMm>1.5){
            setHint(`✅ Масштаб определён автоматически (${ecv.pxPerMm.toFixed(2)} px/мм). Запускаю анализ...`);
            autoAnalyze(); renderReport();
          } else {
            setHint('⚠ Не удалось автоматически определить масштаб по сетке. Поверните фото кнопкой ↻ так, чтобы полоски были горизонтальны, или нажмите «📐 Калибровать» и отметьте калибровочный квадрат вручную.');
          }
        }catch(e){ console.warn(e); }
      },200);
    }
  }

  function drawMarkers(){
    const ctx=ecv.ctx; if(!ctx) return;
    ctx.lineWidth=2;
    // Detected rhythm band (subtle outline so user sees what strip the analyzer picked)
    if (ecv.autoData && ecv.autoData.rhythmBand){
      const b=ecv.autoData.rhythmBand;
      ctx.save();
      ctx.strokeStyle='rgba(255,235,59,0.9)'; ctx.setLineDash([6,4]); ctx.lineWidth=2;
      ctx.strokeRect(2,b.y,ecv.canvas.width-4,b.h);
      ctx.setLineDash([]); ctx.restore();
    }
    // calibration segment
    if (ecv.calibStart && ecv.calibEnd){
      ctx.strokeStyle='#00e676'; ctx.beginPath();
      ctx.moveTo(ecv.calibStart.x,ecv.calibStart.y); ctx.lineTo(ecv.calibEnd.x,ecv.calibEnd.y); ctx.stroke();
      ctx.fillStyle='#00e676';
      [ecv.calibStart,ecv.calibEnd].forEach(p=>{ ctx.beginPath(); ctx.arc(p.x,p.y,5,0,Math.PI*2); ctx.fill(); });
    }
    // R peaks
    ctx.fillStyle='#ff5252';
    ecv.rrPoints.forEach(p=>{ ctx.beginPath(); ctx.arc(p.x,p.y,5,0,Math.PI*2); ctx.fill(); });
    ctx.strokeStyle='#ff5252'; ctx.beginPath();
    ecv.rrPoints.forEach((p,i)=>{ if(i===0) ctx.moveTo(p.x,p.y); else ctx.lineTo(p.x,p.y); }); ctx.stroke();
    // pending point
    if (ecv.pendingStart){ ctx.fillStyle='#ffeb3b'; ctx.beginPath(); ctx.arc(ecv.pendingStart.x,ecv.pendingStart.y,5,0,Math.PI*2); ctx.fill(); }
    // intervals
    ctx.strokeStyle='#40c4ff';
    ecv.measurePairs.forEach(pr=>{
      ctx.beginPath(); ctx.moveTo(pr.a.x,pr.a.y); ctx.lineTo(pr.b.x,pr.b.y); ctx.stroke();
      [pr.a,pr.b].forEach(p=>{ ctx.fillStyle='#40c4ff'; ctx.beginPath(); ctx.arc(p.x,p.y,4,0,Math.PI*2); ctx.fill(); });
    });
    // Crop overlay (dim outside selection)
    if (ecv.mode==='crop' && (ecv.cropStart || ecv.cropEnd)){
      const a = ecv.cropStart||ecv.cropDrag;
      const b = ecv.cropEnd  ||ecv.cropDrag;
      if (a && b){
        const x=Math.min(a.x,b.x), y=Math.min(a.y,b.y), w=Math.abs(b.x-a.x), h=Math.abs(b.y-a.y);
        ctx.save();
        ctx.fillStyle='rgba(0,0,0,0.55)';
        ctx.fillRect(0,0,ecv.canvas.width,y);
        ctx.fillRect(0,y+h,ecv.canvas.width,ecv.canvas.height-(y+h));
        ctx.fillRect(0,y,x,h);
        ctx.fillRect(x+w,y,ecv.canvas.width-(x+w),h);
        ctx.strokeStyle='#ffd600'; ctx.lineWidth=2; ctx.setLineDash([6,4]);
        ctx.strokeRect(x,y,w,h);
        ctx.setLineDash([]);
        // Handle corners
        ctx.fillStyle='#ffd600';
        [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([cx,cy])=>{ ctx.fillRect(cx-5,cy-5,10,10); });
        ctx.fillStyle='#fff'; ctx.font='bold 14px sans-serif';
        ctx.fillText(`Выделите область — отпустите палец и нажмите «✅ Применить обрезку»`, 10, y>20?y-8:y+h+18);
        ctx.restore();
      }
    }
  }

  function mmToSec(mm, speed){ return mm/speed; } // speed in mm/s
  function mmToMv(mm, mmPerMv){ return mm/mmPerMv; }

  function updateMeasurements(){
    const box = ecvEl('ecvMeasurements');
    const speed = parseInt(ecvEl('ecvSpeed').value,10);
    const mmPerMv = parseInt(ecvEl('ecvMv').value,10);
    const px = ecv.pxPerMm;
    let html = '';
    html += `<span>📏 px/мм: <b>${px?px.toFixed(2):'—'}</b></span>`;
    if (ecv.rrPoints.length>=2){
      // heart rate from R-R: measure in x-distance only (assuming horizontal rhythm strip)
      const xs = ecv.rrPoints.map(p=>p.x).sort((a,b)=>a-b);
      let sum=0, n=0;
      for(let i=1;i<xs.length;i++){ sum += xs[i]-xs[i-1]; n++; }
      const avgPx = sum/n;
      const avgMm = avgPx/px;
      const rrSec = mmToSec(avgMm,speed);
      const hr = Math.round(60/rrSec);
      html += ` | <span>❤️ ЧСС: <b style="color:${hr<60?'#ffb74d':hr>100?'#ff8a65':'#81c784'}">${hr}</b> уд/мин</span>`;
      html += ` <span style="color:#aaa">(ср. R-R ${rrSec.toFixed(2)}с)</span>`;
    }
    if (ecv.measurePairs.length){
      ecv.measurePairs.forEach((pr,i)=>{
        const dx = Math.abs(pr.b.x-pr.a.x)/px;
        const dy = Math.abs(pr.b.y-pr.a.y)/px;
        const sec = mmToSec(dx,speed);
        const mv = mmToMv(dy,mmPerMv);
        html += ` | <span>📐 Интервал ${i+1}: <b>${(sec*1000).toFixed(0)} мс</b> / ${mv.toFixed(2)} мВ</span>`;
      });
    }
    box.innerHTML = html;
  }

  function ensureCalibration(){
    if (ecv.pxPerMm && ecv.pxPerMm>1.5 && ecv.pxPerMm<80) return true;
    try{
      if (ecv.img && ecv.canvas && ecv.ctx && ecv.canvas.width>100){
        detectPxPerMmAuto();
        if (ecv.pxPerMm && ecv.pxPerMm>1.5 && ecv.pxPerMm<80){
          setHint(`✅ Масштаб определён автоматически по сетке: ${ecv.pxPerMm.toFixed(2)} px/мм.`);
          return true;
        }
      }
    }catch(e){ console.warn(e); }
    return false;
  }

  // ---- Auto-enhance: gently boost contrast, suppress pink/red grid (kept subtle so user still sees ECG) ----
  function getFilterSettings(){
    const tgl=document.getElementById('ecvEnhanceToggle');
    const enabled = !tgl || tgl.checked;
    const cntEl=document.getElementById('ecvContrast');
    const grdEl=document.getElementById('ecvGrid');
    const inkEl=document.getElementById('ecvInk');
    return {
      enabled,
      contrast: cntEl?parseFloat(cntEl.value):1.6,
      gridSuppress: grdEl?parseFloat(grdEl.value):0.7,
      inkStrength: inkEl?parseFloat(inkEl.value):3.2
    };
  }
  function enhanceCanvas(){
    const c=ecv.canvas, ctx=ecv.ctx; if(!c) return;
    const w=c.width, h=c.height;
    if(w<10||h<10) return;
    const f=getFilterSettings();
    if(!f.enabled) return; // no-op: show original (after drawRotated)
    const img = ctx.getImageData(0,0,w,h);
    const d=img.data;
    // Sample paper background color from the 3% brightest pixels
    const arr=new Array(w*h);
    for(let i=0;i<w*h;i++){
      const i4=i*4;
      arr[i]={i:i4, lum:0.299*d[i4]+0.587*d[i4+1]+0.114*d[i4+2], r:d[i4], g:d[i4+1], b:d[i4+2]};
    }
    arr.sort((a,b)=>b.lum-a.lum);
    let bgR=0,bgG=0,bgB=0;
    const nBg=Math.max(1,Math.floor(arr.length*0.03));
    for(let i=0;i<nBg;i++){bgR+=arr[i].r;bgG+=arr[i].g;bgB+=arr[i].b;}
    bgR/=nBg; bgG/=nBg; bgB/=nBg;
    // Dynamic threshold scales with contrast so slider has visible effect
    const inkThr = Math.max(6, 22/Math.max(0.5,f.contrast));
    const inkMax = Math.min(320, 50 + f.inkStrength*50);
    const gridMix = 1 - f.gridSuppress; // 0 = full cream (grid fully removed), 1 = original (no suppression)
    for(let i=0;i<d.length;i+=4){
      const r=d[i], g=d[i+1], b=d[i+2];
      const dG = Math.max(0,bgG-g);
      const dB = Math.max(0,bgB-b);
      const redness = r - Math.max(g,b);
      const ink = (0.5*dG + 0.7*dB) * f.contrast;
      let R,G,B;
      if (ink>inkThr && redness<30){
        // ink pixel: darken
        const v = Math.round(245 - Math.min(230, ink*f.inkStrength));
        R=v; G=v; B=Math.round(v*0.97);
        R=Math.max(0,Math.min(255,R)); G=Math.max(0,Math.min(255,G)); B=Math.max(0,Math.min(255,B));
      } else {
        // paper/grid: blend toward cream; blend factor controlled by gridSuppress
        const targetR = Math.min(r, Math.max(bgR-5, (g+b)/2 + 8));
        const baseR = gridMix*r + (1-gridMix)*targetR;
        R = Math.round(baseR*0.92 + bgR*0.08);
        G = Math.round(g*0.92 + bgG*0.08);
        B = Math.round((b*0.97+bgB*0.03)*0.9 + (bgB-6)*0.10);
        R=Math.max(0,Math.min(255,R)); G=Math.max(0,Math.min(255,G)); B=Math.max(0,Math.min(255,B));
      }
      d[i]=R; d[i+1]=G; d[i+2]=B;
    }
    ctx.putImageData(img,0,0);
  }
  function redrawEnhanceOnly(){
    if(!ecv.img||!ecv.canvas) return;
    // Always start from the rotated image drawn on a fresh canvas so toggling enhancement
    // or adjusting sliders doesn't leave stale markers/previous enhance on screen.
    ctx_clearAndDrawRotatedBase();
    detectPxPerMmAuto();
    enhanceCanvas();
    drawMarkers();
  }
  function ctx_clearAndDrawRotatedBase(){
    const c=ecv.canvas, ctx=ecv.ctx;
    if(!c||!ctx||!ecv.img) return;
    const w=ecv.img.naturalWidth, h=ecv.img.naturalHeight, rot=ecv.rotation||0;
    const dispW=(rot===90||rot===270)?h:w, dispH=(rot===90||rot===270)?w:h;
    const wrap=ecvEl('ecvCanvasWrap');
    let maxW=wrap.clientWidth; if(!maxW||maxW<50)maxW=window.innerWidth-16;
    const maxH=window.innerHeight*0.6;
    const ratio=Math.min(maxW/dispW,maxH/dispH,1)||1;
    const dW=Math.round(dispW*ratio),dH=Math.round(dispH*ratio);
    c.width=dW; c.height=dH; ecv.scale=ratio;
    ctx.fillStyle='#f5f1c4'; ctx.fillRect(0,0,dW,dH);
    ctx.save();
    ctx.translate(dW/2,dH/2);
    if(rot===90) ctx.rotate(Math.PI/2);
    else if(rot===180) ctx.rotate(Math.PI);
    else if(rot===270) ctx.rotate(-Math.PI/2);
    ctx.drawImage(ecv.img,-w*ratio/2,-h*ratio/2,w*ratio,h*ratio);
    ctx.restore();
  }

  // Robust grid-period detection using 1D autocorrelation + DFT peak picking
  function _estimatePeriod(arr){
    const n=arr.length;
    if(n<20) return null;
    // remove DC
    let mean=0; for(let i=0;i<n;i++) mean+=arr[i]; mean/=n;
    const x=new Float32Array(n); for(let i=0;i<n;i++) x[i]=arr[i]-mean;
    // Autocorrelation (unbiased)
    const maxLag = Math.min(Math.floor(n/2), 80);
    const ac = new Float32Array(maxLag+1);
    for(let lag=1;lag<=maxLag;lag++){
      let s=0,c=0;
      for(let i=0;i<n-lag;i++){ s+=x[i]*x[i+lag]; c++; }
      ac[lag]=s/c;
    }
    // Find first strong peak after trough (1mm small square)
    // Search 3..maxLag for a peak that's >0.35*max and has lower neighbors
    let maxV=0; for(let p=3;p<=maxLag;p++) if(ac[p]>maxV) maxV=ac[p];
    let bestPeriod=null, bestScore=0;
    for(let p=3;p<=maxLag-2;p++){
      if(ac[p]<=0) continue;
      if(ac[p]>ac[p-1] && ac[p]>=ac[p+1] && ac[p]>0.25*maxV){
        // Refine by checking neighbours: prefer peaks with stronger contrast vs surroundings
        const trough = Math.min(ac[Math.max(1,p-2)]||0, ac[Math.min(maxLag,p+2)]||0);
        const score = ac[p]-trough;
        if(score>bestScore){bestScore=score; bestPeriod=p;}
      }
    }
    if(!bestPeriod) return null;
    // Sub-pixel refinement via parabolic interpolation on ac[bestPeriod-1..bestPeriod+1]
    const y1=ac[bestPeriod-1]||0, y2=ac[bestPeriod], y3=ac[bestPeriod+1]||0;
    const denom = (y1 - 2*y2 + y3);
    const delta = denom!==0 ? 0.5*(y1-y3)/denom : 0;
    return {px: bestPeriod+delta, score:bestScore};
  }

  function detectPxPerMmAuto(){
    if (!ecv.img){ ecv.pxPerMm=null; updateMeasurements(); return; }
    try{
      const c=ecv.canvas, ctx=ecv.ctx; if(!c) return;
      const w=c.width, h=c.height;
      // Sample multiple strips (horizontal bands that look like clean paper with grid)
      const data = ctx.getImageData(0,0,w,h).data;
      // Build a darkness per row (mean blue-green channel darkness from paper)
      const rowDark=new Float32Array(h);
      for(let y=0;y<h;y++){
        let s=0;
        for(let x=0;x<w;x+=3){
          const i=(y*w+x)*4;
          // Use blue channel — it has most contrast against red grid, and black ink stays dark
          s+=255-data[i+2];
        }
        rowDark[y]=s/Math.ceil(w/3);
      }
      // Choose up to 6 strips where row darkness is low (background/grid area, not heavy ink)
      const strips=[];
      const stripH=Math.max(8,Math.round(h*0.06));
      const step=Math.max(4,Math.floor(stripH/2));
      for(let y=0;y+stripH<h;y+=step){
        let avg=0;
        for(let k=0;k<stripH;k++) avg+=rowDark[y+k];
        avg/=stripH;
        strips.push({y,avg});
      }
      strips.sort((a,b)=>a.avg-b.avg); // cleanest first
      let best=null, tried=0;
      for(const s of strips){
        if(tried>=8) break;
        tried++;
        const sy=s.y, sh=stripH;
        // Build vertical projection (per column) and horizontal projection (per row) in this strip
        // For small grid: both vertical and horizontal lines should repeat with period pxPerMm
        const colProj=new Float32Array(w);
        const rowProj=new Float32Array(sh);
        for(let y=0;y<sh;y++){
          let rs=0;
          for(let x=0;x<w;x++){
            const i=((sy+y)*w+x)*4;
            // dark blue channel = black ink or grid line
            const v = 255-data[i+2];
            colProj[x]+=v;
            rs+=v;
          }
          rowProj[y]=rs/w;
        }
        for(let x=0;x<w;x++) colProj[x]/=sh;
        const pH = _estimatePeriod(rowProj); // horizontal lines → vertical period = mm
        const pV = _estimatePeriod(colProj); // vertical lines → horizontal period = mm
        const p = pH && pV ? {px:(pH.px+pV.px)/2, score:(pH.score+pV.score)/2} : (pH||pV);
        if(!p) continue;
        // Sanity: 1 mm must correspond to a reasonable px count (between ~2px and ~60px on canvas)
        if(p.px<2 || p.px>60) continue;
        if(!best || p.score>best.score) best=p;
      }
      if(best && best.px>2 && best.px<60){
        ecv.pxPerMm = best.px;
        ecv._pxMmAuto = true;
      } else {
        ecv.pxPerMm = null;
      }
    }catch(e){ console.warn(e); ecv.pxPerMm=null; }
    const el=ecvEl('ecvPxmm'); if(el){
      el.textContent = ecv.pxPerMm ? `px/мм: ${ecv.pxPerMm.toFixed(2)} (авто по сетке)` : 'px/мм: не определён — нажмите 📐 Калибровать';
    }
    updateMeasurements();
  }

  function canvasPoint(evt){
    const rect = ecv.canvas.getBoundingClientRect();
    const x = (evt.clientX-rect.left)*(ecv.canvas.width/rect.width);
    const y = (evt.clientY-rect.top)*(ecv.canvas.height/rect.height);
    return {x,y};
  }

  function ecvClick(evt){
    if (!ecv.canvas) return;
    const p = canvasPoint(evt);
    if(_pendingTapPick){
      const b = selectBandAt(p.y);
      if(!b){ setHint('Не нашёл отведение в этом месте. Тапните по полоске с сигналом ЭКГ.'); return; }
      _pendingTapPick=false;
      const cv=ecvEl('ecvCanvas'); if(cv) cv.style.cursor='crosshair';
      ecv.manualBand={y:b.y,h:b.h};
      setHint('✓ Отведение выбрано вручную. Запускаю анализ...');
      try{ autoAnalyze(); renderReport(); }catch(e){ console.warn(e); setHint('Не удалось проанализировать эту полосу: '+e); }
      return;
    }
    if (ecv.mode==='calib'){
      if (ecv.calibClicks===0){ ecv.calibStart=p; ecv.calibClicks++; setHint('Теперь кликните на <b>второй конец</b> калибровочного прямоугольника (верхний угол 10 мм / 1 мВ).'); }
      else {
        ecv.calibEnd=p;
        // user should mark vertical segment of 10 mm (1 mV). Compute dy.
        const dy = Math.abs(ecv.calibEnd.y-ecv.calibStart.y);
        const dx = Math.abs(ecv.calibEnd.x-ecv.calibStart.x);
        let mmDist = 10; // 1 mV rectangle height
        if (dx>dy*2){ mmDist=5; } // horizontal = big square 5mm? assume they marked horizontally as 10 mm
        const px = Math.max(dx,dy);
        ecv.pxPerMm = px/mmDist;
        ecvEl('ecvPxmm').textContent = `px/мм: ${ecv.pxPerMm.toFixed(2)} (калибровка)`;
        ecv.mode='idle'; setHint('✅ Калибровка задана. Теперь можно считать ЧСС, измерять интервалы и запустить Автоанализ.');
        drawMarkers(); updateMeasurements();
      }
      drawMarkers();
      return;
    }
    if (ecv.mode==='rr'){
      ecv.rrPoints.push(p);
      if (ecv.rrPoints.length>=8){ setHint('Достаточно R-зубцов. ЧСС рассчитана. Для продолжения выберите другой инструмент или сбросьте точки.'); }
      else setHint(`Отмечено R-зубцов: ${ecv.rrPoints.length}. Отметьте последовательно 5–8 зубцов R на одном отведении.`);
      drawMarkers(); updateMeasurements();
      return;
    }
    if (ecv.mode==='measure'){
      if (!ecv.pendingStart){ ecv.pendingStart=p; setHint('Теперь кликните на <b>вторую точку</b> интервала.'); }
      else { ecv.measurePairs.push({a:ecv.pendingStart,b:p}); ecv.pendingStart=null; setHint('Интервал отмечен. Можно отметить ещё один или нажать «📋 Расшифровать».'); }
      drawMarkers(); updateMeasurements();
      return;
    }
    if (ecv.mode==='crop'){
      // single click — set start point and wait for drag end or second click
      if (!ecv.cropStart){ ecv.cropStart=p; ecv.cropEnd=null; setHint('Теперь перетащите до противоположного угла (или кликните во вторую точку) и нажмите «✅ Применить обрезку».'); }
      else { ecv.cropEnd=p; setHint('Область выделена. Нажмите «✅ Применить обрезку», чтобы сохранить обрезанное изображение.'); }
      drawMarkers();
    }
  }

  function ecvPointerDown(e){
    if (ecv.mode!=='crop') return;
    const t = e.touches?e.touches[0]:e;
    const p = canvasPoint(t);
    ecv.cropStart=p; ecv.cropEnd=null; ecv.cropDrag=p;
    ecv._dragging=true;
    drawMarkers();
    e.preventDefault();
  }
  function ecvPointerMove(e){
    if (ecv.mode!=='crop' || !ecv._dragging) return;
    const t = e.touches?e.touches[0]:e;
    ecv.cropDrag = canvasPoint(t);
    // redraw image + crop overlay
    if (ecv.ctx){
      ecv.ctx.drawImage(ecv.img,0,0,ecv.canvas.width,ecv.canvas.height);
      ecv.cropEnd = ecv.cropDrag;
      drawMarkers();
    }
    e.preventDefault();
  }
  function ecvPointerUp(e){
    if (ecv.mode!=='crop' || !ecv._dragging) return;
    ecv._dragging=false;
    if (ecv.cropDrag){ ecv.cropEnd=ecv.cropDrag; }
    setHint('Область выделена. Нажмите «✅ Применить обрезку» или перевыделите.');
    drawMarkers();
  }

  function applyCrop(){
    if (!ecv.cropStart || !ecv.cropEnd){ alert('Сначала выделите область обрезки (нажмите и протяните).'); return; }
    const r = (v,max)=>Math.max(0,Math.min(max,v));
    // Crop from the displayed (possibly rotated) canvas so coordinates are always in view space.
    const disp = ecv.canvas;
    const sx = r(Math.min(ecv.cropStart.x,ecv.cropEnd.x), disp.width);
    const sy = r(Math.min(ecv.cropStart.y,ecv.cropEnd.y), disp.height);
    const sw = r(Math.abs(ecv.cropEnd.x-ecv.cropStart.x), disp.width-sx);
    const sh = r(Math.abs(ecv.cropEnd.y-ecv.cropStart.y), disp.height-sy);
    if (sw<10 || sh<10){ alert('Слишком маленькая область. Выделите участок крупнее.'); return; }
    const tmp = document.createElement('canvas');
    tmp.width=Math.round(sw); tmp.height=Math.round(sh);
    const tctx=tmp.getContext('2d');
    tctx.drawImage(disp, sx, sy, sw, sh, 0, 0, tmp.width, tmp.height);
    const dataUrl = tmp.toDataURL('image/jpeg', 0.92);
    // replace current image in list & reset rotation (cropped image is already correctly oriented)
    if (ecv.list[ecv.index]){
      ecv.list[ecv.index].dataUrl = dataUrl;
      // also update ecgImages if that's the same list
      if (ecv.cropIndex>=0 && ecgImages[ecv.cropIndex]) ecgImages[ecv.cropIndex].dataUrl=dataUrl;
    }
    renderEcg();
    ecv.sourceDataUrl=dataUrl;
    resetClicks(); ecv.cropStart=null; ecv.cropEnd=null;
    ecv.mode='idle'; ecv.cropMode=false; ecv.rotation=0;
    const ab=ecvEl('ecvApplyCrop'),cb=ecvEl('ecvCancelCrop');
    if(ab)ab.style.display='none'; if(cb)cb.style.display='none';
    // Force fresh orientation detection on the cropped image
    const img=new Image();
    img.onload=()=>{ ecv.img=img; ecv.rotation=detectBestRotation(img); drawCanvas(); detectPxPerMmAuto(); setHint('✅ Обрезка применена. Теперь нажмите «🤖 Автоанализ».'); };
    img.src=dataUrl;
  }

  function cancelCrop(){
    if (ecv.cropIndex>=0){
      ecvHide();
    } else {
      // revert to original image
      if (ecv.sourceDataUrl && ecv.sourceDataUrl!==(ecv.img?ecv.img.src:'')){
        loadEcgImage(ecv.sourceDataUrl);
      }
      resetClicks();
      ecv.mode='idle'; ecv.cropMode=false;
      ecvEl('ecvApplyCrop').style.display='none';
      ecvEl('ecvCancelCrop').style.display='none';
      setHint('Обрезка отменена.');
    }
  }

  // ---------- Robust ECG signal extraction (trace per column across multiple bands) ----------
  // Scans the image vertically for the darkest ECG trace, compensating for pink/red grid lines.
  // Returns an array of {y, strength} (trace Y per x) plus info about the chosen band.
  function extractTrace(bandY, bandH){
    const c=ecv.canvas, ctx=ecv.ctx;
    const w=c.width;
    const img = ctx.getImageData(0,bandY,w,bandH).data;
    // For each column x, find the pixel with the strongest "ECG ink" score.
    // ECG ink is black or dark blue; pink/red grid has high R and is rejected via strong R-channel penalty.
    const trace = new Float32Array(w);
    const strength = new Float32Array(w);
    const blkWin = 4;
    for(let x=0;x<w;x++){
      let bestScore=Infinity, bestY=bandH/2;
      for(let y=2;y<bandH-2;y++){
        // Sample 3x3 neighborhood for robustness
        let sc=0,n=0;
        for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
          const xx=Math.min(w-1,Math.max(0,x+dx)), yy=Math.min(bandH-1,Math.max(0,y+dy));
          const i=(yy*w+xx)*4;
          const r=img[i], g=img[i+1], b=img[i+2];
          // Black ink → all channels low. Blue ink → R high? no: blue ink = B high, R/G low.
          // Red grid → R high, G moderate, B low/mid. So penalty = max(0, r - (g+b)/2) which is big on red.
          const redPenalty = Math.max(0, r - (g+b)*0.55);
          const s = (r*0.6 + g*1.1 + b*1.1) + redPenalty*1.2;
          sc+=s; n++;
        }
        sc/=n;
        if(sc<bestScore){bestScore=sc; bestY=y;}
      }
      trace[x]=bestY; strength[x]=bestScore;
    }
    // Combined median+mean smoothing to remove isolated grid-pin jumps
    const sm = new Float32Array(w);
    for(let x=0;x<w;x++){
      const win=[];
      for(let k=-blkWin;k<=blkWin;k++){ const xx=x+k; if(xx>=0&&xx<w) win.push(trace[xx]); }
      win.sort((a,b)=>a-b);
      // median
      const med = win[Math.floor(win.length/2)];
      let s=0,n=0;
      for(let k=-blkWin;k<=blkWin;k++){ const xx=x+k; if(xx>=0&&xx<w){ const v=trace[xx]; if(Math.abs(v-med)<3){ s+=v;n++; } } }
      sm[x] = n>0 ? s/n : med;
    }
    return {trace:sm, strength, bandY, bandH};
  }

  // Detect the rhythm strip (longest lead band) by splitting the canvas into horizontal
  // "darkness rows" and finding contiguous bands that contain ink (non-background).
  function detectLeadBands(srcCanvas){
    const c = srcCanvas || ecv.canvas;
    const ctx = c && c.getContext ? c.getContext('2d') : ecv.ctx;
    const w=c.width, h=c.height;
    if(!c||!ctx||w<10||h<10) return [];
    const img=ctx.getImageData(0,0,w,h).data;
    // Ignore generous top/bottom edges (paper borders, header/date/footer text, calibration marks)
    const edge = Math.max(12, Math.round(h*0.06));
    const rowDark=new Float32Array(h);
    for(let y=0;y<h;y++){
      let s=0,n=0;
      for(let x=0;x<w;x+=4){
        const i=(y*w+x)*4;
        const dr=255-img[i], dg=255-img[i+1], db=255-img[i+2];
        // ECG ink is black/blue — weight G+B heavily, discount pure-red pink grid lines.
        s+=(dr*0.25+dg*0.8+db*0.95)/2;
        n++;
      }
      rowDark[y]=s/n;
    }
    // Row-by-row variance across columns — lead strips have high column-to-column variance
    // (tall QRS spikes make some columns very dark, some not), while text/headers have
    // fairly uniform darkness across the row, so they get scored lower.
    const rowVar=new Float32Array(h);
    for(let y=0;y<h;y++){
      let s=0,s2=0,n=0;
      for(let x=0;x<w;x+=4){
        const i=(y*w+x)*4;
        const v=0.25*(255-img[i])+0.8*(255-img[i+1])+0.95*(255-img[i+2]);
        s+=v; s2+=v*v; n++;
      }
      const m=s/n; rowVar[y]=Math.max(0,s2/n - m*m);
    }
    const sorted=[...rowDark].sort((a,b)=>a-b);
    const bg = sorted[Math.floor(h*0.35)];
    // Adaptive threshold with higher floor so light text/grid doesn't trigger
    const thr=Math.max(10, bg*0.08);
    const gapTol=Math.max(4,Math.round(h*0.015));
    // Lead bands are typically 5%–18% of canvas height (in 6-lead fragment each lead is ~7–12%;
    // a long rhythm II strip can be up to ~22%, but never less than 4%).
    const minH=Math.max(18,h*0.05);
    const maxH=Math.floor(h*0.22);
    // Build a signal score per row that combines darkness AND variance.
    const rowScore=new Float32Array(h);
    for(let y=0;y<h;y++){ rowScore[y]=Math.max(0,bg-rowDark[y]) + Math.sqrt(rowVar[y])*0.4; }
    const sortedS=[...rowScore].sort((a,b)=>a-b);
    const sBg = sortedS[Math.floor(h*0.3)];
    const sThr = Math.max(thr*0.6, (sortedS[Math.floor(h*0.8)]-sBg)*0.15);
    const bands=[];
    let inB=false, start=0, gap=0;
    for(let y=edge;y<h-edge;y++){
      const isInk = rowScore[y]>sBg+sThr;
      if(isInk){ if(!inB){start=y;inB=true;} gap=0; }
      else if(inB){
        gap++;
        if(gap>gapTol){
          const bh=y-gap-start;
          if(bh>=minH && bh<=maxH) bands.push({y:start,h:bh});
          inB=false; gap=0;
        }
      }
    }
    if(inB){ const bh=h-edge-start; if(bh>=minH && bh<=maxH) bands.push({y:start,h:bh}); }
    // Merge nearby bands separated only by small gaps (e.g., two halves of same lead)
    const merged=[];
    bands.forEach(b=>{
      if(merged.length && b.y-(merged[merged.length-1].y+merged[merged.length-1].h)<gapTol){
        const newH=(b.y+b.h)-merged[merged.length-1].y;
        if(newH<=maxH*1.15) merged[merged.length-1].h=newH;
        else merged.push({...b});
      } else merged.push({...b});
    });
    merged.forEach(b=>{
      let cols=0, strong=0, stride=Math.max(3,Math.floor(w/220));
      let colMinDark=1e9, colMaxDark=-1;
      for(let x=0;x<w;x+=stride){
        let colBest=0;
        for(let y=b.y;y<b.y+b.h;y++){
          const i=(y*w+x)*4;
          const dG=255-img[i+1], dB=255-img[i+2], dR=255-img[i];
          const score=0.5*dG+0.7*dB - Math.max(0,dR-dG)*0.35;
          if(score>colBest) colBest=score;
        }
        if(colBest>thr){ cols++; if(colBest>thr*2) strong++; }
        if(colBest<colMinDark) colMinDark=colBest;
        if(colBest>colMaxDark) colMaxDark=colBest;
      }
      const totalCols=Math.max(1,Math.ceil(w/stride));
      b.coverage=cols/totalCols;
      b.strong=strong/totalCols;
      // Span: big difference between darkest and lightest column = spiky QRS shape (good ECG lead)
      b.span=Math.max(0,(colMaxDark-colMinDark));
      let inkSum=0,varSum=0;
      for(let y=b.y;y<b.y+b.h;y++){ inkSum+=Math.max(0,bg-rowDark[y]); varSum+=rowVar[y]; }
      b.ink=inkSum; b.varSum=varSum;
      b.w=w; b.x=0;
    });
    // ============ ECG-SPECIFIC band validation: extract a quick trace and look for periodic spikes ============
    // True ECG leads MUST:
    //   (a) have an extractable trace with decent coverage,
    //   (b) show at least 3 sharp spikes (candidate QRS complexes) with R-R distances
    //       within a physiologic HR range (HR 30..240),
    //   (c) have a span (vertical peak-to-peak) comparable to typical QRS amplitude (>1mm),
    //   (d) not be too concentrated in narrow horizontal stripes (text looks like short black runs, not a continuous wave).
    // This filters out: header text (ФИО, дата, название клиники), calibration pulses, footer names, grid artifacts.
    const W = w, H = h;
    const pxMm = ecv.pxPerMm || (h/120); // rough fallback: assume ~120mm tall
    const validBands = [];
    for(const b of merged){
      // Cheap rejection before expensive trace extraction:
      if(b.coverage<0.25) continue;                      // too little ink across columns
      if(b.strong<0.05 && b.span<thr*2.5) continue;     // no strong dark points anywhere
      if(b.h<Math.max(14,pxMm*4)) continue;             // band too short for QRS+baseline

      // Extract quick preview trace using simplified column-min (subsample every 2px for speed)
      const bw=b.w, bh=b.h, by=b.y;
      const ss=2;
      const sw=Math.ceil(bw/ss);
      const tr=new Float32Array(sw);
      for(let xi=0;xi<sw;xi++){
        const x=xi*ss;
        let minSc=1e9, my=bh/2;
        for(let y=2;y<bh-2;y++){
          const i=((by+y)*W+x)*4;
          const r=img[i],g=img[i+1],bl=img[i+2];
          const sc=(r*0.7 + g*1.2 + bl*1.2)/3;
          if(sc<minSc){ minSc=sc; my=y; }
        }
        tr[xi]=my;
      }
      // 3-px boxcar smooth
      const sm=new Float32Array(sw);
      for(let i=0;i<sw;i++){
        let s=0,n=0;
        for(let k=-2;k<=2;k++){ const j=i+k; if(j>=0&&j<sw){s+=tr[j];n++;} }
        sm[i]=s/n;
      }
      // Baseline = 35th percentile of trace (signal hovers around baseline, QRS deflects downward in y-terms? ink is darker)
      const sorted=[...sm].sort((a,b)=>a-b);
      const baseline = sorted[Math.floor(sw*0.5)];
      // Peak detection: deflection from baseline exceeding 1 mm (pxMm px), with refractory ~200ms (speed*0.2 mm)
      const minPeakPx = Math.max(3, pxMm*0.8);      // 0.8 mm of vertical deflection = smallest QRS
      const refractory = Math.max(12, Math.floor(sw*0.15/sw*(sw)));
      // Compute in subsampled space: 25mm/s → at ss=2 px, 1mm = pxMm/ss pixels; refractory at HR=240 is 250ms ≈ 6mm
      const refrX = Math.max(10, Math.floor(6*pxMm/ss));
      let peaks=0;
      let lastPeak=-refrX;
      const rrDists=[];
      for(let i=3;i<sw-3;i++){
        // negative deflection in y (ink rises upward) from baseline means an upward spike.
        // In trace[y-coordinate], darker pixel that moves UP is smaller y; compute deviation:
        const dev = baseline - sm[i];
        if(dev > minPeakPx && i-lastPeak>refrX){
          // Make sure it's a local peak (surrounding is smaller)
          let isPeak=true;
          for(let k=-3;k<=3;k++){ if(k===0) continue; if(baseline-sm[i+k] > dev+0.5){ isPeak=false; break; } }
          if(isPeak){
            peaks++;
            if(lastPeak>=0) rrDists.push((i-lastPeak)*ss);
            lastPeak=i;
          }
        }
      }
      // Vertical span check: p5-p95 span of trace should be >= 1.5mm for a real ECG; text/headers are flatter.
      const p5=sorted[Math.floor(sw*0.05)], p95=sorted[Math.floor(sw*0.95)];
      const verticalSpan = Math.abs(p95-p5);

      // R-R regularity: median RR / IQR should be < 0.5 (i.e., some regularity; otherwise random noise/text)
      let rrRegular = false;
      let hr = 0;
      if(rrDists.length>=2){
        const rs=rrDists.slice().sort((a,b)=>a-b);
        const med=rs[Math.floor(rs.length/2)];
        const speedPxPerSec = 25*pxMm; // mm/s * px/mm
        if(med>0){
          hr = Math.round(60*speedPxPerSec/med);
          rrRegular = (hr>=30 && hr<=240);
        }
      }
      // Score the band with ECG-specific bonuses/penalties
      const ecgShape = (verticalSpan>pxMm*1.2 ? 1.5 : (verticalSpan>pxMm*0.6?1:0.3));
      const ecgPeaks = peaks>=3 ? (rrRegular?2.0:1.0) : 0.1;
      const cy=b.y+b.h/2;
      const lowerBonus = cy>h*0.55 ? 1.25 : (cy>h*0.4 ? 1.05 : 0.85);
      const heightBonus = (b.h/h>0.055 && b.h/h<0.18) ? 1.25 : 0.8;
      const varianceScore = Math.sqrt(b.varSum/Math.max(1,b.h))*0.04;
      b.ecgPeaks = peaks;
      b.ecgSpan = verticalSpan;
      b.ecgHR = hr;
      b.ecgRegular = rrRegular;
      b.score = b.coverage*b.ink*lowerBonus*heightBonus*(0.5+b.strong)*(0.6+b.span*0.015)*(0.6+varianceScore)*Math.min(b.h,140)*ecgShape*ecgPeaks;
      if(peaks>=2 && b.coverage>=0.3) validBands.push(b);
    }
    // If ECG-specific filter rejected everything (odd photo, low contrast), fall back to all merged bands
    const finalBands = validBands.length>=1 ? validBands : merged;
    // Discard any band whose height is less than half the median band height (artifact slivers)
    if(finalBands.length>=3){
      const hs=finalBands.map(b=>b.h).sort((a,b)=>a-b);
      const med=hs[Math.floor(hs.length/2)];
      for(let i=finalBands.length-1;i>=0;i--){ if(finalBands[i].h<med*0.55) finalBands.splice(i,1); }
    }
    return finalBands;
  }

  function selectBandAt(cy){
    const bands=detectLeadBands();
    let hit=null;
    bands.forEach(b=>{ if(cy>=b.y&&cy<=b.y+b.h) hit=b; });
    if(!hit){
      let best=null,bd=1e9;
      bands.forEach(b=>{
        const d=Math.min(Math.abs(cy-b.y),Math.abs(cy-(b.y+b.h)));
        if(d<bd){bd=d;best=b;}
      });
      hit=best;
    }
    return hit;
  }
  let _pendingTapPick=false;
  function setTapPickHint(on){
    _pendingTapPick=!!on;
    const cv=ecvEl('ecvCanvas');
    if(cv) cv.style.cursor = on?'pointer':'crosshair';
    if(on) setHint('👆 Тапните пальцем по длинной ритм-полосе (обычно это отведение II в самом низу плёнки) — анализ пойдёт по ней. Остальные полоски будут использоваться для справки.');
  }

  // ---------- Fullscreen landscape lead picker ----------
  let _fsPick = {open:false, selectedBand:null, baseScale:1, zoom:1, tx:0, ty:0, canvasW:0, canvasH:0, viewW:0, viewH:0, portrait:false};
  function _fsApplyTransform(){
    const cvs=$('#fsCanvas'); if(!cvs) return;
    const s=_fsPick.baseScale*_fsPick.zoom;
    cvs.style.transform = `translate(${_fsPick.tx}px,${_fsPick.ty}px) scale(${s})`;
  }
  function _fsClampPan(animate){
    const v=$('#fsViewport'); if(!v) return;
    const s=_fsPick.baseScale*_fsPick.zoom;
    const cw=_fsPick.canvasW*s, ch=_fsPick.canvasH*s;
    const vw=v.clientWidth, vh=v.clientHeight;
    // Allow pan to pull content in; keep at least 20 px of content visible
    const minX = cw<vw ? (vw-cw)/2 : vw - cw - Math.min(80, vw*0.3);
    const maxX = cw<vw ? (vw-cw)/2 : Math.min(80, vw*0.3);
    const minY = ch<vh ? (vh-ch)/2 : vh - ch - Math.min(80, vh*0.3);
    const maxY = ch<vh ? (vh-ch)/2 : Math.min(80, vh*0.3);
    _fsPick.tx=Math.max(minX,Math.min(maxX,_fsPick.tx));
    _fsPick.ty=Math.max(minY,Math.min(maxY,_fsPick.ty));
    if(animate){
      const cvs=$('#fsCanvas');
      cvs.style.transition='transform .18s ease-out';
      _fsApplyTransform();
      setTimeout(()=>{cvs.style.transition='';},200);
    } else _fsApplyTransform();
    fsUpdateHighlight();
  }
  function fsSetZoom(newZoom, centerClientX, centerClientY){
    const v=$('#fsViewport'); if(!v) return;
    const oldS = _fsPick.baseScale*_fsPick.zoom;
    const newZoomC = Math.max(0.5, Math.min(8, newZoom));
    const newS = _fsPick.baseScale*newZoomC;
    // If center provided, keep that canvas point under the finger (like pinch-zoom).
    if(centerClientX!=null){
      const vr=v.getBoundingClientRect();
      const cx=centerClientX-vr.left, cy=centerClientY-vr.top;
      // canvas point currently under the center
      const sx=(cx-_fsPick.tx)/oldS, sy=(cy-_fsPick.ty)/oldS;
      _fsPick.zoom=newZoomC;
      _fsPick.tx=cx-sx*newS; _fsPick.ty=cy-sy*newS;
    } else {
      _fsPick.zoom=newZoomC;
    }
    _fsClampPan(false);
  }
  function fsZoomFit(){
    const sw=_fsPick.srcW, sh=_fsPick.srcH;
    const v=$('#fsViewport');
    _fsPick.viewW=v.clientWidth; _fsPick.viewH=v.clientHeight;
    // Use full viewport (allow up to 4x upscale when image is small)
    _fsPick.baseScale = Math.min(_fsPick.viewW/sw, _fsPick.viewH/sh, 4);
    _fsPick.zoom=1;
    const s=_fsPick.baseScale;
    _fsPick.tx = (_fsPick.viewW - sw*s)/2;
    _fsPick.ty = (_fsPick.viewH - sh*s)/2;
    _fsApplyTransform(); fsUpdateHighlight();
  }
  function _drawRotatedToCanvas(c, img, rot, ratio){
    const w=img.naturalWidth||img.width, h=img.naturalHeight||img.height;
    const dispW=(rot===90||rot===270)?h:w, dispH=(rot===90||rot===270)?w:h;
    const dW=Math.max(1,Math.round(dispW*ratio)), dH=Math.max(1,Math.round(dispH*ratio));
    c.width=dW; c.height=dH;
    const ctx=c.getContext('2d');
    ctx.fillStyle='#f5f1c4'; ctx.fillRect(0,0,dW,dH);
    ctx.save(); ctx.translate(dW/2,dH/2);
    if(rot===90) ctx.rotate(Math.PI/2);
    else if(rot===180) ctx.rotate(Math.PI);
    else if(rot===270) ctx.rotate(-Math.PI/2);
    ctx.drawImage(img,-w*ratio/2,-h*ratio/2,w*ratio,h*ratio);
    ctx.restore();
    return {w:dW,h:dH};
  }
  function openFullscreenPicker(){
    if(!ecv.img){ setHint('Сначала загрузите изображение ЭКГ.'); return; }
    if(!ecv.canvas){ drawCanvas(); }
    const overlay=$('#fsPicker'); if(!overlay) return;
    const cvs=$('#fsCanvas'); const ctx=cvs.getContext('2d');
    const portrait = window.innerHeight>window.innerWidth;
    overlay.style.display='flex';
    document.body.style.overflow='hidden';
    // Always show the CURRENT (possibly enhanced) canvas so user sees the same image they've been looking at
    const src=ecv.canvas; const sw=src.width, sh=src.height;
    cvs.width=sw; cvs.height=sh;
    ctx.fillStyle='#f5f1c4'; ctx.fillRect(0,0,sw,sh);
    ctx.drawImage(src,0,0,sw,sh);
    // But DETECT lead bands on an UNENHANCED rotated original,
    // because aggressive binarization shaves ECG lines down to 1px and breaks height thresholds.
    // Use a higher-res rendering (up to 1400px wide) for detection robustness on small thumbnails.
    const cleanCvs=document.createElement('canvas');
    const rot=ecv.rotation||0;
    const iw=ecv.img.naturalWidth||ecv.img.width, ih=ecv.img.naturalHeight||ecv.img.height;
    const dispW=(rot===90||rot===270)?ih:iw, dispH=(rot===90||rot===270)?iw:ih;
    const detectRatio = Math.min(1400/dispW, 1);
    _drawRotatedToCanvas(cleanCvs, ecv.img, rot, detectRatio);
    let bands=detectLeadBands(cleanCvs);
    // Scale detected bands back to displayed canvas coords if detection was done at higher res
    if(cleanCvs.width!==sw || cleanCvs.height!==sh){
      const sx=sw/cleanCvs.width, sy=sh/cleanCvs.height;
      bands = bands.map(b=>({
        y:Math.round(b.y*sy), h:Math.max(8,Math.round(b.h*sy)),
        w:sw, x:0,
        coverage:b.coverage, strong:b.strong, ink:b.ink*sy, score:b.score,
        span:b.span, varSum:b.varSum*sy
      }));
    }
    _fsPick.bands=bands;
    try{
      ctx.save(); ctx.globalAlpha=0.15; ctx.fillStyle='#ffeb3b';
      bands.forEach(b=>{ ctx.fillRect(0,b.y,sw,b.h); });
      ctx.restore();
    }catch(e){}
    let autoBand=null;
    {
      // require decent height AND column coverage AND variance — these are real ECG leads, not text/slivers
      const minReasonable = Math.max(20, Math.round(sh*0.055));
      const cands = (bands||[]).filter(b=>
        b.coverage>0.25 &&
        b.strong>0.08 &&
        b.h>=minReasonable && b.h<=sh*0.22
      );
      const list = cands.length?cands:(bands||[]).filter(b=>b.coverage>0.15 && b.h>=minReasonable);
      if(list.length){
        // Prefer a band in the lower half with best score — but only if its height/coverage look like a lead.
        // Avoid picking a tiny artifact strip sitting BELOW the last real lead.
        const lower = list.filter(b=>b.y+b.h/2>sh*0.42 && b.h>=Math.max(22,sh*0.06));
        const pool = lower.length?lower:list;
        autoBand = pool.reduce((a,b)=>b.score>a.score?b:a,pool[0]);
        // Sanity: if best "lower" band is tiny (<40% the height of the median band) and there's a tall band
        // right above it, pick the tall one instead.
        const medH = list.map(b=>b.h).sort((a,b)=>a-b)[Math.floor(list.length/2)];
        if(autoBand && autoBand.h<medH*0.6 && medH>=minReasonable){
          const taller = list.filter(b=>b.h>=medH*0.85);
          if(taller.length) autoBand = taller.reduce((a,b)=>b.score>a.score?b:a,taller[0]);
        }
      }
      else if(bands&&bands.length){ autoBand = bands.reduce((a,b)=>b.h>a.h?b:a,bands[0]); }
      else { autoBand = {y:Math.floor(sh*0.68),h:Math.floor(sh*0.16),w:sw,x:0}; }
    }
    _fsPick={open:true,selectedBand:autoBand,baseScale:1,zoom:1,tx:0,ty:0,canvasW:sw,canvasH:sh,srcW:sw,srcH:sh,viewW:0,viewH:0,portrait:false,bands,drag:null};
    $('#fsBandHl').style.display='none';
    const rh=$('#fsRotateHint');
    if(rh){
      rh.style.display = portrait?'':'none';
      rh.textContent = '📱 Поверните телефон горизонтально — плёнка видна целиком';
    }
    requestAnimationFrame(()=>{ fsZoomFit(); fsUpdateHighlight(); });
  }
  function closeFullscreenPicker(){
    const overlay=$('#fsPicker'); if(!overlay) return;
    overlay.style.display='none';
    _fsPick.open=false; _fsPick.drag=null;
    document.body.style.overflow='';
  }
  function fsCanvasPoint(clientX, clientY){
    const cvs=$('#fsCanvas'); const r=cvs.getBoundingClientRect();
    const px = (clientX-r.left)/r.width  * cvs.width;
    const py = (clientY-r.top) /r.height * cvs.height;
    return {x:px, y:py};
  }
  function fsUpdateHighlight(){
    if(!_fsPick.open) return;
    const hl=$('#fsBandHl'); if(!hl) return;
    const hit=_fsPick.selectedBand;
    const lbl=$('#fsSelLabel');
    if(!hit){ hl.style.display='none'; if(lbl) lbl.textContent='(ничего не выбрано — тапните по полосе или нажмите «↓ Полоса II»)'; return; }
    const cvs=$('#fsCanvas'); const cr=cvs.getBoundingClientRect();
    const v=$('#fsStage').getBoundingClientRect();
    const s=_fsPick.baseScale*_fsPick.zoom;
    const bx = (hit.x||0)*s, by = hit.y*s, bw = ((hit.w||_fsPick.canvasW))*s, bh=hit.h*s;
    hl.style.display='block';
    hl.style.left=(cr.left-v.left + bx -2)+'px';
    hl.style.top =(cr.top -v.top + by -2)+'px';
    hl.style.width=(bw+4)+'px';
    hl.style.height=(bh+4)+'px';
    if(lbl){
      const cy = hit.y+hit.h/2;
      const where = cy>_fsPick.canvasH*0.55 ? 'нижняя' : (cy>_fsPick.canvasH*0.4?'средняя':'верхняя');
      lbl.textContent = `Выбрана ${where} полоса (${Math.round(hit.h)}px). Нажмите «✅ Анализировать».`;
    }
  }
  function fsPickMoveAt(clientX, clientY){
    if(!_fsPick.open) return;
    const p=fsCanvasPoint(clientX, clientY);
    const hit = (_fsPick.bands||[]).find(b=>p.y>=b.y-6 && p.y<=b.y+b.h+6) || selectBandAt(p.y);
    _fsPick.selectedBand=hit;
    fsUpdateHighlight();
  }
  function fsPickTapAt(clientX, clientY){
    if(!_fsPick.open) return;
    const p=fsCanvasPoint(clientX, clientY);
    let hit = (_fsPick.bands||[]).find(b=>p.y>=b.y-8 && p.y<=b.y+b.h+8);
    if(!hit) hit=selectBandAt(p.y);
    if(!hit){ setHint('Не нашёл отведение в этом месте — увеличьте зум и тапните прямо по полосе с сигналом.'); return; }
    _fsPick.selectedBand=hit; fsUpdateHighlight();
    fsAcceptSelection();
  }
  function fsAcceptSelection(){
    let hit = _fsPick.selectedBand;
    if(!hit){
      const bands=detectLeadBands();
      hit = (bands.length?bands[bands.length-1]:null) || {y:Math.floor(ecv.canvas.height*0.7),h:Math.floor(ecv.canvas.height*0.22)};
    }
    // Visual feedback immediately so user knows the tap was received
    const ok=document.getElementById('fsPickOk');
    if(ok){ ok.textContent='⏳ Анализирую...'; ok.disabled=true; }
    setTimeout(()=>{
      closeFullscreenPicker();
      ecv.manualBand={y:hit.y, h:hit.h};
      if(!ecv.pxPerMm || ecv.pxPerMm<1.5 || ecv.pxPerMm>80){
        const speed = parseInt(ecvEl('ecvSpeed').value,10)||50;
        const estPxPerMm = ecv.canvas.width/(speed*10);
        if(estPxPerMm>1.5 && estPxPerMm<60){
          ecv.pxPerMm=estPxPerMm;
          ecvEl('ecvPxmm').textContent = `px/мм: ${ecv.pxPerMm.toFixed(2)} (оценка)`;
          updateMeasurements();
        } else { ecv.pxPerMm=5; ecvEl('ecvPxmm').textContent='px/мм: 5 (по умолчанию)'; updateMeasurements(); }
      }
      setHint('⏳ Запускаю анализ...');
      try{
        autoAnalyze(); renderReport();
        if(!ecv.autoData || (ecv.autoData.peaks||0)<3){
          setHint('⚠ Анализ запущен, но распознано мало R-зубцов. Нажмите «↻ Поворот» в анализаторе, если плёнка перевёрнута, или выберите другую полосу. Результат см. в разделе «📋 Расшифровка».');
          // Still scroll to report so user sees something
          const d=ecvEl('ecvDec'); if(d) d.scrollIntoView({behavior:'smooth',block:'start'});
        }
      }catch(e){
        console.error('analyze failed',e);
        setHint('❌ Ошибка анализа: '+ (e && e.message?e.message:e));
      }
      if(ok){ ok.textContent='✅ Анализировать'; ok.disabled=false; }
    }, 60);
  }

  function runAnalyzeOnBand(rhythmBand, opts){
    opts=opts||{};
    const c=ecv.canvas, ctx=ecv.ctx;
    const w=c.width, h=c.height;
    const speed = parseInt(ecvEl('ecvSpeed').value,10);
    const mmPerMv = parseInt(ecvEl('ecvMv').value,10);
    const pad=4;
    const by=Math.max(0,rhythmBand.y-pad);
    const bh=Math.min(h-by,rhythmBand.h+2*pad);
    ecv.autoData = ecv.autoData||{};
    ecv.autoData.rhythmBand={y:by,h:bh};
    ecv.autoData.bandsFound = (opts.bands||detectLeadBands()).length;
    drawMarkers();
    const tr = extractTrace(by, bh);
    const trace = tr.trace;
    const sorted=[...trace].sort((a,b)=>a-b);
    const baseline=sorted[Math.floor(w*0.5)];
    const sig=new Float32Array(w);
    for(let x=0;x<w;x++) sig[x]=-(trace[x]-baseline)/ecv.pxPerMm/mmPerMv;

    const der=new Float32Array(w);
    for(let x=1;x<w-1;x++) der[x]=(sig[x+1]-sig[x-1])/2;
    const sq=new Float32Array(w); for(let x=0;x<w;x++) sq[x]=der[x]*der[x];
    const win=Math.max(5,Math.round(0.15*speed*ecv.pxPerMm));
    const env=new Float32Array(w);
    {let s=0;for(let x=0;x<w;x++){s+=sq[x];if(x>=win)s-=sq[x-win];env[x]=s/Math.min(x+1,win);}}
    let envMean=0;for(let x=0;x<w;x++)envMean+=env[x];envMean/=w;
    let envMax=0;for(let x=0;x<w;x++)if(env[x]>envMax)envMax=env[x];
    const minRR=Math.round(0.3*speed*ecv.pxPerMm);
    const refractory=Math.round(0.2*speed*ecv.pxPerMm);
    const peaks=[];
    function findPeaks(thMul, minAmp){
      peaks.length=0; let last=-1e9;
      const th=envMean*thMul + envMax*0.12;
      for(let x=win+1;x<w-win-1;x++){
        if(env[x]>th && env[x]>=env[x-1] && env[x]>=env[x+1] && x-last>minRR){
          let best=x,bestV=-Infinity;
          for(let k=-refractory;k<=refractory;k++){
            const xx=x+k; if(xx<0||xx>=w) continue;
            if(sig[xx]>bestV){bestV=sig[xx];best=xx;}
          }
          if(bestV>minAmp){peaks.push({x:best,y:by+trace[best],amp:bestV});last=best;x=best+refractory;}
        }
      }
    }
    findPeaks(1.8,0.15);
    for(let a=0;a<3 && peaks.length<3;a++){ findPeaks(1.4-a*0.25, 0.10-a*0.02); }
    let hr=null, rrAvg=0, rrSD=0, rrs=[];
    if(peaks.length>=2){
      for(let i=1;i<peaks.length;i++) rrs.push((peaks[i].x-peaks[i-1].x)/ecv.pxPerMm/speed);
      rrAvg=rrs.reduce((a,b)=>a+b,0)/rrs.length;
      rrSD=Math.sqrt(rrs.reduce((a,b)=>a+(b-rrAvg)**2,0)/rrs.length);
      hr=Math.round(60/rrAvg);
    }
    ecv.rrPoints=peaks.map(p=>({x:p.x,y:p.y}));
    const qrsWidths=[], qts=[], stDevs=[];
    peaks.forEach(p=>{
      const x0=p.x;
      if(x0<win*2||x0+win*4>=w) return;
      let qOnset=x0;
      for(let k=1;k<=Math.round(0.10*speed*ecv.pxPerMm);k++){
        if(Math.abs(sig[x0-k])<0.08){qOnset=x0-k;break;} qOnset=x0-k;
      }
      let jPoint=x0;
      for(let k=1;k<=Math.round(0.12*speed*ecv.pxPerMm);k++){
        if(Math.abs(sig[x0+k])<0.1){jPoint=x0+k;break;} jPoint=x0+k;
      }
      const qrsW=(jPoint-qOnset)/ecv.pxPerMm/speed;
      if(qrsW>0.04&&qrsW<0.2) qrsWidths.push(qrsW);
      const stX=jPoint+Math.round(0.08*speed*ecv.pxPerMm);
      if(stX<w){
        let st=0,n=0;
        for(let k=-2;k<=2;k++) if(stX+k>=0&&stX+k<w){st+=sig[stX+k];n++;}
        st/=n; stDevs.push(st);
      }
      let tEnd=stX, maxV=0, maxX=stX;
      const tMax=Math.round(0.50*speed*ecv.pxPerMm);
      for(let k=1;k<=tMax;k++){
        const xx=stX+k; if(xx>=w) break;
        if(sig[xx]>maxV){maxV=sig[xx];maxX=xx;}
        tEnd=xx;
        if(k>Math.round(0.15*speed*ecv.pxPerMm)&&maxV>0.1&&Math.abs(sig[xx])<0.05&&xx>maxX+Math.round(0.08*speed*ecv.pxPerMm)) break;
      }
      const qt=(tEnd-qOnset)/ecv.pxPerMm/speed;
      if(qt>0.20&&qt<0.60) qts.push(qt);
    });
    ecv.autoData = Object.assign(ecv.autoData||{}, {
      hr, rrAvg, rrSD,
      irregular: rrs.length>=3 && rrSD/rrAvg>0.12,
      tachy:hr&&hr>100, brady:hr&&hr<60,
      peaks:peaks.length,
      stMean:stDevs.length?stDevs.reduce((a,b)=>a+b,0)/stDevs.length:0,
      stMax:stDevs.length?Math.max(...stDevs):0,
      stMin:stDevs.length?Math.min(...stDevs):0,
      stCount:stDevs.length,
      qrsAvg:qrsWidths.length?qrsWidths.reduce((a,b)=>a+b,0)/qrsWidths.length:null,
      qtAvg:qts.length?qts.reduce((a,b)=>a+b,0)/qts.length:null
    });
    drawMarkers(); updateMeasurements(); renderReport();
  }

  function autoAnalyze(){
    if (!ecv.img){ setHint('Сначала загрузите изображение ЭКГ.'); return; }
    if (!ensureCalibration()){
      setHint('Не удалось определить масштаб — вручную нажмите «📐 Калибровать» и кликните по калибровочному прямоугольнику 10 мм / 1 мВ (верхний и нижний углы).');
      return;
    }
    setHint('🔍 Анализирую плёнку: ищу отведения, выделяю сигнал, ищу R-зубцы...');
    const c=ecv.canvas, ctx=ecv.ctx;
    const w=c.width, h=c.height;
    let bands = detectLeadBands();
    // Generous fallbacks so analysis always gets *some* vertical slice:
    if (bands.length===0){ bands=[{y:Math.floor(h*0.7),h:Math.floor(h*0.25),w,coverage:1}]; }
    // If the best-scoring band is weirdly huge (covers >50% of canvas, meaning detection failed),
    // force it to the bottom third (rhythm II convention).
    let rhythmBand=null;
    if(ecv.manualBand){
      rhythmBand = bands.find(b=>Math.abs(b.y-ecv.manualBand.y)<Math.max(10,b.h*0.4) && Math.abs((b.y+b.h)-(ecv.manualBand.y+ecv.manualBand.h))<Math.max(10,b.h*0.4)) || ecv.manualBand;
    }
    if(!rhythmBand){
      // Prefer bands that are in the lower half and of reasonable height
      let bestScore=-1;
      bands.forEach(b=>{ if(b.score>bestScore){bestScore=b.score;rhythmBand=b;} });
      if(rhythmBand && rhythmBand.h>h*0.55){
        // Detection blobbed everything; fallback to bottom third
        rhythmBand={y:Math.floor(h*0.7),h:Math.floor(h*0.22),w,coverage:1};
      }
    }
    if(!rhythmBand) rhythmBand=bands[bands.length-1];
    runAnalyzeOnBand(rhythmBand,{bands});
    // If very few peaks found and there are other bands, try the next-best bands too
    if(ecv.autoData.peaks<3 && bands.length>1){
      const sorted=bands.slice().sort((a,b)=>b.score-a.score);
      for(const b of sorted){
        if(b===rhythmBand) continue;
        runAnalyzeOnBand(b,{bands});
        if(ecv.autoData.peaks>=3) break;
      }
    }
    // Update hint based on result; if too few peaks, auto-prompt fullscreen tap-picker
    if((ecv.autoData.peaks||0)<3){
      if(!ecv.manualBand){
        setHint('⚠ Автоматически не нашёл ритм-полосу. Открываю полноэкранный просмотр — тапните по длинной полоске (обычно отведение II внизу).');
        setTimeout(openFullscreenPicker, 250);
      } else {
        setHint('⚠ В выбранной полосе мало R-зубцов. Попробуйте тапнуть по другой полосе (кнопка «☝ Выбрать отведение») или поверните фото.');
      }
    } else {
      setHint(`✅ Распознано R-зубцов: ${ecv.autoData.peaks} на выбранной полосе (ЧСС ~${ecv.autoData.hr||'—'} уд/мин). Ниже — предварительная расшифровка.`);
    }
  }


  function renderReport(){
    const speed = parseInt(ecvEl('ecvSpeed').value,10);
    const mmPerMv = parseInt(ecvEl('ecvMv').value,10);
    const a = ecv.autoData || {};
    const rrAvg = a.rrAvg || (ecv.rrPoints.length>=2 ? (()=>{
      const xs=ecv.rrPoints.map(p=>p.x).sort((a,b)=>a-b); let s=0,n=0;
      for(let i=1;i<xs.length;i++){s+=xs[i]-xs[i-1];n++;} return (s/n)/ecv.pxPerMm/speed;})() : null);
    const hr = rrAvg ? Math.round(60/rrAvg) : null;

    // Prefer auto-measured intervals over manual markers if available
    let pq=null, qrs=a.qrsAvg||null, qt=a.qtAvg||null;
    ecv.measurePairs.forEach((p,i)=>{
      const dx=Math.abs(p.b.x-p.a.x)/ecv.pxPerMm;
      const sec=dx/speed;
      if (i===0 && !qrs) qrs=sec; else if (i===1) pq=sec; else if (i===2 && !qt) qt=sec;
    });

    const dec = ecvEl('ecvDec');
    let html = '<h3>📋 Расшифровка ЭКГ</h3>';
    html += `<div class="ok"><b>ВНИМАНИЕ:</b> Автоматическая расшифровка — справочная оценка, она <u>не заменяет врача</u>. При острой боли в груди, жжении за грудиной, одышке, холодном поту, головокружении <b>немедленно звоните 103</b>.</div>`;

    // Table of measurements
    html += '<table><tr><th>Показатель</th><th>Значение</th><th>Норма</th><th>Оценка</th></tr>';
    function row(name,val,norm,ok,note){
      const cls = ok?'ok':(ok===false?'danger':'warn');
      html += `<tr><td>${name}</td><td><b>${val}</b></td><td>${norm}</td><td><div class="${cls}">${note||(ok?'в норме':'отклонение')}</div></td></tr>`;
    }
    // HR
    let hrOK = hr && hr>=60 && hr<=90;
    let hrNote = '';
    if (hr==null) { hrNote='не рассчитана — откалибруйте и отметьте R-R или запустите Автоанализ'; }
    else if (hr>100) hrNote='тахикардия (>90)';
    else if (hr<60) hrNote='брадикардия (<60) — вариант нормы у спортсменов';
    else if (hr>90) hrNote='тахисистолия (90–100)';
    else hrNote='нормосистолия';
    html += `<tr><td>ЧСС</td><td><b>${hr??'—'} уд/мин</b></td><td>60–90</td><td><div class="${hrOK?'ok':hr?'warn':'warn'}">${hrNote}</div></td></tr>`;

    // R-R interval
    html += `<tr><td>Интервал R-R (средний)</td><td>${rrAvg?(rrAvg*1000).toFixed(0)+' мс':'—'}</td><td>600–1000 мс</td><td>${rrAvg?(rrAvg>=0.6&&rrAvg<=1.0?'<div class="ok">в норме</div>':'<div class="warn">отклонение</div>'):'—'}</td></tr>`;

    // Rhythm regularity
    const irreg = a.irregular || (ecv.rrPoints.length>=4 && (()=>{
      const xs=ecv.rrPoints.map(p=>p.x).sort((a,b)=>a-b); const rrs=[];
      for(let i=1;i<xs.length;i++) rrs.push((xs[i]-xs[i-1])/ecv.pxPerMm/speed);
      const av=rrs.reduce((a,b)=>a+b,0)/rrs.length;
      const sd=Math.sqrt(rrs.reduce((a,b)=>a+(b-av)**2,0)/rrs.length);
      return sd/av>0.12;})());
    html += `<tr><td>Ритм</td><td>${irreg?'нерегулярный (аритмия)':'регулярный'}</td><td>регулярный синусовый</td><td>${irreg?'<div class="warn">Возможны экстрасистолы, мерцательная аритмия или дыхательная аритмия — нужна оценка врача.</div>':'<div class="ok">регулярный</div>'}</td></tr>`;

    // Intervals if measured
    if (pq!==null){
      const ok = pq>=0.12 && pq<=0.20;
      html += `<tr><td>Интервал P-Q (P-R)</td><td>${(pq*1000).toFixed(0)} мс</td><td>120–200 мс</td><td>${ok?'<div class="ok">в норме</div>':pq<0.12?'<div class="warn">укорочен — возможен синдром WPW, ЛГЛ</div>':'<div class="danger">удлинён — AV-блокада I ст.</div>'}</td></tr>`;
    } else html += `<tr><td>Интервал P-Q</td><td>—</td><td>120–200 мс</td><td><div class="warn">не измерен — отметьте от начала P до начала Q</div></td></tr>`;

    if (qrs!==null){
      const ok = qrs<=0.10;
      html += `<tr><td>Комплекс QRS</td><td>${(qrs*1000).toFixed(0)} мс</td><td>60–100 мс</td><td>${ok?'<div class="ok">в норме</div>':'<div class="danger">расширен (>100 мс) — БПНПГ/БЛНПГ, желудочковый ритм, WPW</div>'}</td></tr>`;
    } else html += `<tr><td>Комплекс QRS</td><td>—</td><td>60–100 мс</td><td><div class="warn">не измерен — отметьте от начала Q до конца S</div></td></tr>`;

    if (qt!==null && hr){
      // QTc (Bazett)
      const qtc = qt/Math.sqrt(rrAvg);
      const ok = qtc<=0.44 && qtc>=0.35;
      html += `<tr><td>QT (корриг. QTc по Базетту)</td><td>${(qt*1000).toFixed(0)} мс / QTc ${(qtc*1000).toFixed(0)} мс</td><td>QTc 350–440 мс</td><td>${ok?'<div class="ok">в норме</div>':qtc>0.44?'<div class="danger">удлинён QTc — риск полиморфной ЖТ (torsade), к кардиологу срочно</div>':'<div class="warn">укорочен — редкие формы синдрома</div>'}</td></tr>`;
    } else html += `<tr><td>Интервал QT / QTc</td><td>—</td><td>QTc 350–440 мс</td><td><div class="warn">не измерен — отметьте от начала Q до конца T</div></td></tr>`;

    html += '</table>';

    // ST segment analysis
    html += '<h3>🔬 Сегмент ST</h3>';
    if (a.stCount>=3){
      const elev = a.stMax;
      const dep = a.stMin;
      if (elev>=0.2){
        html += `<div class="danger"><b>⚠ Элевация ST ~${elev.toFixed(2)} мВ</b>. Возможна <b>острая ишемия / инфаркт миокарда с подъёмом ST (STEMI)</b>, перикардит, ранняя реполяризация. <b>Звоните 103 СЕЙЧАС</b> — нужна срочная ЭКГ, тропонин, ЭхоКГ.</div>`;
      } else if (dep<=-0.1){
        html += `<div class="warn"><b>Депрессия ST ~${Math.abs(dep).toFixed(2)} мВ</b>. Возможна субэндокардиальная ишемия, стресс-индуцированная ишемия, гипертрофия ЛЖ с нагрузкой, действие препаратов (дигоксин). К кардиологу, сделать ЭхоКГ, стресс-тест, контроль тропонина при болях.</div>`;
      } else {
        html += `<div class="ok">Сегмент ST на выбранном отведении без выраженных смещений (от ${dep.toFixed(2)} до ${elev.toFixed(2)} мВ). Оценка по одному отведению неполная.</div>`;
      }
    } else {
      html += `<div class="warn">Недостаточно комплексов QRS для оценки ST (распознано ${a.stCount||0}). Калибруйте плёнку и нажмите «🤖 Автоанализ» на длинном отведении (обычно II внизу плёнки).</div>`;
    }

    // Diagnostic summary
    html += '<h3>🩺 Предварительное заключение (генерируется)</h3>';
    const findings=[];
    if (hr==null) findings.push('⚠ Недостаточно данных для анализа — откалибруйте и отметьте минимум 5 R-зубцов.');
    else {
      if (a.tachy) findings.push('🔹 <b>Синусовая тахикардия</b>: возможна при физической/эмоциональной нагрузке, повышении t°, анемии, гипертиреозе, обезвоживании, сердечной недостаточности, кофеине. При отсутствии очевидной причины — к терапевту/кардиологу: ОАК, ТТГ, ЭхоКГ, АД-контроль.');
      else if (a.brady) findings.push('🔹 <b>Брадикардия</b>: норма у тренированных спортсменов и во сне; может быть при гипотиреозе, блокадах, приёме β-блокаторов. При головокружениях/обмороках — к кардиологу (Холтер, АТФ-тест).');
      else findings.push('🔹 ЧСС в диапазоне нормосистолии.');
      if (irreg) findings.push('🔹 <b>Нерегулярный ритм</b>: вероятные причины — экстрасистолия (наджелудочковая/желудочковая), мерцательная аритмия (ФП), дыхательная аритмия (норма у молодых). Для уточнения — Холтер-мониторирование 24–48 ч.');
      if (a.stMax>=0.1) findings.push('🔹 <b>Элевация ST</b> — срочно к кардиологу/вызов СМП для исключения STEMI, перикардита.');
      if (a.stMin<=-0.1) findings.push('🔹 <b>Депрессия ST</b> — нужна оценка на ишемию (стресс-ЭхоКГ или коронарография по показаниям), тропонин при болях.');
      if (pq!==null){
        if (pq<0.12) findings.push('🔹 Укороченный PQ — подозрение на феномен WPW/ЛГЛ; к кардиологу для исключения дополнительных проводящих путей.');
        if (pq>0.20) findings.push('🔹 Удлинённый PQ — AV-блокада I степени; контроль ЭКГ.');
      }
      if (qrs!==null && qrs>0.10) findings.push('🔹 Расширенный QRS — возможна блокада ножек пучка Гиса или WPW; к кардиологу, оценка по 12 отведениям.');
      if (qt!==null && hr){
        const qtc = qt/Math.sqrt(rrAvg);
        if (qtc>0.44) findings.push('🔹 <b>Удлинённый QTc</b> — опасное состояние (риск torsade de pointes), срочно к кардиологу; пересмотреть лекарства (антибиотики макролиды/фторхинолоны, антиаритмики, антипсихотики).');
      }
    }
    findings.forEach(f=>{ html += `<div class="warn">${f}</div>`; });

    html += '<h3>👨‍⚕️ План действий (рекомендации)</h3>';
    html += `<ul>
      <li>Покажите плёнку <b>кардиологу</b> или <b>функциональному диагносту</b> — только врач ставит окончательный диагноз.</li>
      <li>При болях в груди дольше 15 минут, жжении за грудиной, одышке, холодном поту, тошноте — <b>немедленно звоните 103</b>, разжуйте 250–325 мг аспирина (если нет противопоказаний).</li>
      <li>Сделайте <b>ЭхоКГ</b> для оценки структуры сердца.</li>
      <li>Сдайте <b>липидный профиль, глюкозу, ТТГ, КФК-МВ, тропонин I/T, BNP</b> при симптомах.</li>
      <li>При нарушениях ритма — <b>Холтер-мониторирование (24–48 ч)</b>.</li>
      <li>Контроль АД и пульса 2 раза в день в дневник; нормализация сна, физическая активность, отказ от курения, ограничение кофе/алкоголя.</li>
    </ul>`;

    html += `<p style="color:#888"><small>Калибровка: px/мм=${ecv.pxPerMm?ecv.pxPerMm.toFixed(2):'—'}, скорость=${speed} мм/с, ${mmPerMv} мм/мВ. Полос отведений найдено: ${a.bandsFound||'?'}, выбрана ритм-полоса (y=${a.rhythmBand?a.rhythmBand.y:'—'}, h=${a.rhythmBand?a.rhythmBand.h:'—'} px). R-зубцов: ${a.peaks||ecv.rrPoints.length||0}, QRS: ${qrs?(qrs*1000).toFixed(0)+' мс':'—'}, QT: ${qt?(qt*1000).toFixed(0)+' мс':'—'}.</small></p>`;

    dec.innerHTML = html;
    dec.scrollIntoView({behavior:'smooth', block:'start'});
  }

  // Canvas events: single taps for calib/RR/measure; pointer drag for crop.
  // We use event delegation on the document for ALL ecv toolbar buttons — this is
  // bulletproof against DOM reordering, hidden tabs at script-start time, and the
  // WebView sometimes missing direct addEventListener bindings on elements inside
  // display:none sections.
  function _ecvClick(id){
    switch(id){
      case 'ecvBack': switchTab('ecg'); break;
      case 'ecvCalib':
        resetClicks(); ecv.mode='calib';
        setHint('Кликните <b>два раза</b>: на нижний и верхний угол калибровочного прямоугольника (обычно он слева в каждом отведении, высота 10 мм = 1 мВ).');
        break;
      case 'ecvRR':
        ecv.rrPoints=[]; ecv.mode='rr';
        setHint('Кликайте последовательно по зубцам R (самый высокий острый пик) на одном отведении. Нужно 5–8 точек.');
        drawMarkers(); updateMeasurements();
        break;
      case 'ecvMeasure':
        ecv.measurePairs=[]; ecv.pendingStart=null; ecv.mode='measure';
        setHint('Кликайте по двум точкам для измерения интервала. Рекомендуется по порядку: QRS (от Q до конца S), PQ (от начала P до начала Q), QT (от конца Q до конца T).');
        drawMarkers(); updateMeasurements();
        break;
      case 'ecvReset': resetClicks(); ecv.autoData=null; ecv.manualBand=null; drawMarkers(); updateMeasurements(); renderReport(); setHint('Сброшено.'); break;
      case 'ecvRotate':
        if (!ecv.img){ setHint('Сначала загрузите изображение ЭКГ.'); return; }
        ecv.rotation = (ecv.rotation+90)%360;
        resetClicks(); ecv.autoData=null; ecv.manualBand=null;
        // Clear old highlights from autoData so the dashed rectangle doesn't linger on rotated canvas
        if(ecv.autoData && ecv.autoData.rhythmBand) ecv.autoData.rhythmBand=null;
        drawCanvas(); detectPxPerMmAuto();
        setHint('Изображение повернуто на 90° по часовой стрелке. Если нужно ещё — нажмите ↻ ещё раз.');
        break;
      case 'ecvPrev': if(ecv.index>0) loadEcvIndex(ecv.index-1); break;
      case 'ecvNext': if(ecv.index<ecv.list.length-1) loadEcvIndex(ecv.index+1); break;
      case 'ecvAuto': autoAnalyze(); renderReport(); break;
      case 'ecvReport':
        if (!ecv.img){ setHint('Сначала загрузите изображение ЭКГ.'); return; }
        if (!ensureCalibration()){
          setHint('Не удалось определить масштаб. Нажмите «📐 Калибровать» и кликните по калибровочному прямоугольнику 10 мм/1 мВ в начале отведений.');
          return;
        }
        if (!ecv.autoData){ try{ autoAnalyze(); }catch(e){ console.warn(e); } }
        renderReport();
        break;
      case 'ecvCrop':
        if (!ecv.img){ alert('Сначала загрузите изображение ЭКГ.'); return; }
        resetClicks(); ecv.mode='crop'; ecv.cropMode=true;
        const ab=ecvEl('ecvApplyCrop'), cb=ecvEl('ecvCancelCrop');
        if(ab) ab.style.display=''; if(cb) cb.style.display='';
        setHint('✂ Режим обрезки: нажмите на плёнке и, не отпуская, выделите нужный участок. Затем «✅ Применить обрезку».');
        break;
      case 'ecvApplyCrop': applyCrop(); break;
      case 'ecvCancelCrop': cancelCrop(); break;
      case 'ecvPickLead':
        if (!ecv.img){ setHint('Сначала загрузите изображение ЭКГ.'); return; }
        if(!ensureCalibration()){ setHint('Сначала дождитесь автоматической калибровки или нажмите «📐 Калибровать».'); return; }
        resetClicks(); ecv.autoData=null; ecv.mode='idle';
        openFullscreenPicker();
        break;
    }
  }
  document.addEventListener('click',function(ev){
    const b = ev.target.closest('[data-ecv-act]');
    if(!b) return;
    ev.preventDefault();
    _ecvClick(b.getAttribute('data-ecv-act'));
  });
  function _ecvChange(id){
    if (id==='ecvSpeed'||id==='ecvMv'){ if(ecv.autoData) autoAnalyze(); else updateMeasurements(); }
  }
  document.addEventListener('change',function(ev){
    const el = ev.target.closest('[data-ecv-change]');
    if(!el) return;
    _ecvChange(el.getAttribute('data-ecv-change'));
  });

  // Canvas pointer events — also wired safely (canvas may not yet be sized when tab is hidden)

  function openEcgViewer(item, opts){
    opts = opts||{};
    ecvShow();
    // Build the list of ECG scans to browse in the viewer.
    // ecgImages[] = scans added on the current entry; pass opts.list to override (e.g. history entry).
    const list = (opts.list && opts.list.length) ? opts.list : (ecgImages.length? ecgImages.slice() : (item?[item]:[]));
    ecv.list = list;
    // Find index of the requested item
    let idx = 0;
    if (opts.cropIndex>=0 && ecgImages===list) idx=opts.cropIndex;
    else if (item){
      const hit = list.findIndex(x=>x.dataUrl===item.dataUrl);
      if (hit>=0) idx=hit;
    }
    ecv.index = idx;
    resetClicks(); ecv.autoData=null; ecv._pendingAuto = !!opts.runAuto;
    ecv.cropMode = !!opts.crop;
    ecv.cropIndex = (typeof opts.cropIndex==='number')?opts.cropIndex:-1;
    const applyBtn = ecvEl('ecvApplyCrop');
    const cancelCropBtn = ecvEl('ecvCancelCrop');
    if (applyBtn) applyBtn.style.display = ecv.cropMode?'':'none';
    if (cancelCropBtn) cancelCropBtn.style.display = ecv.cropMode?'':'none';
    if (ecv.cropMode){
      setHint('✂ Режим обрезки: выделите пальцем/мышью нужный участок плёнки, затем нажмите «✅ Применить обрезку». Чтобы отменить — «✕ Отменить обрезку».');
      loadEcgImage(item.dataUrl);
      ecv.mode='crop';
    } else {
      loadEcvIndex(idx);
    }
    updateEcgNav();
  }
  // tap image in gallery to open fullscreen
  function bindEcgClicks(){
    ecgGallery.querySelectorAll('img').forEach((img,i)=>{
      if (img.dataset.ecvBound) return;
      img.dataset.ecvBound='1';
      img.style.cursor='zoom-in';
      img.addEventListener('click',()=>openEcgViewer(ecgImages[i]));
    });
    $$('#historyList .ecg-item img').forEach(img=>{
      if (img.dataset.ecvBound) return;
      img.dataset.ecvBound='1';
      img.style.cursor='zoom-in';
      img.addEventListener('click',()=>openEcgViewer({dataUrl: img.src}));
    });
  }
  // monkey-patch renderEcg to also bind clicks (однократно, защита от двойной обёртки)
  if (!renderEcg.__bzPatched){
    const _origRender = renderEcg;
    renderEcg = function(){ _origRender(); bindEcgClicks(); };
    renderEcg.__bzPatched = true;
  }
  // Also for ECG in history entries — bind when loading snapshot
  if (!loadSnapshot.__bzPatched){
    const _origLoadSnapshot = loadSnapshot;
    loadSnapshot = function(entry){ _origLoadSnapshot(entry); setTimeout(bindEcgClicks,50); };
    loadSnapshot.__bzPatched = true;
  }
  // Bind clicks each time history is rendered
  function observeHistory(){
    const hv=$('#historyList'); if(!hv) return;
    const mo=new MutationObserver(bindEcgClicks);
    mo.observe(hv,{childList:true,subtree:true});
  }
  setTimeout(observeHistory, 200);
  window.addEventListener('resize',()=>{ if(ecv.img && document.getElementById('tab-ecg-decode').classList.contains('active')) drawCanvas(); });

  // Canvas events: single taps for calib/RR/measure; pointer drag for crop.
  // On mobile WebView synthetic "click" after touch is unreliable on canvas, so we
  // detect taps directly from touchend (and from mouseup for desktop).
  function _bindCanvasOnce(){
    const cv = ecvEl('ecvCanvas');
    if (!cv || cv.dataset.ecvBound) return;
    cv.dataset.ecvBound='1';
    let _tapStart=null;
    function _fromEvent(e){ const t=(e.touches&&e.touches[0])||(e.changedTouches&&e.changedTouches[0])||e; return t; }
    cv.addEventListener('mousedown',e=>{
      if(ecv.mode!=='crop') return;
      const p=canvasPoint(e); ecv.cropStart=p; ecv.cropEnd=null; ecv.cropDrag=p; ecv._dragging=true; drawMarkers();
    });
    cv.addEventListener('mousemove',e=>{
      if(ecv.mode!=='crop'||!ecv._dragging) return;
      ecv.cropDrag=canvasPoint(e);
      if(ecv.ctx){ ecv.ctx.drawImage(ecv.img,0,0,ecv.canvas.width,ecv.canvas.height); ecv.cropEnd=ecv.cropDrag; drawMarkers(); }
    });
    window.addEventListener('mouseup',()=>{
      if(ecv.mode==='crop'&&ecv._dragging){
        ecv._dragging=false;
        if(ecv.cropDrag) ecv.cropEnd=ecv.cropDrag;
        setHint('Область выделена. Нажмите «✅ Применить обрезку» или перевыделите.');
        drawMarkers();
      }
    });
    cv.addEventListener('touchstart',e=>{
      const t=_fromEvent(e);
      _tapStart={x:t.clientX,y:t.clientY,t:Date.now()};
      if(ecv.mode!=='crop'){ e.preventDefault(); return; }
      const p=canvasPoint(t); ecv.cropStart=p; ecv.cropEnd=null; ecv.cropDrag=p; ecv._dragging=true; drawMarkers();
      e.preventDefault();
    },{passive:false});
    cv.addEventListener('touchmove',e=>{
      if(ecv.mode!=='crop'||!ecv._dragging) return;
      const t=_fromEvent(e); ecv.cropDrag=canvasPoint(t);
      if(ecv.ctx){ ecv.ctx.drawImage(ecv.img,0,0,ecv.canvas.width,ecv.canvas.height); ecv.cropEnd=ecv.cropDrag; drawMarkers(); }
      if(_tapStart) _tapStart.moved=true;
      e.preventDefault();
    },{passive:false});
    cv.addEventListener('touchend',e=>{
      const t=_fromEvent(e); const start=_tapStart; _tapStart=null;
      const dx=start?Math.abs(t.clientX-start.x):0, dy=start?Math.abs(t.clientY-start.y):0, dt=start?(Date.now()-start.t):999;
      const isTap=start&&!start.moved&&dx<12&&dy<12&&dt<600;
      if(ecv.mode==='crop'&&ecv._dragging){
        ecv._dragging=false;
        if(ecv.cropDrag) ecv.cropEnd=ecv.cropDrag;
        setHint('Область выделена. Нажмите «✅ Применить обрезку» или перевыделите.');
        drawMarkers(); e.preventDefault(); return;
      }
      if(isTap){
        ecvClick({clientX:t.clientX,clientY:t.clientY,preventDefault(){}});
        e.preventDefault();
      }
    });
    cv.addEventListener('touchcancel',()=>{ _tapStart=null; ecv._dragging=false; });
    cv.addEventListener('click',e=>ecvClick(e));
  }
  _bindCanvasOnce();

  // Filter/enhancement controls
  (function(){
    const tgl=document.getElementById('ecvEnhanceToggle');
    const cnt=document.getElementById('ecvContrast');
    const grd=document.getElementById('ecvGrid');
    const ink=document.getElementById('ecvInk');
    const cV=document.getElementById('ecvContrastVal');
    const gV=document.getElementById('ecvGridVal');
    const iV=document.getElementById('ecvInkVal');
    const rst=document.getElementById('ecvFilterReset');
    const KEY='budzdorov_filter';
    // restore saved settings
    try{
      const saved=JSON.parse(localStorage.getItem(KEY)||'{}');
      if(tgl && saved.enabled!=null) tgl.checked=!!saved.enabled;
      if(cnt && saved.contrast!=null){ cnt.value=saved.contrast; }
      if(grd && saved.grid!=null){ grd.value=saved.grid; }
      if(ink && saved.ink!=null){ ink.value=saved.ink; }
    }catch(e){}
    function updLabels(){
      if(cV) cV.textContent=(cnt?parseFloat(cnt.value):1.6).toFixed(1);
      if(gV) gV.textContent=Math.round((grd?parseFloat(grd.value):0.7)*100)+'%';
      if(iV) iV.textContent=(ink?parseFloat(ink.value):3.2).toFixed(1);
    }
    function persist(){
      localStorage.setItem(KEY, JSON.stringify({
        enabled: tgl?tgl.checked:true,
        contrast: cnt?parseFloat(cnt.value):1.6,
        grid: grd?parseFloat(grd.value):0.7,
        ink: ink?parseFloat(ink.value):3.2
      }));
    }
    function change(){ updLabels(); persist(); if(ecv.img) redrawEnhanceOnly(); }
    updLabels();
    if(tgl) tgl.addEventListener('change', change);
    if(cnt) cnt.addEventListener('input', change);
    if(grd) grd.addEventListener('input', change);
    if(ink) ink.addEventListener('input', change);
    if(rst) rst.addEventListener('click', ()=>{
      if(tgl) tgl.checked=true;
      if(cnt) cnt.value=1.6;
      if(grd) grd.value=0.7;
      if(ink) ink.value=3.2;
      change();
    });
  })();

  // Bind fullscreen picker controls once
  (function(){
    const cvs = document.getElementById('fsCanvas');
    const ok = document.getElementById('fsPickOk');
    const cc = document.getElementById('fsPickCancel');
    const zp = document.getElementById('fsZoomIn');
    const zm = document.getElementById('fsZoomOut');
    const zf = document.getElementById('fsZoomFit');
    if(!cvs) return;
    // Touch gesture state
    let _touchMode=null; // 'pinch' | 'pan' | 'tap'
    let _pinchStartDist=0, _pinchStartZoom=1;
    let _panStart={x:0,y:0,tx:0,ty:0};
    let _tapStart=null;
    let _lastTap=0;
    function _dist(a,b){ const dx=a.clientX-b.clientX, dy=a.clientY-b.clientY; return Math.sqrt(dx*dx+dy*dy); }
    function _center(a,b){ return {x:(a.clientX+b.clientX)/2, y:(a.clientY+b.clientY)/2}; }
    // Prevent default gesture (pinch/zoom on iOS/Android) from resizing the page
    const vp=document.getElementById('fsViewport');
    if(vp){
      vp.addEventListener('touchmove', e=>{ if(_fsPick.open) e.preventDefault(); },{passive:false});
      vp.addEventListener('wheel', e=>{
        if(!_fsPick.open) return;
        e.preventDefault();
        const delta = e.deltaY<0 ? 1.15 : 1/1.15;
        fsSetZoom(_fsPick.zoom*delta, e.clientX, e.clientY);
      },{passive:false});
    }
    cvs.addEventListener('touchstart', e=>{
      if(!_fsPick.open) return;
      const ts=e.touches;
      if(ts.length===2){
        _touchMode='pinch';
        _pinchStartDist=_dist(ts[0],ts[1]);
        _pinchStartZoom=_fsPick.zoom;
        _tapStart=null;
      } else if(ts.length===1){
        const t=ts[0];
        _tapStart={x:t.clientX,y:t.clientY,t:Date.now(),moved:false};
        _touchMode='tap';
        _panStart={x:t.clientX,y:t.clientY,tx:_fsPick.tx,ty:_fsPick.ty};
      }
    },{passive:false});
    cvs.addEventListener('touchmove', e=>{
      if(!_fsPick.open) return;
      if(_fsPick.drag || _touchMode==='drag'){ e.preventDefault(); return; }
      const ts=e.touches;
      if(_touchMode==='pinch' && ts.length===2){
        const d=_dist(ts[0],ts[1]);
        const c=_center(ts[0],ts[1]);
        const ratio = d/_pinchStartDist;
        fsSetZoom(_pinchStartZoom*ratio, c.x, c.y);
        e.preventDefault();
      } else if(ts.length===1){
        const t=ts[0];
        const dx=t.clientX-_panStart.x, dy=t.clientY-_panStart.y;
        // More permissive threshold — small natural finger jitter shouldn't count as pan
        if(Math.abs(dx)>14||Math.abs(dy)>14 || _fsPick.zoom!==1){
          if(_tapStart) _tapStart.moved=true;
          _touchMode='pan';
          _fsPick.tx=_panStart.tx+dx; _fsPick.ty=_panStart.ty+dy;
          _fsClampPan(false);
        }
        e.preventDefault();
      }
    },{passive:false});
    cvs.addEventListener('touchend', e=>{
      if(!_fsPick.open) return;
      const ts=e.touches;
      if(_touchMode==='pinch'){
        if(ts.length<=1){ _touchMode=null; _tapStart=null; }
        e.preventDefault(); return;
      }
      if(_touchMode==='pan'){ _touchMode=null; _tapStart=null; e.preventDefault(); return; }
      const t=(e.changedTouches&&e.changedTouches[0]);
      const s=_tapStart; _tapStart=null; _touchMode=null;
      if(t && s && !s.moved && Math.abs(t.clientX-s.x)<20 && Math.abs(t.clientY-s.y)<20 && (Date.now()-s.t)<700){
        const now=Date.now();
        const dbl = now-_lastTap<360;
        _lastTap=now;
        if(dbl){
          if(_fsPick.zoom>1.2){ fsZoomFit(); }
          else fsSetZoom(2.5, t.clientX, t.clientY);
        } else {
          // Single tap: select band under finger, don't confirm yet — user must press "Анализировать"
          // But if they tapped on a band that's different from current, highlight it immediately.
          setTimeout(()=>{
            if(_lastTap!==now) return; // double-tap superseded
            fsPickMoveAt(t.clientX,t.clientY);
          }, 280);
        }
      }
      e.preventDefault();
    },{passive:false});
    cvs.addEventListener('touchcancel', ()=>{ _touchMode=null; _tapStart=null; });
    // Mouse: hover highlight, click to select, wheel zoom, drag to pan
    cvs.addEventListener('mousemove', e=>{ if(_fsPick.open) fsPickMoveAt(e.clientX, e.clientY); });
    let _mouseDown=false, _mouseStart=null;
    cvs.addEventListener('mousedown', e=>{
      _mouseDown=true;
      _mouseStart={x:e.clientX,y:e.clientY,tx:_fsPick.tx,ty:_fsPick.ty,moved:false};
      e.preventDefault();
    });
    window.addEventListener('mousemove', e=>{
      if(!_mouseDown) return;
      const dx=e.clientX-_mouseStart.x, dy=e.clientY-_mouseStart.y;
      if(Math.abs(dx)>3||Math.abs(dy)>3) _mouseStart.moved=true;
      if(_mouseStart.moved){
        _fsPick.tx=_mouseStart.tx+dx; _fsPick.ty=_mouseStart.ty+dy;
        _fsClampPan(false);
      }
    });
    window.addEventListener('mouseup', e=>{
      if(!_mouseDown) return;
      const moved=_mouseStart && _mouseStart.moved;
      _mouseDown=false;
      if(!moved && _fsPick.open) fsPickTapAt(e.clientX, e.clientY);
    });
    // Buttons
    const rotBtn=document.getElementById('fsRotate');
    if(rotBtn){
      const rotH=()=>{
        if(!_fsPick.open||!ecv.img) return;
        ecv.rotation=(ecv.rotation+90)%360;
        resetClicks(); ecv.autoData=null; ecv.manualBand=null;
        drawCanvas(); detectPxPerMmAuto();
        openFullscreenPicker();
      };
      rotBtn.addEventListener('click', rotH);
      window.__fsRotate=rotH;
    }
    const bl=document.getElementById('fsBottomLead');
    const bottomH=()=>{
      if(!_fsPick.open) return;
      const sh=_fsPick.canvasH;
      const minReasonable = Math.max(20,sh*0.055);
      const cands=(_fsPick.bands||[]).filter(b=>b.coverage>0.25 && b.strong>0.08 && b.h>=minReasonable && b.h<=sh*0.22);
      const list=cands.length?cands:(_fsPick.bands||[]).filter(b=>b.coverage>0.15 && b.h>=minReasonable);
      let pick;
      if(list.length){
        // Pick the lowest band that is at least 60% of median band height (avoid sliver artifacts at very bottom)
        const medH=list.map(b=>b.h).sort((a,b)=>a-b)[Math.floor(list.length/2)];
        const real = list.filter(b=>b.h>=medH*0.6);
        const pool = real.length?real:list;
        pick = pool[pool.length-1];
      }
      else if(_fsPick.bands&&_fsPick.bands.length) pick=_fsPick.bands.reduce((a,b)=>b.h>a.h?b:a,_fsPick.bands[0]);
      else pick={y:Math.floor(sh*0.68),h:Math.floor(sh*0.16),w:_fsPick.canvasW,x:0};
      _fsPick.selectedBand=pick; fsUpdateHighlight(); fsAcceptSelection();
    };
    if(bl){ bl.addEventListener('click',bottomH); window.__fsBottom=bottomH; }
    const zdirH=(dir)=>{
      const v=document.getElementById('fsViewport'); if(!v) return;
      if(dir===0){ fsZoomFit(); return; }
      const f=dir>0?1.4:1/1.4;
      fsSetZoom(_fsPick.zoom*f, v.getBoundingClientRect().left+v.clientWidth/2, v.getBoundingClientRect().top+v.clientHeight/2);
    };
    window.__fsZoom=zdirH;
    if(zp) zp.addEventListener('click', ()=>{
      const v=document.getElementById('fsViewport'); if(!v) return;
      fsSetZoom(_fsPick.zoom*1.4, v.getBoundingClientRect().left+v.clientWidth/2, v.getBoundingClientRect().top+v.clientHeight/2);
    });
    if(zm) zm.addEventListener('click', ()=>{
      const v=document.getElementById('fsViewport'); if(!v) return;
      fsSetZoom(_fsPick.zoom/1.4, v.getBoundingClientRect().left+v.clientWidth/2, v.getBoundingClientRect().top+v.clientHeight/2);
    });
    if(zf) zf.addEventListener('click', fsZoomFit);
    if(ok){
      ok.addEventListener('click', fsAcceptSelection);
      window.__fsAccept = fsAcceptSelection; // expose for inline onclick fallback
    }
    if(cc){
      cc.addEventListener('click', closeFullscreenPicker);
      window.__fsCancel = closeFullscreenPicker;
      cc.setAttribute('onclick','window.__fsCancel&&window.__fsCancel()');
    }
    // Drag & resize the yellow highlight band directly
    const hl=document.getElementById('fsBandHl');
    function _fsStartDrag(edge, clientX, clientY){
      if(!_fsPick.open||!_fsPick.selectedBand) return;
      const b=_fsPick.selectedBand;
      _fsPick.drag={
        edge,
        startY:clientY,
        origY:b.y, origH:b.h,
        // also anchor panning ref so dragging the band doesn't ALSO pan the canvas
        panAnchor:{tx:_fsPick.tx,ty:_fsPick.ty}
      };
    }
    function _fsMoveDrag(clientX,clientY){
      const d=_fsPick.drag; if(!d) return false;
      const s=_fsPick.baseScale*_fsPick.zoom;
      const dy=(clientY-d.startY)/s; // screen delta → canvas pixel delta
      const b=_fsPick.selectedBand; if(!b) return true;
      const sh=_fsPick.canvasH;
      const minH=Math.max(20,sh*0.04), maxH=Math.floor(sh*0.30);
      if(d.edge==='move'){
        let ny=Math.round(d.origY+dy);
        ny=Math.max(4, Math.min(sh-b.h-4, ny));
        b.y=ny;
      } else if(d.edge==='top'){
        let ny=Math.round(d.origY+dy);
        const newH=d.origH-(ny-d.origY);
        if(newH>=minH && newH<=maxH && ny>=2){ b.y=ny; b.h=newH; }
        else if(newH<minH){ b.y=d.origY+d.origH-minH; b.h=minH; }
        else if(newH>maxH){ b.y=d.origY+d.origH-maxH; b.h=maxH; }
      } else if(d.edge==='bot'){
        let nh=Math.round(d.origH+dy);
        if(nh<minH) nh=minH;
        if(nh>maxH) nh=maxH;
        if(b.y+nh<=sh-2) b.h=nh;
        else b.h=Math.max(minH, sh-2-b.y);
      }
      fsUpdateHighlight();
      return true;
    }
    if(hl){
      hl.addEventListener('touchstart', e=>{
        if(!_fsPick.open) return;
        const t=e.touches[0]; if(!t) return;
        const edge=(e.target && e.target.dataset && e.target.dataset.edge)||'move';
        _fsStartDrag(edge, t.clientX, t.clientY);
        _touchMode='drag';
        _tapStart=null;
        e.preventDefault(); e.stopPropagation();
      },{passive:false});
      hl.addEventListener('mousedown', e=>{
        if(!_fsPick.open) return;
        const edge=(e.target && e.target.dataset && e.target.dataset.edge)||'move';
        _fsStartDrag(edge, e.clientX, e.clientY);
        _mouseDown=false; // don't trigger pan
        e.preventDefault(); e.stopPropagation();
      });
    }
    // Patch the global mouse/touch move/end handlers to also service highlight drags.
    // We intercept via a separate window-level listener that fires first.
    window.addEventListener('touchmove', e=>{
      if(!_fsPick.open||!_fsPick.drag) return;
      const t=e.touches[0]; if(!t) return;
      if(_fsMoveDrag(t.clientX,t.clientY)){ e.preventDefault(); e.stopPropagation(); }
    },{passive:false,capture:true});
    window.addEventListener('touchend', e=>{
      if(!_fsPick.open||!_fsPick.drag) return;
      _fsPick.drag=null; _touchMode=null;
      e.preventDefault();
    },{capture:true});
    window.addEventListener('touchcancel', ()=>{ if(_fsPick.drag) _fsPick.drag=null; },{capture:true});
    window.addEventListener('mousemove', e=>{
      if(!_fsPick.open||!_fsPick.drag) return;
      if(_fsMoveDrag(e.clientX,e.clientY)) e.preventDefault();
    },{capture:true});
    window.addEventListener('mouseup', ()=>{ if(_fsPick.drag) _fsPick.drag=null; },{capture:true});
    window.addEventListener('resize', ()=>{ if(_fsPick.open) openFullscreenPicker(); });
    window.addEventListener('keydown', e=>{
      if(!_fsPick.open) return;
      if(e.key==='Escape') closeFullscreenPicker();
      else if(e.key==='+'||e.key==='=') fsSetZoom(_fsPick.zoom*1.25);
      else if(e.key==='-') fsSetZoom(_fsPick.zoom/1.25);
      else if(e.key==='0') fsZoomFit();
    });
  })();

  // ---------- OCR lab analysis from photo (Tesseract.js, lazy-load) ----------
  const OCR = { worker:null, busy:false };
  // ---------- Lightbox for OCR preview thumbnails (pinch/zoom/pan on touch, wheel on desktop) ----------
  let _ocrLb = null;
  function openOcrLightbox(src, allUrls){
    closeOcrLightbox();
    const urls = Array.isArray(allUrls)?allUrls:[src];
    let idx = Math.max(0, urls.indexOf(src));
    const overlay=document.createElement('div');
    overlay.id='ocrLightbox';
    Object.assign(overlay.style,{
      position:'fixed', inset:'0', zIndex:99999, background:'rgba(0,0,0,0.92)',
      display:'flex', alignItems:'center', justifyContent:'center',
      touchAction:'none', userSelect:'none', flexDirection:'column'
    });
    const closeBtn=document.createElement('button');
    closeBtn.textContent='✕ Закрыть';
    Object.assign(closeBtn.style,{
      position:'absolute', top:'10px', right:'10px', zIndex:2, padding:'8px 14px',
      background:'rgba(255,255,255,0.15)', color:'#fff', border:'1px solid rgba(255,255,255,0.3)',
      borderRadius:'8px', fontSize:'15px', cursor:'pointer'
    });
    const prevB=document.createElement('button'); prevB.textContent='‹';
    const nextB=document.createElement('button'); nextB.textContent='›';
    [prevB,nextB].forEach(b=>Object.assign(b.style,{
      position:'absolute', top:'50%', transform:'translateY(-50%)', zIndex:2,
      width:'48px', height:'48px', borderRadius:'50%', fontSize:'28px',
      background:'rgba(255,255,255,0.15)', color:'#fff', border:'1px solid rgba(255,255,255,0.3)',
      cursor:'pointer'
    }));
    prevB.style.left='10px'; nextB.style.right='10px';
    prevB.style.display=nextB.style.display = urls.length>1?'':'none';
    const wrap=document.createElement('div');
    Object.assign(wrap.style,{position:'absolute', inset:'0', overflow:'hidden', display:'flex', alignItems:'center', justifyContent:'center'});
    const img=document.createElement('img');
    Object.assign(img.style,{maxWidth:'100%', maxHeight:'100%', transformOrigin:'0 0', willChange:'transform', transition:'transform 0.08s linear'});
    wrap.appendChild(img);
    const lbl=document.createElement('div');
    Object.assign(lbl.style,{position:'absolute', bottom:'12px', left:0, right:0, textAlign:'center', color:'#fff', fontSize:'13px', textShadow:'0 1px 2px #000', zIndex:2});
    overlay.appendChild(closeBtn); overlay.appendChild(prevB); overlay.appendChild(nextB);
    overlay.appendChild(wrap); overlay.appendChild(lbl);
    document.body.appendChild(overlay);
    // Zoom/pan state
    let scale=1, tx=0, ty=0;
    function apply(){ img.style.transform=`translate(${tx}px,${ty}px) scale(${scale})`; }
    function show(){
      img.src=urls[idx];
      scale=1; tx=0; ty=0; apply();
      lbl.textContent = urls.length>1? `Изображение ${idx+1} из ${urls.length} — зум пальцами/колесом, перетаскивание` : 'Зум пальцами/колесом, перетаскивание';
    }
    function resetFit(){ scale=1; tx=0; ty=0; apply(); }
    // Wheel zoom (desktop)
    overlay.addEventListener('wheel',e=>{
      e.preventDefault();
      const rect=wrap.getBoundingClientRect();
      const cx=e.clientX-rect.left-rect.width/2, cy=e.clientY-rect.top-rect.height/2;
      const f = e.deltaY<0 ? 1.2 : 1/1.2;
      const ns=Math.max(1, Math.min(8, scale*f));
      tx = cx - (cx-tx)*(ns/scale);
      ty = cy - (cy-ty)*(ns/scale);
      scale=ns; apply();
    },{passive:false});
    // Touch: pinch + pan
    let touches=[], lastDist=0, lastMid=null, panStart=null;
    overlay.addEventListener('touchstart',e=>{
      touches=[...e.touches];
      if(touches.length===1){ panStart={x:touches[0].clientX-tx, y:touches[0].clientY-ty}; lastDist=0; }
      else if(touches.length===2){
        const dx=touches[0].clientX-touches[1].clientX, dy=touches[0].clientY-touches[1].clientY;
        lastDist=Math.hypot(dx,dy); lastMid={x:(touches[0].clientX+touches[1].clientX)/2, y:(touches[0].clientY+touches[1].clientY)/2};
        panStart=null;
      }
    },{passive:false});
    overlay.addEventListener('touchmove',e=>{
      e.preventDefault();
      const tt=[...e.touches];
      if(tt.length===1 && panStart){ tx=tt[0].clientX-panStart.x; ty=tt[0].clientY-panStart.y; apply(); }
      else if(tt.length===2 && lastDist>0){
        const dx=tt[0].clientX-tt[1].clientX, dy=tt[0].clientY-tt[1].clientY;
        const d=Math.hypot(dx,dy);
        const ns=Math.max(1, Math.min(8, scale*d/lastDist));
        tx = lastMid.x - wrap.getBoundingClientRect().left - wrap.clientWidth/2 - (lastMid.x - wrap.getBoundingClientRect().left - wrap.clientWidth/2 - tx)*(ns/scale);
        ty = lastMid.y - wrap.getBoundingClientRect().top - wrap.clientHeight/2 - (lastMid.y - wrap.getBoundingClientRect().top - wrap.clientHeight/2 - ty)*(ns/scale);
        scale=ns; lastDist=d; apply();
      }
    },{passive:false});
    overlay.addEventListener('touchend',e=>{
      if(e.touches.length===0){ panStart=null; lastDist=0; }
      else if(e.touches.length===1){ panStart={x:e.touches[0].clientX-tx, y:e.touches[0].clientY-ty}; lastDist=0; }
    });
    // Double tap / double click to toggle zoom
    let lastTap=0;
    overlay.addEventListener('click',e=>{
      if(e.target!==img && e.target!==wrap && e.target!==overlay) return;
      const now=Date.now();
      if(now-lastTap<300){ if(scale>1.2) resetFit(); else { scale=2.5; apply(); } lastTap=0; }
      else lastTap=now;
    });
    closeBtn.addEventListener('click', closeOcrLightbox);
    prevB.addEventListener('click',()=>{ if(urls.length>1){ idx=(idx-1+urls.length)%urls.length; show(); } });
    nextB.addEventListener('click',()=>{ if(urls.length>1){ idx=(idx+1)%urls.length; show(); } });
    overlay.addEventListener('keydown',e=>{
      if(e.key==='Escape') closeOcrLightbox();
      else if(e.key==='ArrowLeft') prevB.click();
      else if(e.key==='ArrowRight') nextB.click();
    });
    show();
    _ocrLb=overlay;
  }
  function closeOcrLightbox(){
    if(_ocrLb){ _ocrLb.remove(); _ocrLb=null; }
  }
  function initOCRCard(){
    const card=$('#ocrCard'); if(!card) return;
    card.style.display='';
    // Support BOTH camera and gallery inputs
    const inputs=['labPhotoCam','labPhotoGal'].map(id=>document.getElementById(id)).filter(Boolean);
    const status=$('#ocrStatus');
    const preview=$('#ocrPreview');
    const cancelBtn=$('#ocrCancel');
    const clearBtn=$('#ocrClear');
    function clearAll(){
      OCR.busy=false;
      if(OCR.worker){ try{OCR.worker.terminate();}catch(e){} OCR.worker=null; }
      preview.innerHTML='';
      const oldDbg=document.getElementById('ocrRawText');
      if(oldDbg) oldDbg.remove();
      if(cancelBtn) cancelBtn.style.display='none';
      if(clearBtn) clearBtn.style.display='none';
      if(status) status.textContent='Выберите фото — бланк с анализами (сфотографируйте или из галереи).';
    }
    if(clearBtn) clearBtn.addEventListener('click', clearAll);
    async function onFile(e){
      const inp = e.target;
      // IMPORTANT: clone the FileList into a real Array BEFORE resetting input.value.
      const arr = inp.files ? Array.from(inp.files) : [];
      inp.value='';
      if(!arr.length){
        if(status) status.textContent='Файл не выбран.';
        return;
      }
      if(cancelBtn) cancelBtn.style.display='';
      if(clearBtn) clearBtn.style.display='';
      // Clear PREVIOUS results (debug box + thumbnails) so we don't show stale thumbs from last run
      preview.innerHTML='';
      const oldDbg=document.getElementById('ocrRawText');
      if(oldDbg) oldDbg.remove();
      if(status) status.innerHTML='📥 Получено файлов: <b>'+arr.length+'</b>. Загружаю и подготавливаю изображение...';
      try{
        await runOCR(arr, status, cancelBtn, preview, clearBtn);
      }catch(err){
        console.error('ocr top-level error', err);
        if(status) status.innerHTML='❌ Ошибка: '+(err && err.message?err.message:err);
      }
    }
    inputs.forEach(inp=>inp.addEventListener('change', onFile));
    if(cancelBtn){
      cancelBtn.addEventListener('click', ()=>{
        OCR.busy=false;
        cancelBtn.style.display='none';
        if(status) status.innerHTML='Распознавание отменено. Выберите новое фото.';
      });
    }
  }
  // ---------- Pre-process photo for better OCR ----------
  // Minimal: resize + grayscale + contrast stretch. Clean printed tables read better WITHOUT
  // binarization/sharpen — those produce edge artifacts that Tesseract reads as garbage letters.
  function preprocessImageForOCR(source){
    // Accept HTMLImageElement or canvas; treat canvas as already-resized at correct dims
    const isCanvas = !!(source && source.getContext);
    let w, h, sx, sy;
    if(isCanvas){ w=source.width; h=source.height; sx=source; sy=source.getContext('2d'); }
    else {
      const iw=source.naturalWidth||source.width, ih=source.naturalHeight||source.height;
      const TARGET_W=1800;
      const ratio=Math.min(2.5, Math.max(1, TARGET_W/Math.max(iw,1)));
      w=Math.round(iw*ratio); h=Math.round(ih*ratio);
      sx=document.createElement('canvas'); sx.width=w; sx.height=h;
      sy=sx.getContext('2d');
      sy.fillStyle='#fff'; sy.fillRect(0,0,w,h);
      sy.imageSmoothingEnabled=true; sy.imageSmoothingQuality='high';
      sy.drawImage(source,0,0,w,h);
    }
    const c=sx, ctx=sy;
    const imgd=ctx.getImageData(0,0,w,h); const d=imgd.data;
    // Grayscale
    for(let i=0;i<d.length;i+=4){
      const g=(0.299*d[i]+0.587*d[i+1]+0.114*d[i+2])|0;
      d[i]=d[i+1]=d[i+2]=g;
    }
    // Mild contrast stretch (2%/98%) — don't clip aggressively so decimal commas survive
    const hist=new Uint32Array(256);
    for(let i=0;i<d.length;i+=4) hist[d[i]]++;
    const total=d.length/4; let lo=0, hi=255, acc=0;
    for(let i=0;i<256;i++){ acc+=hist[i]; if(acc/total>=0.02){lo=i;break;} }
    acc=0; for(let i=255;i>=0;i--){ acc+=hist[i]; if(acc/total>=0.02){hi=i;break;} }
    if(hi<=lo) hi=lo+1;
    const scale=255/(hi-lo);
    const lut=new Uint8ClampedArray(256);
    for(let i=0;i<256;i++){
      let v=(i-lo)*scale;
      if(v<0)v=0; else if(v>255)v=255;
      lut[i]=v;
    }
    for(let i=0;i<d.length;i+=4) d[i]=d[i+1]=d[i+2]=lut[d[i]];
    ctx.putImageData(imgd,0,0);
    return c.toDataURL('image/png'); // lossless so commas/dots aren't JPEG-blurred
  }
  function loadImageFromUrl(url){
    return new Promise((res,rej)=>{
      const im=new Image();
      im.onload=()=>res(im);
      im.onerror=()=>rej(new Error('image load error'));
      im.src=url;
    });
  }
  function fileToDataURL(f){
    return new Promise((res,rej)=>{
      const r=new FileReader();
      r.onload=ev=>res(ev.target.result);
      r.onerror=()=>rej(new Error('file read error'));
      r.readAsDataURL(f);
    });
  }
  async function getTessWorker(status){
    if(OCR.worker) return OCR.worker;
    if(typeof window.Tesseract==='undefined'){
      if(status) status.innerHTML='⌛ Загружаю Tesseract.js (~1 МБ)... <span id="ocrProg"></span>';
      await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
    }
    if(status) status.innerHTML='⌛ Загружаю словари rus+eng (~3 МБ, только при первом запуске)... <span id="ocrProg"></span>';
    const prog=document.getElementById('ocrProg');
    // Tesseract.js v5: createWorker(lang, oem?, options?) — oem=1 is LSTM only (best for printed text)
    const worker = await window.Tesseract.createWorker(['rus','eng'], 1, {
      logger: m=>{ try{ if(prog && m.status){ prog.textContent = ' · '+m.status+(m.progress?' '+(m.progress*100).toFixed(0)+'%':''); } }catch(e){} }
    });
    // PSM 6 = "Assume a single uniform block of text" — ideal for lab tables.
    // No char whitelist — whitelists hurt accuracy when unexpected chars (↑↓↔, °, superscripts) appear.
    await worker.setParameters({
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1'
    });
    OCR.worker = worker;
    return worker;
  }
  // Render an Image onto a canvas rotated by angle (0, 90, 180, 270 degrees clockwise)
  function renderRotated(img, angle, maxW){
    const w0=img.naturalWidth||img.width, h0=img.naturalHeight||img.height;
    const scale = maxW ? Math.min(1, maxW/Math.max(w0,h0)) : 1;
    const w=Math.round(w0*scale), h=Math.round(h0*scale);
    const c=document.createElement('canvas');
    const rad=angle*Math.PI/180;
    if(angle===90||angle===270){ c.width=h; c.height=w; } else { c.width=w; c.height=h; }
    const ctx=c.getContext('2d');
    ctx.fillStyle='#fff'; ctx.fillRect(0,0,c.width,c.height);
    ctx.save();
    if(angle===90){ ctx.translate(h,0); ctx.rotate(rad); }
    else if(angle===180){ ctx.translate(w,h); ctx.rotate(rad); }
    else if(angle===270){ ctx.translate(0,w); ctx.rotate(rad); }
    ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
    ctx.drawImage(img,0,0,w,h);
    ctx.restore();
    return c;
  }
  // Robust rotation detection for LAB FORMS: try ALL 4 rotations with real Tesseract OCR
  // on a medium-size image (1100px) and pick the rotation that matches the most lab test
  // keywords AND contains the most decimal numbers (like 4,87 / 154 / 34,4).
  // This works on Sysmex/Invitro/Helix forms where column headers are printed vertically
  // and the page may be rotated 90° in either direction, or upside-down.
  async function detectOrientation(img, worker){
    const sampleW = 1100;
    const angles=[0,90,180,270];
    const KEYWORDS = /гемоглобин|эритроцит|лейкоцит|тромбоцит|гематокрит|ретикулоцит|лимфоцит|моноцит|эозинофил|базофил|нейтрофил|палочкоядер|сегменто|свертываем|фибриноген|ачтв|протромбин|тромбинов|мочевин|креатинин|билирубин|глюкоз|холестерин|алт|аст|щелочная|ггтп|лдг|кфк|амилаза|альбумин|общий белок|калий|натрий|кальций|магний|фосфор|железо|ттг|т4|т3|витамин|с-реактив|показатель|результат|исследов|референ|единиц|женщин|мужчин|фамил|отделен|дата|анализатор|сыворот|лейкоцитарн/i;
    let best=0, bestScore=-1;
    for(const ang of angles){
      const c = renderRotated(img, ang, sampleW);
      const url = c.toDataURL('image/jpeg', 0.8);
      try{
        const {data} = await worker.recognize(url);
        const txt = (data.text||'').toLowerCase().replace(/ё/g,'е');
        // Score: (1) number of keyword hits (strong signal)
        const kwHits = (txt.match(KEYWORDS)||[]).length;
        // (2) decimal numbers with comma/dot (like 4,87  154  34,4  0,7  12,3) — result column
        const decim = (txt.match(/\b\d{1,3}[,.]\d{1,2}\b/g)||[]).length;
        // (3) integers in plausible lab range (2-4 digits) — WBC, PLT etc.
        const ints = (txt.match(/\b\d{1,4}\b/g)||[]).length;
        // (4) Cyrillic letters in general
        const cyr = (txt.match(/[а-я]/g)||[]).length;
        // (5) Penalize if almost all text is single isolated letters (vertical text misread)
        const wordLen = txt.split(/\s+/).filter(w=>w.length>=3).length;
        // Combine: keyword hits are the strongest signal; decimals are results column
        let score = kwHits*15 + decim*4 + wordLen*0.5 + cyr*0.02 + Math.min(ints,50)*0.3;
        // Upside-down penalty: Tesseract usually reads far fewer keywords/words when flipped
        if(ang===180) score *= 0.85;
        if(score > bestScore){ bestScore=score; best=ang; }
      }catch(e){}
    }
    return best;
  }
  async function runOCRonOne(url, status){
    const orig = await loadImageFromUrl(url);
    if(status) status.innerHTML='🔎 Определяю ориентацию бланка... <span id="ocrProg"></span>';
    const worker = await getTessWorker(status);
    // Determine best orientation by running Tesseract on all 4 rotations (robust for vertical-column forms)
    let angle;
    try{ angle = await detectOrientation(orig, worker); }catch(e){ angle = detectBestRotation(orig, {mode:'lab'}); }
    if(status) status.innerHTML='🔍 Распознаю... <span id="ocrProg"></span>';
    // Render rotated full-size and preprocess
    const rotated = renderRotated(orig, angle, 1800);
    const cleaned = preprocessImageForOCR(rotated);
    const { data } = await worker.recognize(cleaned);
    let text = (data.text||'').replace(/\r/g,'\n');
    text = text.replace(/ё/g,'е').replace(/Ё/g,'Е');
    // Collapse leader dots/dashes between name and value to a single space
    text = text.replace(/[.·•…_\-]{2,}/g,' ');
    // Common OCR substitutions
    text = text.replace(/[|Iіl]{1,3}(?=[0-9])/g,'1');
    text = text.replace(/(?<=[0-9])[оО](?=[0-9])/g,'0');
    // Build a thumbnail already rotated to correct orientation for preview
    const thumbCvs = renderRotated(orig, angle, 600);
    const thumbUrl = thumbCvs.toDataURL('image/jpeg', 0.82);
    return {text, angle, thumbUrl};
  }
  async function runOCR(files, status, cancelBtn, preview, clearBtn){
    if(OCR.busy){ if(status)status.textContent='Идёт другое распознавание, подождите...'; return; }
    OCR.busy=true;
    let cancelled=false;
    const prevCancel = cancelBtn&&cancelBtn.onclick;
    try{
      if(cancelBtn){
        cancelBtn.style.display='';
        cancelBtn.onclick=()=>{
          cancelled=true;
          if(cancelBtn) cancelBtn.style.display='none';
          if(status) status.innerHTML='Распознавание отменено.';
        };
      }
      const fileList = Array.isArray(files) ? files : [files];
      if(preview){
        preview.innerHTML='<div style="color:#666;font-size:13px">Подготавливаю изображения ('+fileList.length+' шт)...</div>';
      }
      const urls=[];           // original data URLs (for full-size lightbox)
      const displayUrls=[];    // rotated preview URLs (replaced after orientation detect)
      for(let i=0;i<fileList.length;i++){
        const u = await fileToDataURL(fileList[i]);
        urls.push(u);
        displayUrls.push(u);
      }
      const ocrAngles = new Array(urls.length).fill(0); // manual-rotation delta for each photo
      async function rerunAtAngle(i, delta){
        if(OCR.busy){ status.textContent='Идёт распознавание, подождите...'; return; }
        ocrAngles[i] = (ocrAngles[i] + delta + 360) % 360;
        status.innerHTML='🔄 Поворачиваю фото '+(i+1)+' на '+Math.abs(delta)+'° и распознаю заново...';
        try{
          const orig = await loadImageFromUrl(urls[i]);
          // Build rotated canvas at user angle + heuristic best for that image
          const forced = ocrAngles[i];
          const rot = renderRotated(orig, forced, 1800);
          // Re-do OCR on this rotated image
          const worker = await getTessWorker(status);
          const cleaned = preprocessImageForOCR(rot);
          const {data} = await worker.recognize(cleaned);
          let text = (data.text||'').replace(/\r/g,'\n').replace(/ё/g,'е').replace(/Ё/g,'Е');
          text = text.replace(/[.·•…_\-]{2,}/g,' ');
          text = text.replace(/[|Iіl]{1,3}(?=[0-9])/g,'1');
          text = text.replace(/(?<=[0-9])[оО](?=[0-9])/g,'0');
          const thumbCvs = renderRotated(orig, forced, 600);
          displayUrls[i] = thumbCvs.toDataURL('image/jpeg',0.82);
          // Clear previously filled values from THIS photo's hits (we re-parse fresh)
          // — simpler: do NOT clear; just add new matches on top.
          let parseText = text.replace(/\s*[↑↓↔▲▼]\s*/g,' ')
            .replace(/[ \t]*([.\u00B7\u2022·•*\-–—]{2,}|\.(\s+\.){1,})[ \t]*/g,' ')
            .replace(/[ \t]+/g,' ');
          parseText = parseText.replace(/\bн\s*\/\s*о\b/gi,' 0 н/о');
          const filled = fillAnalysesFromText(parseText, {lineByLine:true});
          // Update raw text box
          const dbg=document.getElementById('ocrRawText');
          if(dbg){
            const pre = dbg.querySelector('pre');
            const marker = '=== фото '+(i+1);
            let cur = pre.textContent;
            const re = new RegExp('\\n?\\n=== фото '+(i+1)+'[^=]*?(?=\\n\\n=== фото |$)','s');
            const block = '\n\n=== фото '+(i+1)+' (поворот '+forced+'°) ===\n'+text;
            cur = cur.replace(re, block);
            pre.textContent = cur;
          } else {
            totalText += '\n\n=== фото '+(i+1)+' (поворот '+forced+'°) ===\n'+text;
          }
          totalFilled += filled;
          renderThumbs();
          if(status) status.innerHTML = '✅ Фото '+(i+1)+' повернуто ('+forced+'°), найдено полей: <b>'+filled+'</b>. Всего заполнено: <b>'+totalFilled+'</b>.';
          // green border
          const imgs=preview.querySelectorAll('img');
          if(imgs[i]){ imgs[i].style.borderColor='#2e7d32'; imgs[i].title='Поворот '+forced+'°, заполнено '+filled; }
        }catch(err){
          console.error(err);
          status.innerHTML='❌ Ошибка при повторе: '+(err.message||err);
        }
      }
      function renderThumbs(){
        if(!preview) return;
        preview.innerHTML = displayUrls.map((u,i)=>{
          return '<div style="display:inline-block;text-align:center;margin:4px;vertical-align:top">'+
            '<img data-idx="'+i+'" src="'+u+'" data-full="'+u+'" style="max-height:160px;border-radius:6px;border:2px solid #ccc;cursor:zoom-in;display:block" title="Нажмите для увеличения" />'+
            '<div style="display:flex;gap:4px;margin-top:4px;justify-content:center">'+
              '<button data-rot-l="'+i+'" style="padding:3px 8px;font-size:12px;border:1px solid #aaa;border-radius:6px;background:#f5f5f5;cursor:pointer" title="Повернуть против часовой стрелки и перечитать">↺ 90°</button>'+
              '<button data-rot-r="'+i+'" style="padding:3px 8px;font-size:12px;border:1px solid #aaa;border-radius:6px;background:#f5f5f5;cursor:pointer" title="Повернуть по часовой стрелке и перечитать">↻ 90°</button>'+
            '</div></div>';
        }).join('');
        preview.querySelectorAll('img[data-full]').forEach(im=>{
          im.addEventListener('click', ()=>openOcrLightbox(im.dataset.full, displayUrls));
        });
        preview.querySelectorAll('button[data-rot-l]').forEach(b=>b.addEventListener('click',()=>{
          const i=parseInt(b.getAttribute('data-rot-l'),10); rerunAtAngle(i,-90);
        }));
        preview.querySelectorAll('button[data-rot-r]').forEach(b=>b.addEventListener('click',()=>{
          const i=parseInt(b.getAttribute('data-rot-r'),10); rerunAtAngle(i,90);
        }));
      }
      renderThumbs();

      let totalText='';
      let totalFilled=0;
      for(let i=0;i<urls.length;i++){
        if(cancelled) break;
        if(status){
          status.innerHTML = `📸 Фото <b>${i+1}/${urls.length}</b>: распознаю... <span id="ocrProg"></span>`;
        }
        if(preview){
          const imgs=preview.querySelectorAll('img');
          imgs.forEach((im,ix)=>{ im.style.borderColor = ix===i ? '#ff9800' : (ix<i?'#2e7d32':'#ccc'); });
        }
        try{
          const res = await runOCRonOne(urls[i], status);
          const text = res.text;
          displayUrls[i] = res.thumbUrl;
          renderThumbs();
          totalText += '\n\n=== фото '+(i+1)+' (поворот '+res.angle+'°) ===\n'+text;
          let parseText = text
            .replace(/\s*[↑↓↔▲▼]\s*/g, ' ')
            .replace(/[ \t]*([.\u00B7\u2022·•*\-–—]{2,}|\.(\s+\.){1,})[ \t]*/g, ' ')
            .replace(/[ \t]+/g,' ');
          parseText = parseText.replace(/\bн\s*\/\s*о\b/gi,' 0 н/о');
          const filled = fillAnalysesFromText(parseText, {lineByLine:true});
          totalFilled += filled;
          if(preview){
            const imgs=preview.querySelectorAll('img');
            if(imgs[i]){
              imgs[i].style.borderColor='#2e7d32';
              imgs[i].title='Заполнено '+filled+' полей';
            }
          }
        }catch(err){
          console.error('ocr err',i,err);
          if(preview){
            const imgs=preview.querySelectorAll('img');
            if(imgs[i]){ imgs[i].style.borderColor='#c62828'; }
          }
        }
      }
      const debugId='ocrRawText';
      let dbg=document.getElementById(debugId);
      if(!dbg && preview){
        dbg=document.createElement('details');
        dbg.id=debugId; dbg.style.marginTop='8px'; dbg.style.fontSize='12px';
        dbg.innerHTML=`<summary style="cursor:pointer;color:#555">📄 Показать сырой текст OCR (для проверки)</summary><pre style="white-space:pre-wrap;background:#f4f4f4;padding:8px;max-height:240px;overflow:auto;border-radius:6px;margin-top:6px"></pre>`;
        preview.parentNode.appendChild(dbg);
      }
      if(dbg) dbg.querySelector('pre').textContent=totalText;
      if(!cancelled){
        if(status) status.innerHTML = `✅ Готово. Обработано фото: <b>${urls.length}</b>, заполнено/обновлено полей: <b style="color:#2e7d32;font-size:16px">${totalFilled}</b>. Проверьте значения перед сохранением — OCR может ошибаться. <b>Обязательно сверьте с бумажным бланком.</b>`;
      }
    } catch(e){
      console.error(e);
      if(status && !cancelled) status.innerHTML='❌ Ошибка: '+(e.message||e);
    } finally {
      OCR.busy=false;
      if(cancelBtn){ cancelBtn.style.display='none'; cancelBtn.onclick=prevCancel; }
      if(clearBtn) clearBtn.style.display='';
    }
  }
  function loadScript(src){
    return new Promise((res,rej)=>{
      const s=document.createElement('script'); s.src=src; s.async=true;
      s.onload=()=>res(); s.onerror=()=>rej(new Error('Не удалось загрузить '+src));
      document.head.appendChild(s);
    });
  }
  // Map OCR text → analysis fields by keyword matching
  function fillAnalysesFromText(text, opts){
    opts = opts||{};
    const lineByLine = !!opts.lineByLine;
    // Normalize spaces but PRESERVE newlines for line-by-line mode
    const norm = s => String(s||'').toLowerCase().replace(/ё/g,'е').replace(/[^а-яa-z0-9]/g,'');
    // Collapse runs of spaces/tabs but keep \n as line separator
    let t0 = String(text||'').toLowerCase().replace(/ё/g,'е').replace(/\r/g,'\n').replace(/[ \t\xA0]+/g,' ');
    t0 = t0.replace(/\n{2,}/g,'\n').replace(/^[ \n]+|[ \n]+$/g,'');
    const t = ' '+t0.replace(/\n/g,' ')+' '; // global space-only version for fallback
    let filled=0;
    // Aliases: normalized-name -> array of (raw regex) tokens to look for. Sorted longest-first for safety.
    // Keys are normalized version of what we'll match against test names.
    const aliases = [
      // Coagulation (top of user's Sysmex form: АЧТВ, ПВ, ПВ Ratio, % протромб.комплекса, МНО, Фибриноген по Клаусу)
      { ids:['aptt'], names:['ачтв ratio','ачтв','аптв','ахтв','активированное частичное тромбопластиновое','ptt','aptt'] },
      { ids:['pti'], names:['% активности протромбинового комплекса','протромбинового комплекса','активности протромбинового','% протромбина по квику','% по квику','prothrombin index','пти','pti'] },
      { ids:['pt'], names:['пв ratio','pb ratio','пр ratio','prothrombin ratio','prothrombin time','pt ratio','протромбиновое время','пв ','мно','mho','инр','inr'] },
      { ids:['fib'], names:['фибриноген по клаусу','фибриноген','fibrinogen','фбг'] },
      { ids:['tt'], names:['тромбиновое время','тв ','thrombin time'] },
      { ids:['dimer'], names:['д-димер','d-dimer','д димер'] },
      // CBC (Sysmex layout)
      { ids:['hgb'], names:['гемоглобин','hemoglobin','hgb','hb ','гб '] },
      { ids:['rbc'], names:['эритроциты','erythrocyte','rbc','red blood','эр.'] },
      { ids:['wbc'], names:['лейкоциты','leukocyte','leukocyt','wbc','лейк.'] },
      { ids:['plt'], names:['тромбоциты','platelet','plt','тромб.'] },
      { ids:['hct'], names:['гематокрит','hematocrit','hct','ht'] },
      { ids:['mcv'], names:['mcv','средний объём эритроцита'] },
      { ids:['mch'], names:['mch ','мсн ','среднее содержание hb','среднее содержание гемоглобина'] },
      { ids:['mchc'], names:['mchc','мснс','средняя концентрация hb','средняя концентрация гемоглобина'] },
      { ids:['rdw'], names:['rdw','ширина распределения эритроцитов','rdw-cv'] },
      { ids:['esr'], names:['соэ','esr','скорость оседания'] },
      // Leukocyte formula: "(кач)" = %, "(кол)" = ×10⁹/л (Sysmex forms)
      { ids:['baso'], names:['базофилы (кач)','базофилы,%','базофилы, %','базофилы кач','basophils %'] },
      { ids:['baso_abs'], names:['базофилы (кол)','базофилы кол','базофилы, 10','basophils absolute','абс. базофилы'] },
      { ids:['eo'], names:['эозинофилы (кач)','эозинофилы,%','эозинофилы, %','эозинофилы кач','eosinophil %','эозинофилы,'] },
      { ids:['eos_abs'], names:['эозинофилы (кол)','эозинофилы кол','эозинофилы, 10','eosinophil absolute','абс. эозинофилы'] },
      { ids:['neut'], names:['нейтрофилы (кач)','нейтрофилы,%','нейтрофилы, %','нейтрофилы кач','сегментоядерные нейтрофилы','neutrophil %','нейтрофилы общие'] },
      { ids:['neut_abs'], names:['нейтрофилы (кол)','нейтрофилы кол','нейтрофилы, 10','нейтрофилы абс','neutrophil absolute','абс. нейтрофилы'] },
      { ids:['lym'], names:['лимфоциты (кач)','лимфоциты,%','лимфоциты, %','лимфоциты кач','lymphocyte %','лимфоциты,'] },
      { ids:['lym_abs'], names:['лимфоциты (кол)','лимфоциты кол','лимфоциты, 10','лимфоциты абс','lymphocyte absolute','абс. лимфоциты'] },
      { ids:['mono'], names:['моноциты (кач)','моноциты,%','моноциты, %','моноциты кач','monocyte %','моноциты,'] },
      { ids:['mono_abs'], names:['моноциты (кол)','моноциты кол','моноциты, 10','моноциты абс','monocyte absolute','абс. моноциты'] },
      { ids:['band'], names:['палочкоядерные','палочкоядер','band neut','band form','сдвиг влево'] },
      { ids:['meta'], names:['незрелые гранулоциты','metamyelocyte','метамиелоциты','юные нейтрофилы','миелоциты','юные гранулоциты'] },
      // Biochemistry
      { ids:['glu'], names:['глюкоза','глюк','glucose','сахар в крови','сахар крови'] },
      { ids:['chol'], names:['холестерин общий','общий холестерин','общ. холестерин','холестерол','cholesterol total','total chol'] },
      { ids:['ldl'], names:['лпнп','лнп','ldl','липопротеины низкой плотности','холестерин лпнп','холестерин лнп'] },
      { ids:['hdl'], names:['лпвп','лвп','hdl','липопротеины высокой плотности','холестерин лпвп','холестерин лвп'] },
      { ids:['tg'], names:['триглицериды','триглицерид','трлг','tg','triglyceride'] },
      { ids:['creat'], names:['креатинин','creatinine','креат.'] },
      { ids:['urea'], names:['мочевина','urea','bun'] },
      { ids:['ua'], names:['мочевая кислота','uric acid','урическая к-та','uric','мочевой кислоты'] },
      { ids:['bili_total'], names:['билирубин общий','общий билирубин','bilirubin total','общ. билируб'] },
      { ids:['bili_dir'], names:['билирубин прямой','прямой билирубин','bilirubin direct','связанный билируб','конъюгирован'] },
      { ids:['alt'], names:['алт','аланин','алат','alt','аланинаминотрансфер'] },
      { ids:['ast'], names:['аст','аспартат','асат','ast','аспартатаминотрансфер'] },
      { ids:['alp'], names:['щелочная фосфатаза','щф','alp','alkaline phosph'] },
      { ids:['ggt'], names:['гамма-гт','гаммагт','ггт','ггтп','ggt','gamma glutamyl','γ-гт'] },
      { ids:['ldh'], names:['лдг','лдг','лактатдегидрогеназа','ldh','лактатдегидроген'] },
      { ids:['ck'], names:['кфк','креатинфосфокиназа','креатинкиназа','ck','креатин киназа'] },
      { ids:['amyl'], names:['альфа амилаза','альфа-амилаза','амилаза общая','амилаза','amylase',' α-амилаза','αамилаза','панкреатическая амилаза'] },
      { ids:['tprot'], names:['общий белок','total protein','общ. белок'] },
      { ids:['alb'], names:['альбумин','albumin'] },
      { ids:['fe'], names:['железо сывороточное','сывороточное железо','железо,','serum iron',' fe ','железо сыв'] },
      { ids:['cl'], names:['хлор','хлориды','chloride',' cl ','хлор сыворот'] },
      { ids:['ferritin'], names:['ферритин','ferritin'] },
      { ids:['crp'], names:['с-реактивный белок','срб','c-реактив','crp','c-reactive','с реактив'] },
      // Hormones
      { ids:['tsh'], names:['ттг','tsh','тиреотропный гормон','тиреотропн'] },
      { ids:['ft4'], names:['т4 св','т4 свободный','свободный т4','free t4','ft4','тироксин свободный'] },
      { ids:['ft3'], names:['т3 св','т3 свободный','свободный т3','free t3','ft3','трийодтиронин свобод'] },
      { ids:['atpo'], names:['ат-тпо','ат к тпо','антитела к тпо','анти тпо','anti-tpo','аттпо','анти-тпо'] },
      // Vitamins/elements
      { ids:['vitd'], names:['25(он)d','25-он d','25 он d','25(oh)d','25-hydroxyvitamin','витамин д','витамин d','25-гидрокси'] },
      { ids:['vitb12'], names:['витамин в12','цианокобаламин','в12','vitamin b12','cobalamin','b12'] },
      { ids:['vitb9'], names:['фолиевая кислота','фолат','folic acid','folate','в9','vitamin b9'] },
      { ids:['k'], names:['калий','kalium','k+',' к ','сывороточный калий'] },
      { ids:['na'], names:['натрий','natrium','na+',' na ','сывороточный натрий'] },
      { ids:['ca'], names:['кальций общий','общий кальций','calcium total','общ. кальций',' ca ','кальций,'] },
      { ids:['mg'], names:['магний','magnesium',' mg','сывороточный магний'] },
      { ids:['phos'], names:['фосфор неорганический','фосфор,','неорганический фосфор','р неорг','phosphorus','сывороточный фосфор'] },
      { ids:['zn'], names:['цинк','zinc',' zn'] },
      // Cardiac
      { ids:['troponin'], names:['тропонин','troponin','high-sensitivity troponin','тропонин i','тропонин т'] },
      { ids:['bnp'], names:['нбп','bnp','nt-probnp','probnp','натрийуретический пептид','мозговой натрийуретический'] },
      // Urinalysis
      { ids:['u_prot'], names:['белок в моче','urine protein','белок мочи','protein urine','белок, моча'] },
      { ids:['u_glu'], names:['глюкоза мочи','сахар мочи','глюкозурия','glucose urine'] },
      { ids:['u_leu'], names:['лейкоциты мочи','лейкоцитурия','wbc urine','лейкоциты в моче'] },
      { ids:['u_bld'], names:['эритроциты мочи','гематурия','rbc urine','эритроциты в моче','кровь в моче'] },
      { ids:['u_dens'], names:['относительная плотность','плотность мочи','удельный вес','urine density','относ плотност'] },
      { ids:['u_ph'], names:['реакция мочи',' ph ','рh мочи','ph мочи'] },
      { ids:['u_epi'], names:['эпителий плоский','плоский эпителий'] },
    ];
    // Find the first number after a keyword position, allowing long leader dots/spaces/arrows
    function pickTidAndVal(haystack, pos, a){
      // Try ids in order: prefer ids that have an expected range defined for higher accuracy,
      // then fall back to first id. Once a val is found with expected range, write to ALL ids of this alias.
      let val=null, usedTid=a.ids[0];
      const withRange = a.ids.filter(id=>EXPECTED[id]);
      const order = withRange.length? withRange : a.ids;
      for(const tid of order){
        const v = findNumberForTest(haystack, pos, tid);
        if(v!=null && !isNaN(v) && v>0 && v<100000){
          val=v; usedTid=tid; break;
        }
      }
      if(val==null) return null;
      return val;
    }
    function locateKeyIn(haystack, keyPhrase){
      const key = norm(keyPhrase);
      if(!key) return -1;
      const nt=[], pm=[];
      for(let i=0;i<haystack.length;i++){
        const ch=haystack[i];
        if(/[а-яa-z0-9ё]/i.test(ch)){ nt.push(ch.toLowerCase().replace('ё','е')); pm.push(i); }
      }
      const nts=nt.join('');
      let idx = nts.indexOf(key);
      if(idx<0 && key.length>=5) idx = nts.indexOf(key.slice(0,5));
      if(idx<0) return -1;
      return pm[idx];
    }
    function locateKey(keyPhrase){ return locateKeyIn(t, keyPhrase); }
    function writeTestValue(testId, val){
      if(val==null||isNaN(val)) return false;
      // Find input matching this test id
      const row = document.querySelector(`.test-row[data-test="${testId}"] .test-input`);
      if(!row) return false;
      row.value = String(val).replace('.',',');
      try{
        const r=row.closest('.test-row');
        const group = ANALYSIS_GROUPS.find(g=>r && r.getAttribute('data-group')===g.id);
        const t2 = group && group.tests.find(tt=>tt.id===testId);
        if(group && t2) evaluateRow(group,t2,r);
      }catch(e){}
      return true;
    }
    // ---- Build expected value range per test id from ANALYSIS_GROUPS (with generous margin) ----
    const EXPECTED = (()=>{
      const out={};
      if(typeof ANALYSIS_GROUPS==='undefined') return out;
      for(const g of ANALYSIS_GROUPS) for(const tt of (g.tests||[])){
        if(!tt || !tt.id || !tt.ranges) continue;
        let lo=Infinity, hi=-Infinity;
        for(const k of Object.keys(tt.ranges)){
          const r=tt.ranges[k];
          if(Array.isArray(r) && r.length===2){
            if(r[0]<lo) lo=r[0];
            if(r[1]>hi) hi=r[1];
          }
        }
        if(isFinite(lo) && isFinite(hi)){
          // Allow wide margin: from lo/50 to hi*20 for decimal shifts; for very big numbers also allow
          // missing-comma X→X,XX only within plausible human lab ranges.
          const margin = Math.max(hi*1.5, lo*0.5);
          out[tt.id] = { lo: Math.max(0, lo*0.3), hi: Math.min(1e7, hi*5) };
          // "human" range is what a real value of this test can be, with no OCR errors possible
          out[tt.id].human = { lo: Math.max(0, lo*0.4), hi: hi*3 };
        }
      }
      return out;
    })();
    // Extract ALL candidate numbers from a segment, with their position and also with a
    // "comma-shifted" variant (e.g. 489 → 4.89, 664 → 6.64, 2120 → 2.120, 111 → 11.1).
    // Candidates are objects {value, isFirstAfterUnit, start, end}.
    function extractCandidates(segment){
      const NUM_RE=/(\d+)(?:[.,·:\/](\d{1,3}))?/g;
      const SCALE_AFTER=/^\s{0,3}[°\^º0-9⁰¹²³⁴⁵⁶⁷⁸⁹·.\-*/]*(л|г|е|е\/л|u\/l|fl|pg|кл|клет|клв)/i;
      const UNIT_AFTER=/^\s{0,3}(г\/л|мг\/л|мг\/дл|мкг\/л|мкмоль\/л|ммоль\/л|моль\/л|ед\/л|е\/л|мкме\/мл|нг\/мл|мкг\/мл|%|сек|фл|пг|мке)|^\s{0,3}[гмлнстфпμ%](\s*[/\/°^º0-9а-яёa-z])|^\s{0,3}(мг|мкг|мкм|мм|нг|ед|е|кл)(\s*[/\/°^º0-9а-яёa-z])/i;
      const out=[];
      let m;
      while((m=NUM_RE.exec(segment))!==null){
        const intp=m[1], frac=m[2];
        const start=m.index, end=m.index+m[0].length;
        const raw = parseFloat(intp+'.'+(frac||'0'));
        const after = segment.substr(end,25);
        const isScale = (raw===10||raw===100||raw===1000) && SCALE_AFTER.test(after);
        const isUnit = UNIT_AFTER.test(after);
        if(isScale) continue;
        // base candidate (as read)
        out.push({value:raw, isUnitAfter:isUnit, start, end, shifted:false});
        // also generate shifted variants (missing comma) for integers, several positions
        if(!frac){
          // variants: comma after 1st digit (489→4.89), after 2nd (489→48.9)
          for(let cut=1; cut<intp.length; cut++){
            const v = parseFloat(intp.slice(0,cut)+'.'+intp.slice(cut));
            if(v>0 && v<10000) out.push({value:v, isUnitAfter:isUnit, start, end, shifted:true});
          }
        }
      }
      return out;
    }
    // Given keyword position and target test id, pick the best-matching number candidate using
    // expected range. Algorithm:
    //   1. Collect all numeric candidates after the keyword (within window).
    //   2. Skip candidates that are a UNIT SCALE ("10" in "10°л", "10^9/л").
    //   3. Score each candidate by how close it is to the expected range, and by whether a unit
    //      word appears immediately after (high signal).
    //   4. Also skip candidates that look like reference-range values (after a unit, between two numbers with dash).
    function findNumberForTest(haystack, startPos, testId){
      const exp = EXPECTED[testId];
      const end = Math.min(haystack.length, startPos+120);
      const segment = haystack.slice(startPos, end);
      let cands = extractCandidates(segment);
      // If there's a Cyrillic word (3+ letters, not a unit) after some candidate, cut the list there.
      let cutIdx = cands.length;
      const after0 = segment;
      for(let i=0;i<cands.length;i++){
        const tail = segment.slice(cands[i].end);
        const m = tail.match(/^[\s.·•*_=:0-9,·:\/\-–—]*([а-яА-ЯёЁa-zA-Z]{3,})/);
        if(m){
          const word = m[1];
          if(!/^(мг|мкг|мкм|мм|нг|ед|мке|кл|г|л|мл|сек|фл|пг|кач|кол)$/i.test(word)){
            cutIdx = i+1; break;
          }
        }
      }
      cands = cands.slice(0,cutIdx);
      // If expected range is known, prefer candidates inside range; then candidates near range.
      if(exp){
        // Score: lower is better. in-human-range with unit after → score 0.
        let best=null, bestScore=Infinity;
        for(let i=0;i<cands.length;i++){
          const c = cands[i];
          let score;
          const v = c.value;
          if(v>=exp.human.lo && v<=exp.human.hi){
            score = c.isUnitAfter ? 0 : 1;
          } else if(v>=exp.lo && v<=exp.hi){
            score = 3 + (c.isUnitAfter?0:1);
          } else {
            // far outside — heavy penalty unless shifted helps
            score = 20 + Math.abs(Math.log10(Math.max(v,0.001)/((exp.human.lo+exp.human.hi)/2)));
          }
          // Slight preference for earlier candidates and non-shifted
          score += i*0.3 + (c.shifted?0.5:0);
          if(score<bestScore){ bestScore=score; best=c; }
        }
        if(best && bestScore<25) return best.value;
      }
      // Fallback: no expected range OR nothing fit — use first candidate with unit after, else first.
      const withUnit = cands.find(c=>c.isUnitAfter);
      if(withUnit) return withUnit.value;
      return cands.length? cands[0].value : null;
    }
    const writtenIds = new Set();
    // Phase 1: LINE-BY-LINE — each row of the form is one line. Name and value must be on the same line.
    // This is the primary pass: it prevents values from one test being matched to a name several lines above.
    if(lineByLine){
      // STRICTLY top-to-bottom, one line = one row of the table.
      // Per user requirement: results are ALWAYS on the same line as the name; never merge lines,
      // never fall back to global search — that picks up wrong numbers from other rows.
      let cleaned = t0
        .replace(/[ \t]*([.\u00B7\u2022·•*\-–—]{2,}|\.(\s+\.){1,})[ \t]*/g, ' ')
        .replace(/[ \t]+/g,' ').replace(/\n{2,}/g,'\n');
      // Normalize arrows and noise
      cleaned = cleaned.replace(/\s*[↑↓↔▲▼]\s*/g,' ');
      const raw = cleaned.split('\n').map(l=>l.trim()).filter(l=>l.length>=3);
      // Walk lines IN ORDER top to bottom. Once a test is matched on a line, we don't look at that alias again,
      // and we don't backtrack to earlier lines.
      for(const line of raw){
        if(!/[0-9]/.test(line)) continue;           // skip lines with no numbers
        const ln = norm(line);
        if(ln.length<3) continue;
        for(const a of aliases){
          if(writtenIds.has(a.ids[0])) continue;
          let found=false;
          for(const name of a.names){
            const key = norm(name);
            if(!key) continue;
            // Find key in this line (with position map)
            const nt=[], pm=[];
            for(let i=0;i<line.length;i++){
              const ch=line[i];
              if(/[а-яa-z0-9ё]/i.test(ch)){ nt.push(ch.toLowerCase().replace('ё','е')); pm.push(i); }
            }
            const nts=nt.join('');
            let idx = nts.indexOf(key);
            if(idx<0 && key.length>=5) idx = nts.indexOf(key.slice(0,5));
            if(idx<0) continue;
            const pos = pm[idx];
            if(pos==null) continue;
            const val = pickTidAndVal(line, pos, a);
            if(val==null || isNaN(val) || val<=0 || val>10000) continue;
            for(const tid of a.ids){
              if(writeTestValue(tid,val)){ filled++; writtenIds.add(tid); writtenIds.add(a.ids[0]); found=true; break; }
            }
            if(found) break;
          }
          if(found) break;
        }
      }
    }
    return filled;
  }
  initOCRCard();

  

/* ================================================================
 *  СПРАВОЧНИК МЕДИЦИНСКОЙ ЛИТЕРАТУРЫ
 * ================================================================ */
const MED_REF_LINKS = [
  { cat:"Доказательная медицина / PubMed", items:[
    { name:"PubMed (NCBI)", url:"https://pubmed.ncbi.nlm.nih.gov/", desc:"Главная база биомедицинских публикаций." },
    { name:"PubMed Central (PMC)", url:"https://www.ncbi.nlm.nih.gov/pmc/", desc:"Статьи в открытом доступе." },
    { name:"Cochrane Library", url:"https://www.cochranelibrary.com/", desc:"Кокрейновские обзоры (высокий уровень доказательности)." },
    { name:"Trip Database", url:"https://www.tripdatabase.com/", desc:"Метапоиск по клиническим рекомендациям." }
  ]},
  { cat:"Справочники заболеваний и симптомов (для пациентов)", items:[
    { name:"MedlinePlus (NIH, USA)", url:"https://medlineplus.gov/", desc:"Надёжные статьи о болезнях, лекарствах, симптомах." },
    { name:"MedlinePlus на русском", url:"https://medlineplus.gov/languages/russian.html", desc:"Раздел на русском языке." },
    { name:"WHO / ВОЗ (русский)", url:"https://www.who.int/ru", desc:"Всемирная организация здравоохранения." },
    { name:"eMedicine / Medscape", url:"https://emedicine.medscape.com/", desc:"Клинические обзоры по специальностям (для врачей)." }
  ]},
  { cat:"Российские клинические источники", items:[
    { name:"ГЭОТАР-Медиа", url:"https://www.geotar.ru/", desc:"Учебники, руководства, РЛС по лекарствам." },
    { name:"РЛС (Регистр лекарств)", url:"https://www.rlsnet.ru/", desc:"Описания препаратов, инструкции." },
    { name:"Рубрикатор клинических рекомендаций МЗ РФ", url:"https://cr.minzdrav.gov.ru/", desc:"Официальные клинические рекомендации Минздрава." },
    { name:"Справочник VIDAL", url:"https://www.vidal.ru/", desc:"Лекарственные средства и показания." },
    { name:"eLibrary.ru", url:"https://elibrary.ru/", desc:"Российская научная электронная библиотека." },
    { name:"НМИЦ им. Алмазова", url:"https://www.almazovcentre.ru/", desc:"Кардиология и эндокринология." }
  ]},
  { cat:"Анализы и нормы", items:[
    { name:"Lab Tests Online (EN)", url:"https://labtestsonline.org.uk/", desc:"Расшифровка лабораторных тестов от врачей." },
    { name:"Гемотест — справочник анализов", url:"https://gemotest.ru/handbook/", desc:"Популярные анализы и их интерпретация." },
    { name:"Инвитро — справочник", url:"https://www.invitro.ru/analizes/for-doctors/", desc:"Референсы и описания тестов." }
  ]},
  { cat:"Лекарства и безопасность", items:[
    { name:"FDA Drugs", url:"https://www.fda.gov/drugs", desc:"Управление по саннадзору США (лекарства)." },
    { name:"EMA (Европа)", url:"https://www.ema.europa.eu/", desc:"Европейское медицинское агентство." },
    { name:"Drugs.com", url:"https://www.drugs.com/", desc:"Проверка взаимодействия препаратов и инструкции." }
  ]},
  { cat:"ЭКГ и функциональная диагностика", items:[
    { name:"Life in the Fast Lane ECG library", url:"https://litfl.com/ecg-library/", desc:"Отличная библиотека ЭКГ (на английском)." },
    { name:"ECGpedia", url:"https://en.ecgpedia.org/", desc:"Свободный справочник по ЭКГ." }
  ]},
  { cat:"Открытые учебники (бесплатно)", items:[
    { name:"NCBI Bookshelf", url:"https://www.ncbi.nlm.nih.gov/books/", desc:"Свободные медицинские учебники." },
    { name:"OpenStax Anatomy & Physiology", url:"https://openstax.org/details/books/anatomy-and-physiology", desc:"Учебник анатомии и физиологии." }
  ]},
];
function buildRefList(container){
  if(!container || container.dataset.built) return;
  container.dataset.built='1';
  let html='<p style="color:#666;margin:0 0 8px">Выберите источник — страница откроется внутри приложения. Все ссылки ведут на внешние медицинские сайты (научная литература и справочники).</p>';
  MED_REF_LINKS.forEach(g=>{
    html += `<div class="ref-group"><h4>${g.cat}</h4><ul>`;
    g.items.forEach(it=>{
      html += `<li><a href="#" data-ext-url="${it.url}" class="ref-link">🔗 ${it.name}</a><div style="color:#777;font-size:13px">${it.desc}</div></li>`;
    });
    html += '</ul></div>';
  });
  html += '<div class="rec-item" style="background:#fff8e1"><p style="margin:0;color:#6d4c00;font-size:13px">ℹ️ Внешние ссылки позволяют читать медицинскую литературу прямо в приложении. Для полного текста некоторых статей (Cochrane, eLibrary, подписка на журналы) может потребоваться доступ или подписка на стороне издателя.</p></div>';
  container.innerHTML=html;
  // click -> open link: prefer Android intent to external browser (avoids iframe X-Frame blocks,
  // keeps back-button return to app). Fallback: iframe, then location.href.
  container.querySelectorAll('a[data-ext-url]').forEach(a=>{
    a.addEventListener('click', e=>{
      e.preventDefault();
      const u = a.getAttribute('data-ext-url');
      try{
        if(window.AndroidBridge && AndroidBridge.openUrl){
          AndroidBridge.openUrl(u);
          return;
        }
      }catch(err){}
      const panel = document.getElementById('refWeb');
      const iframe = document.getElementById('refIframe');
      if(panel) panel.style.display='block';
      if(iframe){ iframe.src = u; iframe.style.display='block'; }
    });
  });
}
// ---------- Внешний поиск в медицинских справочниках ----------
// Открывает URL через нативный интент (внешний браузер/Chrome Custom Tab),
// либо window.open — в качестве фоллбэка для браузерной версии PWA.
function openExternalUrl(u){
  try{
    if(window.AndroidBridge && AndroidBridge.openUrl){
      AndroidBridge.openUrl(u);
      return;
    }
  }catch(_){}
  try{ window.open(u, '_blank', 'noopener,noreferrer'); }catch(_){ window.location.href=u; }
}
function enc(s){ return encodeURIComponent(s||''); }
// Формирует короткий набор ключевых слов из свободного текста
function buildSearchQuery(rawText, diseaseNames){
  // Убираем знаки препинания, слишком частые слова
  let t = (rawText||'').toLowerCase().replace(/ё/g,'е');
  const STOP = new Set(['у','меня','мне','есть','был','была','были','было','очень','немного','сильно','постоянно','иногда','часто','когда','при','что','как','и','а','но','или','в','на','с','со','из','от','к','по','за','то','не','нет','уже','ещё','еще','б','без','дня','день','дней','недел','ночи','все','всё','так','также','это','этот','эта','эти','те','тот','та','для','если','себя','вчера','сегодня','сейчас','два','три','первый','второй','очень','же','лишь','тоже','такой','такая','такие','могу','может','можно','около','через','над','под','него','нее','его','её','ее','них','нам','ним','ней','весь','всё','всем','каждый','свой','свои','который','которая','которые','где','куда','откуда','почему','зачем','ну','да','нет','только','даже','также','притом','однако']);
  // Выделяем слова длиннее 3 букв
  let words = t.replace(/[^а-яa-z0-9+\s-]/g,' ').split(/\s+/).filter(w=>w.length>=3 && !STOP.has(w));
  // Убираем повторы
  const seen=new Set(); words=words.filter(w=>{ if(seen.has(w)) return false; seen.add(w); return true; });
  // Берём первые 8 наиболее характерных слов + имена предполагаемых диагнозов (до 2)
  const kw = words.slice(0,8);
  (diseaseNames||[]).slice(0,2).forEach(d=>{
    const n = String(d||'').toLowerCase().replace(/ё/g,'е').split(/[^а-яa-z0-9+-\s]/)[0].trim();
    if(n && n.length>=3){
      n.split(/\s+/).filter(p=>p.length>=3 && !STOP.has(p)).forEach(p=>{
        if(kw.length<10 && !kw.includes(p)) kw.push(p);
      });
    }
  });
  return kw.join(' ');
}
// Список специализированных медицинских поисковых ресурсов.
// query — строка на русском (сайты сами разберутся).
const MED_SEARCH_SOURCES = [
  { id:"medline", name:"MedlinePlus (NIH, США)", lang:"EN+RU",
    url: q => "https://medlineplus.gov/search?query="+enc(q)+"&ref="+enc("ZI Medical tests") },
  { id:"who", name:"ВОЗ / WHO (рус.)", lang:"RU",
    url: q => "https://www.who.int/ru/search-results?indexCatalogue=genericsearchindex1&searchQuery="+enc(q) },
  { id:"geotar", name:"ГЭОТАР-Медиа", lang:"RU",
    url: q => "https://www.geotar.ru/search/?q="+enc(q) },
  { id:"rls", name:"РЛС (Регистр лекарств)", lang:"RU",
    url: q => "https://www.rlsnet.ru/search.htm?word="+enc(q) },
  { id:"crminzdrav", name:"Клин. рекомендации МЗ РФ", lang:"RU",
    url: q => "https://cr.minzdrav.gov.ru/search?text="+enc(q) },
  { id:"medscape", name:"Medscape/eMedicine (для врачей)", lang:"EN",
    url: q => "https://www.medscape.com/search?query="+enc(q)+"&src=emed" },
  { id:"mayo", name:"Mayo Clinic Symptom Checker", lang:"EN",
    url: q => "https://www.mayoclinic.org/search/search-results?q="+enc(q) },
  { id:"pubmed", name:"PubMed (научные статьи)", lang:"EN",
    url: q => "https://pubmed.ncbi.nlm.nih.gov/?term="+enc(q)+"&sort=date" },
  { id:"cochrane", name:"Cochrane Library (обзоры)", lang:"EN",
    url: q => "https://www.cochranelibrary.com/search?searchText="+enc(q) },
  { id:"webmd", name:"WebMD Symptom Checker", lang:"EN",
    url: q => "https://www.webmd.com/search/search_results/default.aspx?query="+enc(q)+"&source=wsrx_symptom" },
  { id:"gemotest", name:"Гемотест-справочник", lang:"RU",
    url: q => "https://gemotest.ru/search/?q="+enc(q) }
];
// Генерирует HTML-блок "поиск в справочниках" по жалобам и вероятным диагнозам.
function renderMedSearchBlock(rawText, topResults){
  const names = (topResults||[]).map(r=>r.cond.name);
  const q = buildSearchQuery(rawText, names);
  if(!q || q.length<4) return '';
  let h='<div class="rec-item" style="border-left-color:#1565c0;background:#e3f2fd">';
  h+='<div class="tname" style="color:#0d47a1">🌐 Поиск в медицинских справочниках и научной литературе</div>';
  h+='<p style="margin:4px 0;font-size:13px;color:#263238">Поисковый запрос сформирован из ваших симптомов и наиболее вероятных предположений (<b>'+escHtml(q)+'</b>). Нажмите на нужный источник — он откроется во внешнем браузере (Chrome/Custom Tab) с результатами поиска. Внешние ресурсы дают полнотекстовую медицинскую информацию; окончательная интерпретация — у лечащего врача.</p>';
  h+='<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">';
  MED_SEARCH_SOURCES.forEach(s=>{
    h+=`<button class="chip med-search-chip" data-search-url="${escHtml(s.url(q))}" style="background:#fff;border:1px solid #90caf9;color:#0d47a1;cursor:pointer;max-width:100%" title="${escHtml(s.lang)}">🔗 ${escHtml(s.name)}</button>`;
  });
  h+='</div>';
  // Персональные ссылки по каждому вероятному диагнозу (топ-3)
  if(names.length){
    h+='<div style="margin-top:8px;font-size:13px"><b>📖 Литература по конкретным предположениям:</b><ul style="margin:4px 0 0 18px">';
    (topResults||[]).slice(0,3).forEach(r=>{
      const dn = r.cond.name;
      const dq = encodeURIComponent(dn + ' symptoms diagnosis treatment');
      const dqRu = encodeURIComponent(dn + ' симптомы диагностика лечение рекомендации');
      h+=`<li><b>${escHtml(dn)}</b> — <a href="#" data-ext-url-lit="https://pubmed.ncbi.nlm.nih.gov/?term=${dq}&sort=relevance">PubMed</a> · <a href="#" data-ext-url-lit="https://www.geotar.ru/search/?q=${dqRu}">ГЭОТАР</a> · <a href="#" data-ext-url-lit="https://cr.minzdrav.gov.ru/search?text=${dqRu}">Клин. рекомендации</a> · <a href="#" data-ext-url-lit="https://medlineplus.gov/search?query=${dq}">MedlinePlus</a></li>`;
    });
    h+='</ul></div>';
  }
  h+='</div>';
  return h;
}
function bindMedSearch(box){
  if(!box) return;
  box.querySelectorAll('button[data-search-url]').forEach(b=>{
    b.addEventListener('click',e=>{
      e.preventDefault();
      openExternalUrl(b.getAttribute('data-search-url'));
    });
  });
  box.querySelectorAll('a[data-ext-url-lit]').forEach(a=>{
    a.addEventListener('click',e=>{
      e.preventDefault();
      openExternalUrl(a.getAttribute('data-ext-url-lit'));
    });
  });
}

// Bind "Open in browser/external" button for the reference iframe
function bindRefControls(){
  const open = document.getElementById('refOpenExt');
  const back = document.getElementById('refBack');
  const iframe = document.getElementById('refIframe');
  if(open && iframe){ open.onclick=()=>{ if(iframe.src) openExternalUrl(iframe.src); }; }
  if(back && iframe){ back.onclick=()=>{ try{ iframe.contentWindow.history.back(); }catch(e){ iframe.src='about:blank'; iframe.style.display='none'; } }; }
}
document.addEventListener('DOMContentLoaded', ()=>{
  buildRefList(document.getElementById('refList'));
  bindRefControls();
});
if(document.readyState!=='loading'){
  buildRefList(document.getElementById('refList'));
  bindRefControls();
}
/* ================================================================
 *  ЖАЛОБЫ — интеллектуальный симптомчекер v2 (v1.8.44)
 *
 *  Основные улучшения движка:
 *   • Взвешенные ключевые слова (вместо простого regex):
 *       – core:    «кардинальные» симптомы (3 балла)
 *       – typical: типичные признаки и паттерны (2 балла)
 *       – mild:    слабые / неспецифические (1 балл)
 *       – risk:    факторы риска и триггеры (1 балл)
 *       – redflag: красные флаги (сразу +3 и выводит в неотложные)
 *       – against: опровергающие фразы (-2 балла; отрицания «нет боли»)
 *   • Отрицания («боли нет», «температуры нет», «не тошнит») вырезают
 *     соседние ключевые слова из совпадений.
 *   • Порог срабатывания: минимум 3 балла core/typical ИЛИ наличие redflag.
 *     Случайные одиночные слова (например «слабость») не вызывают диагноз.
 *   • Взятие пола и возраста пациента из профиля приложения
 *     (если заполнены) — некоторые диагнозы имеют полоспецифичные паттерны.
 *   • Ранжирование по вероятности (процент от максимально возможного):
 *       🔴 Срочные (redflag>0) — выводятся в красной шапке.
 *       🟠 Высокая вероятность  (≥60%)
 *       🟡 Средняя              (35–59%)
 *       🟢 Возможная            (20–34%)
 *       Остальные скрываются (показываются кнопкой «показать остальные»).
 *   • Опросный лист «🔎 Проверить детально» показывается ТОЛЬКО
 *     у первых 3 диагнозов и только если вероятность ≥35%. У редких/слабых
 *     совпадений вместо опросника — просто строчка «сходство небольшое».
 *   • Опросный лист устроен как дифференциальный:
 *       – вопросы учитывают не только типичные признаки, но и
 *         признаки других вероятных диагнозов (например отличить
 *         стенокардию от ГЭРБ/мышечной боли).
 *       – по окончанию выводятся: вероятность диагноза, наиболее
 *         важные обследования и чёткий план действий + ссылка на
 *         альтернативы (каких диагнозов НЕ похоже).
 *
 *  Это НЕ ДИАГНОЗ — справочная навигация к врачу.
 * ================================================================ */

/* ---------- Утилиты ---------- */
function escHtml(s){ return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function normText(t){
  return (t||'').toString()
    .toLowerCase()
    .replace(/ё/g,'е')
    .replace(/[^a-zа-я0-9+.,%<>-]+/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

/* ---------- НЕГАЦИИ ---------- */
// Фразы вроде «боли нет», «нет температуры», «не тошнит», «без тошноты»
// обнуляют соседние ключевые слова.
// Отрицания. Маскируем ТОЛЬКО строго определённые фразы-отрицания,
// чтобы случайно не вырезать «нога», «низ», «ниву», «небо» и т.п.
const NEG_PHRASES = [
  /нет\s+(сильной\s+)?боли/g, /нет\s+температуры/g, /нет\s+кашля/g, /нет\s+одышки/g,
  /нет\s+тошноты/g, /нет\s+рвоты/g, /нет\s+слабости/g, /нет\s+от[её]ков?/g,
  /не\s+болит/g, /не\s+беспокоит/g, /не\s+тошнит/g, /не\s+кашляю/g, /не\s+рв[её]т/g,
  /не\s+мочусь\s+с\s+кровью/g, /без\s+температуры/g, /без\s+боли/g, /без\s+кров(и|отечения)/g,
  /отсутствие\s+(боли|температуры|одышки|кашля)/g,
  /бол(и|ь)\s+нет/g, /температур(ы|а)\s+нет/g, /кров(и|отечения)\s+нет/g
];

function stripNegations(text){
  let t = ' '+text+' ';
  NEG_PHRASES.forEach(re=>{ t = t.replace(re, ' ~NEG~ '); });
  return t;
}

/* ---------- БАЗА ЗАБОЛЕВАНИЙ ----------
   Каждое правило состоит из массивов ключевых фраз с весом и
   контекстной информации. Если фраза содержит пробелы — ищется как
   подстрока, одиночные слова — как слово.
*/
const SYMPTOM_KB = [

/* =================== СРОЧНЫЕ =================== */
{ id:"acs", urgent:true,
  name:"Острый коронарный синдром / Инфаркт миокарда",
  doctor:"🚑 СКОРАЯ 103 (кардиобригада) — немедленно",
  desc:"Закупорка коронарной артерии тромбом; требуется срочная реперфузия (ЧКВ/тромболизис) в первые 30–120 минут, пока не погиб миокард.",
  symptoms:"Давящая/жгучая боль за грудиной >15–20 минут, не снимающаяся нитроглицерином; иррадиация в левую руку, лопатку, нижнюю челюсть; холодный липкий пот; тошнота/рвота, одышка, страх смерти. Безболевая форма — у диабетиков и пожилых (только слабость/одышка).",
  risks:"Возраст (м>45, ж>55), АГ, курение, диабет, холестерин, ожирение, семейная история ранних ССЗ.",
  tests:"ЭКГ в 12 отведениях срочно, высокочувствительный тропонин I/T (0/1/3 ч), КФК-МВ, креатинин, глюкоза, ОАК, коагулограмма, ЭхоКГ, по показаниям КАГ.",
  redflags:"Боль за грудиной >20 мин + холодный пот/одышка/тошнота = звоните 103. Разжуйте 250–325 мг аспирина, если нет противопоказаний. Не ехать за рулём.",
  triggers:{
    core:    [/боль\s+за\s+грудин(ой|е|ы)\s+(более|дольше|свыше|>)?\s*\d{1,2}\s*минут/, /боль\s+за\s+грудин(ой|е|ы).*(не\s+снимается|не\s+проходит)/, /раздирающая\s+боль\s+в\s+груд/, /жгучая\s+боль\s+за\s+грудин/],
    typical: [/отда(е|ё)т\s+в\s+(левую\s+)?ру(ку|кой)/, /отда(е|ё)т\s+в\s+лопатку/, /отда(е|ё)т\s+в\s+(нижнюю\s+)?челюсть/, /холодный\s+пот/, /липкий\s+пот/, /нитроглицерин\s+не\s+(снял|помог|помогает)/, /разжевать\s+аспирин/, /инфаркт/],
    mild:    [/давлени[её]\s+(в\s+груд|за\s+грудин)/, /сдавление\s+в\s+груд/, /страх\s+смерт/, /бледность/, /тошнот(а|ит)/, /одышк/],
    risk:    [/гипертони|давлени[её]\s+\d{2,3}/, /курен|кур(ю|ит)/, /сахарный\s+диабет|диабет/, /холестерин/, /стенокард/, /ишемическ/, /ранее\s+(был\s+)?инфаркт/, /шунтирован|стент/],
    against: [/болит\s+при\s+нажат/, /болит\s+при\s+движен|боль\s+при\s+поворот/, /боль\s+только\s+при\s+кашле/, /боль\s+только\s+при\s+глотан/, /изжога/]
  },
  questions:[
    {q:"Боль/жжение/сдавление за грудиной длится БОЛЕЕ 20 минут?",w:3,key:"long"},
    {q:"Боль отдаёт в левую руку, лопатку или нижнюю челюсть?",w:2,key:"rad"},
    {q:"Есть холодный липкий пот или резкая бледность?",w:2,key:"sweat"},
    {q:"Есть тошнота, рвота или головокружение/предобморок?",w:1,key:"naus"},
    {q:"Нитроглицерин НЕ снял боль за 3–5 минут (или стало хуже)?",w:2,key:"nitro"},
    {q:"Есть одышка в покое?",w:1,key:"dys"},
    {q:"Ранее были инфаркт/стенокардия/стент/шунтирование?",w:1,key:"hx"},
    {q:"Боль усиливается при глубоком вдохе/кашле и проходит при задержке дыхания?" ,w:-2,key:"pleur"}
  ],
  advLow:"Вероятность низкая. Если боль прошла от покоя/нитроглицерина — это может быть стенокардия или межрёберная невралгия; посетите кардиолога планово (ЭКГ, липиды, ЭхоКГ).",
  advMed:"Средняя вероятность ОКС. СРОЧНО в приёмный покой/вызов 103. Сядьте/лягте, разжуйте 250–325 мг аспирина (если нет язвы/аллергии/кровотечений), не ешьте/не пейте много.",
  advHigh:"Высокая вероятность инфаркта миокарда. НЕМЕДЛЕННО набирайте 103. Не одевайтесь и не собирайте вещи — сядьте, откройте окно, разжуйте аспирин 325 мг (при отсутствии противопоказаний), ждите бригаду."
},
{ id:"stroke", urgent:true,
  name:"Острое нарушение мозгового кровообращения (инсульт)",
  doctor:"🚑 СКОРАЯ 103 (сосудистый центр) — терапевтическое окно тромболизиса 4.5 ч",
  desc:"Ишемический (в 80%) или геморрагический инсульт. Лечение эффективно только в первые 3–6 часов от первых симптомов.",
  symptoms:"FAST-тест: Face (перекос лица/улыбки), Arm (слабость в руке на одной стороне), Speech (невнятная речь/непонимание), Time (время звонить 103). Дополнительно: онемение половины тела, потеря зрения на один глаз, двоение, внезапное головокружение с шаткостью.",
  risks:"Гипертония, мерцательная аритмия, возраст >55, курение, диабет, атеросклероз сонных артерий.",
  tests:"КТ/МРТ головы срочно, глюкоза, АД, коагулограмма, ОАК, ЭКГ (исключить ФП).",
  redflags:"Любой очаговый симптом (асимметрия лица/рук/ноги, речь) — инсульт до исключения.",
  triggers:{
    core:    [/асимметр(ией|ия|ию)?\s+лица/, /перекос(ило|ило)?\s+лица/, /не\s+поднимается\s+рук/, /слабость\s+в\s+руке\s+и\s+ноге/, /слабость\s+в\s+половине\s+тела/, /не\s+может\s+говорить/, /невнятная\s+речь/, /смазанная\s+речь/, /онемел[оа]\s+(половин|рука|нога|лицо|щека|губ)/],
    typical: [/инсульт|онмк|(внезапн|вдруг).*слабост.*в\s+(прав|лев)/, /не\s+понимаю?т\s+речь/, /не\s+могу\s+выговорить/, /опустился\s+угол\s+рта/, /обвисл[оа]?\s+(щек|лиц)/, /потерял[а]?\s+дар\s+речи/],
    mild:    [/головокруж.*(слабост|не\s+могу\s+идт|шатает)/, /потеря\s+зрения\s+на\s+(один|прав|лев)\s+глаз/, /двоение\s+в\s+глазах/, /шатает\s+при\s+ходьбе/],
    risk:    [/мерцательная\s+аритмия|фибрилляци/, /гипертони|давлени/, /курен/, /диабет/],
    against: [/онемел[оа]\s+все\s+(руки|тело|конечности)/, /онемение\s+пальцев\s+рук/i]
  },
  questions:[
    {q:"Попробуйте улыбнуться перед зеркалом. Один угол рта или века опущен?",w:3,key:"face"},
    {q:"Поднимите обе руки вперёд и держите 5 секунд. Одна рука опускается/не поднимается?",w:3,key:"arm"},
    {q:"Произнесите фразу «На дворе трава, на траве дрова». Речь смазанная или человек не может выговорить/понять фразу?",w:3,key:"speech"},
    {q:"Симптомы появились ВНЕЗАПНО, за минуты/часы (а не нарастали неделями)?",w:2,key:"time"},
    {q:"Есть двоение, потеря зрения на один глаз или половина поля выпадает?",w:1,key:"eye"},
    {q:"Внезапное сильное головокружение, шатает при ходьбе?",w:1,key:"dizzy"}
  ],
  advLow:"Не похоже на инсульт. При сохранении неврологических жалоб (онемение, слабость) посетите невролога планово.",
  advMed:"Симптомы подозрительны на инсульт — НЕ ЖДИТЕ, звоните 103. Лягте на бок (при риске рвоты), заметьте точное время появления симптомов (критично для тромболизиса).",
  advHigh:"Клиническая картина инсульта. СРОЧНО звоните 103! Каждая минута = 1.9 млн гибнущих нейронов. Сообщите точное время начала, не давайте еду/питье, уложите с приподнятым головным концом."
},
{ id:"pe", urgent:true,
  name:"Тромбоэмболия лёгочной артерии (ТЭЛА)",
  doctor:"🚑 СКОРАЯ 103 — кардиология/сосудистая хирургия",
  desc:"Закупорка лёгочной артерии тромбом (чаще из глубоких вен голени/бедра). Может быть смертельной за минуты при массивной форме.",
  symptoms:"ВНЕЗАПНАЯ одышка в покое, колющая плевральная боль, кровохарканье, тахикардия >110, головокружение/обморок, часто в сочетании с отёком/болью одной ноги.",
  risks:"Недавняя операция/перелом, длительное обездвиживание (перелёт >4 ч, постельный режим), КОК/гормоны, беременность/послеродовой период, варикоз, тромбофилии, онкология, COVID.",
  tests:"КТ-ангиопульмонография (золотой стандарт), D-димер, ЭКГ (S1Q3T3), ЭхоКГ, УЗИ вен нижних конечностей, тропонин/BNP, АЧТВ. Гепарин по назначению.",
  redflags:"Внезапная одышка + тахикардия + отёк одной ноги = срочно.",
  triggers:{
    core:    [/(внезапн|вдруг|резк)[аоуая]*\s+(сильн[аоуая]*\s+)?одышк/i, /тромбоэмбол|тэла\b/i, /кровохаркан/i],
    typical: [/(боль\s+)?(при\s+вдохе|в\s+груд.*вдох|плевральная\s+боль)/i, /тахикарди/i, /(пульс|чсс)\s*[:]?\s*1\d{2}\b/i, /(от[её]к|отекл)[аоуая]?\s+(одной\s+)?(прав|лев)[аоуый]?\s+н(ог|ог[аеиоу]|оге)/i, /одышк.*(от[её]к|отекл)[аоуая]?/i, /боль\s+в\s+(икрах|икрах|нога).*одышк/i, /покраснел[аоу]?\s+ног/i, /горячая\s+нога/i],
    mild:    [/головокруж.*внезап/i, /предобмороч/i, /обморок/i, /частый\s+пульс/i, /посинени[её]\s+губ/i],
    risk:    [/(после\s+)?операци/i, /перелом/i, /(длинный|недавний\s+)?\s*перел[её]т/i, /перелет\s+\d+\s*ч/i, /постельный\s+режим/i, /при[её]м\s+(ковар|варфарин|ксарелто|д[аоу]бигатран)/i, /(кок\b|противозачаточ)/i, /беременн/i, /послеродов/i, /варикоз/i, /тромбоз\s+в\s+/i],
    against: [/одышк.*(уже\s+давно|месяц|год|хроническая)/i, /(у\s+меня\s+)?астм/i]
  },
  questions:[
    {q:"Одышка возникла ВНЕЗАПНО (за секунды–минуты), а не нарастала днями?",w:3,key:"sud"},
    {q:"Есть боль при глубоком вдохе или кровохарканье?",w:2,key:"pleur"},
    {q:"Есть отёк/боль/покраснение/горячая кожа ОДНОЙ ноги?",w:2,key:"leg"},
    {q:"Пульс >110 в покое (считать минуту)?",w:1,key:"hr"},
    {q:"Были недавно операция/перелом/длинный перелёт/постельный режим?",w:2,key:"risk"},
    {q:"Принимаете КОК/гормоны или недавно родили?",w:1,key:"pill"},
    {q:"Были обмороки/головокружения?",w:1,key:"sync"}
  ],
  advLow:"В настоящее время не похоже на ТЭЛА. При усилении одышки или появлении боли с кровохарканьем — срочно.",
  advMed:"Средняя вероятность — срочно в приёмный покой. Нужен D-димер и КТ-ангиопульмонография при повышении; лечебные дозы гепарина под наблюдением. Не вставайте и не массируйте ногу.",
  advHigh:"Высокая вероятность ТЭЛА — немедленно звоните 103. Не вставайте (риск отрыва новых тромбов). Лягте, приподнимите голову."
},
{ id:"sah", urgent:true,
  name:"Субарахноидальное кровоизлияние (разрыв аневризмы)",
  doctor:"🚑 СКОРАЯ — нейрохирургия",
  desc:"Кровоизлияние под паутинную оболочку мозга, чаще из разорвавшейся аневризмы. Пик смертности в первые сутки.",
  symptoms:"«Громоподобная» головная боль («худшая в жизни»), пик за секунды; тошнота/рвота, светобоязнь, ригидность затылочных мышц (не могу прижать подбородок к груди), возможна потеря сознания.",
  tests:"КТ головы без контраста в первые 6 ч; при отрицательной КТ но подозрении — люмбальная пункция (ксантохромия). Далее КТ/МР-ангиография — нейрохирургия.",
  redflags:"«Гром среди ясного неба» — самая сильная ГБ в жизни с мгновенным пиком.",
  triggers:{
    core:    [/громоподобная.*головная\s+боль/, /самая\s+сильная\s+в\s+жизни.*головн/, /гром\s+среди\s+ясного\s+неба/],
    typical: [/внезапн.*головная\s+боль.*(секунд|пик|мгновен)/, /не\s+могу\s+наклонить\s+подбородок\s+к\s+груд/, /ригидност.*ше/, /светобоязн.*головной\s+бол/, /потерял[а]?\s+сознание.*головная\s+боль/],
    mild:    [/тошнот.*головной\s+бол/, /рвота.*головной\s+бол/, /двоение\s+в\s+глазах.*голов/],
    risk:    [/аневризм/, /поликистоз\s+почек/, /курен/, /гипертони/],
    against: [/мигрен/ , /обычно\s+у\s+меня\s+так/, /головная\s+боль\s+нарастает\s+(день|дня|сутки)/]
  },
  questions:[
    {q:"Головная боль достигла максимума МГНОВЕННО (за 1–5 секунд)?",w:3,key:"sud"},
    {q:"Это САМАЯ СИЛЬНАЯ головная боль в жизни?",w:2,key:"worst"},
    {q:"Не могу наклонить подбородок к груди из-за боли/напряжения в шее?",w:2,key:"neck"},
    {q:"Были обморок/потеря сознания?",w:2,key:"sync"},
    {q:"Есть тошнота/рвота и светобоязнь?",w:1,key:"vom"},
    {q:"Двоение или опущение века?",w:1,key:"eye"}
  ],
  advLow:"Не похоже на САК. При новой или меняющейся головной боли — невролог планово.",
  advMed:"Подозрение на САК — срочно в приёмный покой (КТ головы). Не принимайте сильные обезболивающие — они смазывают картину.",
  advHigh:"Клиническая картина САК — звоните 103 сейчас. Не ешьте/не пейте (может понадобиться срочная операция)."
},
{ id:"append", urgent:true,
  name:"Острый аппендицит",
  doctor:"🚑 СКОРАЯ — хирургия",
  desc:"Воспаление червеобразного отростка; опасен перфорацией с развитием перитонита за 24–48 ч.",
  symptoms:"Чаще боль СНАЧАЛА в эпигастрии/около пупка, затем за 4–24 ч смещается в правую подвздошную область; тошнота, однократная рвота, субфебрильная температура, потеря аппетита, положительный симптом Щёткина-Блюмберга (усиление боли при отпускании руки).",
  tests:"ОАК (лейкоцитоз, сдвиг влево), СРБ, УЗИ/КТ ОБП, повторный осмотр хирурга через 2–4 ч.",
  redflags:"Нарастающая боль + доскообразный живот + рвота + t = перитонит.",
  triggers:{
    core:    [/аппендиц/, /в\s+прав(ом|ый)\s+(подвздош|низ\s+жив|бок)/i],
    typical: [/макб[её]рн/i, /(сначала\s+)?(бол(и|ь|ела)\s+)?(вверху|около\s+пупка|у\s+пупка|в\s+эпигастрии)[\s\S]{0,80}?перешл[аоу]?\s+в\s+прав/i, /(боль\s+)?в\s+прав(ом|ый)\s+(низ|бок).*тошнот/i, /усиливает(ся|т)\s+при\s+(кашле|ходьбе|прыж|смехе|нажати)/i, /отпускаю(сь|т).*боль.*усилив/i, /симптом\s+щ[её]ткин/i],
    mild:    [/пропал\s+аппетит|не\s+хочется\s+есть/i, /(тошнит|подташнивает).*бол.*живот/i, /температур(а|ой)?\s*37[.,]\d|температур(а|ой)?\s*38/i, /усиливает(ся|т)\s+при\s+ходьбе/i],
    risk:    [/возраст\s+\d{2}|/], // нейтрально
    against: [/боль\s+только\s+после\s+еды|диаре[ия]\s+с\s+температурой\s+уже\s+несколько\s+дней/]
  },
  questions:[
    {q:"Боль началась вверху/около пупка и сместилась в правый низ живота?",w:3,key:"shift"},
    {q:"Усиливается при кашле/ходьбе/прыжке на правой ноге?",w:2,key:"move"},
    {q:"При отпускании руки после нажатия боль становится сильнее (симптом Щёткина)?",w:2,key:"blum"},
    {q:"Есть тошнота/рвота ПОСЛЕ начала боли?",w:1,key:"vom"},
    {q:"Пропал аппетит (ничего не хочется есть)?",w:1,key:"noapp"},
    {q:"Температура 37.5–39°C?",w:1,key:"t"}
  ],
  advLow:"Маловероятно. Если боль нарастает в течение нескольких часов — немедленно к хирургу. НЕ пейте обезболивающие до осмотра.",
  advMed:"Подозрение на аппендицит. НЕ ешьте/не пейте, не принимайте НПВС/обезболивающие — срочно в хирургический приёмный покой или вызывайте скорую.",
  advHigh:"Высокая вероятность аппендицита. СРОЧНО звоните 103 или добирайтесь до хирургического стационара; не ешьте/не пейте (нужен наркоз)."
},
{ id:"bleed_gi", urgent:true,
  name:"Желудочно-кишечное кровотечение",
  doctor:"🚑 СКОРАЯ — хирургия/гастроэнтерология",
  desc:"Чаще язва желудка/ДПК, варикозные вены пищевода, эрозивный гастрит, НПВС-гастропатия, опухоли.",
  symptoms:"Чёрный дёгтеобразный зловонный стул (мелена), рвота «кофейной гущей» или алой кровью; слабость, головокружение при вставании, холодный пот, бледность, тахикардия.",
  tests:"ОАК (гемоглобин), группа крови, коагулограмма, ФГДС срочно в первые 2–24 ч (золотой стандарт диагностики и остановки).",
  redflags:"Мелена + слабость + холодный пот = продолжающееся кровотечение.",
  triggers:{
    core:    [/ч[её]рный\s+стул|д[её]гтеобразн/, /мелена/, /рвота\s+кофейной\s+гущей/, /кровавая\s+рвота/],
    typical: [/кровь\s+в\s+стуле.*слаб/, /алая\s+кровь.*предобмороч/, /головокруж.*ч[её]рный\s+стул/, /холодный\s+пот.*(стул|кровь)/],
    mild:    [/бледность.*стул/, /частое\s+сердцебиение.*стул/],
    risk:    [/при[её]м\s+(аспирин|кардиомагнил|ибупрофен|диклофенак|найз|нурофен|варфарин|ксарелто|прадакс|клопидогрел|ацекардол)/, /язв(а|енн)/, /цирроз/, /варикоз.*пищевод/],
    against: [/кровь\s+только\s+на\s+туалетной\s+бумаге|геморрой/]
  },
  questions:[
    {q:"Стул чёрный, дёгтеобразный, очень зловонный?",w:3,key:"melena"},
    {q:"Рвота с КРОВЬЮ или «кофейной гущей»?",w:3,key:"vom"},
    {q:"Слабость, головокружение при вставании, холодный пот?",w:2,key:"shock"},
    {q:"Пульс >100 и/или бледность?",w:1,key:"pulse"},
    {q:"Принимаете аспирин/ибупрофен/диклофенак/ксарелто/варфарин/клопидогрель?",w:1,key:"nsaid"},
    {q:"Ранее были язва желудка, цирроз или варикоз пищевода?",w:1,key:"hx"}
  ],
  advLow:"Отдельные капли свежей крови на бумаге — чаще геморрой/трещина: проктолог планово.",
  advMed:"Подозрение на ЖКК — срочно в приёмный покой. Ничего не ешьте/не пейте, холод на эпигастрий.",
  advHigh:"Клиника активного ЖКК. Звоните 103 немедленно! Лягте, не ешьте/не пейте, не принимайте НПВС."
},
{ id:"pancreatitis", urgent:true,
  name:"Острый панкреатит",
  doctor:"🚑 СКОРАЯ — хирургия/гастроэнтерология",
  desc:"Воспаление поджелудочной железы, часто после жирного/алкогольного застолья на фоне ЖКБ.",
  symptoms:"Опоясывающая жгучая боль в эпигастрии/левом подреберье, неукротимая рвота, не приносящая облегчения, вздутие, тахикардия, шок при тяжёлой форме.",
  tests:"Амилаза/липаза (>3 норм), УЗИ/КТ ОБП, ОАК, СРБ, печеночные пробы, кальций, глюкоза.",
  redflags:"Неукротимая рвота, падение давления, цианоз, синюшные пятна на боках.",
  triggers:{
    core:    [/опоясывающ[аеуои]?\s+боль\s+в\s+(живот|эпигастр|подложечн|верхн|лев)/i, /острый\s+панкреатит/i, /реж[ущё]щая\s+боль\s+в\s+эпигастр.*опоясыва/i],
    typical: [/боль\s+в\s+(подложеч|эпигастр).*отда[её]т\s+в\s+спин/i, /боль\s+в\s+левом\s+подребер.*спин/i, /после\s+(жирн|застоль|алкогол).*боль/i, /рвота\s+не\s+приносит\s+облегч/i],
    mild:    [/многократная\s+рвота\s+после\s+жирн/i, /вздутие\s+живота.*боль/i],
    risk:    [/желчн[аоу]?\s+каменн|камни\s+в\s+желчн/i, /алкогол/i, /гипертриглицерид/i],
    against: []
  },
  questions:[
    {q:"Опоясывающая сильная боль в верхней части живота?",w:3,key:"belt"},
    {q:"Отдаёт в спину/левую лопатку?",w:2,key:"back"},
    {q:"Многократная рвота, после которой НЕ становится легче?",w:2,key:"vom"},
    {q:"Возникла после жирного застолья/алкоголя?",w:1,key:"meal"},
    {q:"Температура, тахикардия >100, вздутие живота?",w:1,key:"t"}
  ],
  advLow:"Похоже на обострение гастрита/диспепсии. При усилении — вызов врача.",
  advMed:"Подозрение на острый панкреатит — вызывайте скорую. Ничего не ешьте/не пейте.",
  advHigh:"Клиника острого панкреатита — 103. Голод, холод на эпигастрий, не принимайте обезболивающие до осмотра."
},

/* =================== СОСТОЯНИЯ, НЕ ОБЯЗАТЕЛЬНО СРОЧНЫЕ =================== */
{ id:"angina", urgent:false,
  name:"Стенокардия (стабильная/прогрессирующая)",
  doctor:"Кардиолог (планово 1–2 нед; при учащении — срочно)",
  desc:"Преходящая ишемия миокарда при нагрузке из-за стеноза коронарных артерий; купируется покоем/нитроглицерином за 1–5 мин. Учащение/появление в покое = нестабильная (срочно).",
  symptoms:"Сжимающая боль за грудиной при ходьбе, подъёме, холоде, стрессе; отдаёт в руку/челюсть; одышка при нагрузке.",
  tests:"ЭКГ в момент боли, вело/тредмил-тест, ЭхоКГ, КТ-коронарография/КАГ по показаниям, липиды, глюкоза, тропонин при затянувшемся приступе.",
  redflags:"Приступы в покое, длительность >15 мин — уже нестабильная (см. ИМ).",
  triggers:{
    core:    [/боль.*за\s+грудин.*при\s+(ходьб|нагрузк|подъ[её]ме|бег)/, /стенокард/],
    typical: [/проходит.*после\s+останов/, /снимается\s+нитроглицерином/, /нитроглицерин\s+помогает/ , /отда[её]т\s+в\s+левую\s+руку.*нагруз/, /давит\s+грудь\s+при\s+ходьбе/],
    mild:    [/одышка\s+при\s+обычной\s+нагрузк/, /быстро\s+устаю\s+при\s+ходьбе/],
    risk:    [/давлени|курен|холестерин|диабет|лишн\s+вес|семейн|мужчин[ае]\s+(за|старше|45)/],
    against: [/болит\s+при\s+нажат/, /боль\s+при\s+поворот|болит\s+при\s+движен/, /боль\s+после\s+еды.*изжога/]
  },
  questions:[
    {q:"Боль/сдавление за грудиной возникает ИМЕННО при нагрузке (ходьба, подъём, холод, стресс)?",w:3,key:"load"},
    {q:"Проходит в течение 1–5 минут после остановки?",w:3,key:"rest"},
    {q:"Снимается нитроглицерином за 1–3 мин?",w:2,key:"nitro"},
    {q:"Отдаёт в левую руку, лопатку или челюсть?",w:1,key:"rad"},
    {q:"В последнюю неделю приступы участились или стали появляться в покое?",w:2,key:"unstable"},
    {q:"Есть курение/гипертония/диабет/высокий холестерин/возраст 45+?",w:1,key:"risk"}
  ],
  advLow:"Маловероятно. Проверьте давление, сдайте липиды, глюкозу, ЭКГ планово.",
  advMed:"Похоже на стабильную стенокардию. Запишитесь к кардиологу в ближайшие 1–2 недели (ЭКГ с нагрузкой, ЭхоКГ, липиды). До визита имейте нитроглицерин.",
  advHigh:"Высокая вероятность ИБС С УЧАЩЕНИЕМ приступов — это нестабильная стенокардия, вызывайте скорую, не ждите планового приёма."
},
{ id:"pneumonia", urgent:false,
  name:"Пневмония / бактериальный бронхит",
  doctor:"Терапевт/пульмонолог; при одышке или t>39 дольше 3 сут — срочно",
  desc:"Бактериальное/вирусное воспаление лёгочной ткани, чаще после ОРВИ/гриппа.",
  symptoms:"Кашель с гнойной (жёлтой/зелёной/ржавой) мокротой, температура >38–39°C более 2–3 сут, озноб, одышка при небольшой нагрузке, боль в грудной клетке при дыхании/кашле.",
  tests:"ОАК (нейтрофильный лейкоцитоз), СРБ, прокальцитонин, рентген/КТ ОГК, пульсоксиметрия, посев мокроты.",
  redflags:"Сатурация <92%, спутанность, одышка в покое — срочно.",
  triggers:{
    core:    [/пневмони/, /(кашель|кашл).*(ж[её]лт|зел[её]н|ржав)/, /ж[её]лт(ая|ой|ую)\s+мокрот/, /зел[её]н(ая|ой|ую)\s+мокрот/],
    typical: [/температур(а|ой|ы)\s+(38|39)\.?\d*\s*(более|дольше|свыше)?\s*\d*\s*(дн|сут)/, /каш(е|л)ль\s+с\s+мокрот/ , /боль\s+при\s+глубоком\s+вдохе.*каш/, /озноб.*каш/],
    mild:    [/слабость.*каш.*темп/, /одышка\s+при\s+нагрузке.*каш/, /хрипы/],
    risk:    [/курю|курим|кури(т|л)|хобл|астм|возраст\s+65\+|диабет|после\s+гриппа|после\s+орви/],
    against: [/просто\s+кашель\s+без\s+температ/, /каш(е|л)ль\s+сухой\s+без\s+мокрот/]
  },
  questions:[
    {q:"Температура >38°C держится БОЛЕЕ 2–3 дней?",w:2,key:"fever"},
    {q:"Отходит жёлтая/зелёная/ржавая мокрота?",w:2,key:"sput"},
    {q:"Есть одышка при ходьбе по комнате/в покое?",w:2,key:"dys"},
    {q:"Боль при глубоком вдохе/кашле на стороне груди?",w:1,key:"pleur"},
    {q:"Озноб, сильная слабость, ночные поты?",w:1,key:"weak"},
    {q:"Кашель не стихает более недели после ОРВИ/гриппа?",w:1,key:"long"}
  ],
  advLow:"Вероятно ОРВИ/бронхит. Питьё, покой, парацетамол при t>38.5; если кашель >3 нед — пульмонолог.",
  advMed:"Похоже на бронхит или атипичную пневмонию. Посетите терапевта сегодня: прослушать лёгкие, ОАК+СРБ, рентген ОГК по показаниям; решить об антибиотиках.",
  advHigh:"Высокая вероятность пневмонии. Срочно к врачу (сегодня): рентген ОГК и решение о госпитализации/антибиотиках. При одышке/спутанности — скорая."
},
{ id:"gastro_ref", urgent:false,
  name:"Гастроэзофагеальная рефлюксная болезнь (ГЭРБ)",
  doctor:"Гастроэнтеролог",
  desc:"Заброс кислого желудочного содержимого в пищевод из-за слабости нижнего пищеводного сфинктера/грыжи ПОД; маскируется под стенокардию.",
  symptoms:"Изжога 2+ раз в неделю, отрыжка кислым/горьким, жжение за грудиной через 30–60 мин после еды/при наклоне/ночью, ком в горле, кислый привкус. Снимается антацидами/ИПП.",
  tests:"Пробный курс ИПП 2–4 нед (эзомепразол 40 мг за 30 мин до завтрака); ФГДС при тревожных знаках или неэффективности терапии; pH-метрия.",
  redflags:"Дисфагия, похудение, кровотечение, анемия — исключить опухоль/стриктуру/Барретта.",
  triggers:{
    core:    [/изжога/i, /отрыжка\s+кисл/, /жжение\s+за\s+грудин.*после\s+ед/],
    typical: [/горьк.*\s+во\s+рту/, /кислый\s+привкус\s+утром/, /ком\s+в\s+горле.*после\s+ед/, /жжение.*при\s+наклоне/, /жжение.*когда\s+ляг/, /снимает(ся)?\s+омепразол|ран[ио]тидин|маалокс|ренни|фосфалюгель/],
    mild:    [/отрыжка\s+(часто|постоянно|воздух)/, /тошнота\s+после\s+жирн/],
    risk:    [/лишн\s+вес|ожирени/, /кур[ею]|алкогол/, /кофе|шоколад|газировк|жирн|фастфуд/, /грыжа\s+пищеводн/],
    against: [/боль\s+при\s+нагрузк|боль\s+при\s+ходьбе|нитроглицерин\s+помогает/]
  },
  questions:[
    {q:"Изжога/жжение за грудиной ПОСЛЕ ЕДЫ, при наклоне или в положении лёжа?",w:3,key:"post"},
    {q:"Отрыжка кислым/горьким или кислый привкус во рту по утрам?",w:2,key:"acid"},
    {q:"Симптомы будят ночью или усиливаются после переедания/кофе/шоколада/жирного?",w:1,key:"night"},
    {q:"Помогают омепразол/ранитидин/ренни/антациды?",w:2,key:"ppi"},
    {q:"Избыточный вес, курение, частое употребление кофе/газировки/жирного?",w:1,key:"risk"},
    {q:"Есть затруднение глотать/похудение/кровь в стуле? (тревожные знаки)",w:-2,key:"redflag"}
  ],
  advLow:"Поведенческие меры: не переедать, не есть за 3 ч до сна, поднять изголовье кровати на 10–15 см, избегать кофе/газировки/жирного/шоколада, снизить вес.",
  advMed:"Похоже на ГЭРБ. Гастроэнтеролог; пробный курс ИПП (эзомепразол/омепразол 20–40 мг за 30 мин до завтрака) 4 нед.",
  advHigh:"Выраженный ГЭРБ + есть тревожные знаки (дисфагия, похудение, кровь, анемия) — ФГДС СРОЧНО для исключения опухоли/стриктур/Барретта."
},
{ id:"biliary", urgent:false,
  name:"Дискинезия ЖВП / хронический холецистит / дуоденогастральный рефлюкс жёлчи",
  doctor:"Гастроэнтеролог (УЗИ ОБП)",
  desc:"Застой/нарушение оттока жёлчи из жёлчного пузыря или заброс жёлчи в желудок/пищевод; часто сопутствует ГЭРБ и СИБР.",
  symptoms:"Горечь/металлический привкус во рту, особенно по утрам или после жирного/жареного; тяжесть/тупая боль или распирание в правом подреберье; подташнивание, иногда рвота с жёлчью; вздутие; нарушение стула (чередование поноса и запора, светлый кал, тёмная моча при обструкции).",
  tests:"УЗИ органов брюшной полости (натощак), АлАТ/АсАТ/билирубин общий+прямой/ГГТП/ЩФ/амилаза/липаза, копрограмма, по показаниям ФГДС и дуоденальное зондирование.",
  redflags:"Жёлтушность склер/кожи, тёмная моча и светлый кал, сильная коликообразная боль в правом подреберье — жёлчная колика/камень в общем протоке, срочно хирург.",
  triggers:{
    core:    [/гор(ечь|ьк)\w*\s+во\s+рту/i, /гор(ечь|ьк)\w*\s+привкус/i, /горький\s+привкус/i, /горечь\s+утром/i, /желчн\s+рефлюкс/i, /ж[её]лч(ь|ю|ей)\s+во\s+рту/i, /ж[её]лч(ь|ю|ей)\s+в\s+рту/i, /привкус\s+ж[её]лчи/i, /тошн(ит|ота)/i, /подташнив(ает|ание)/i],
    typical: [/боль.*прав(ом|ый|ого|ым)\s+подребер/i, /тяжесть.*прав(ом|ый)\s+подребер/i, /распирание.*в\s+прав(ом|ый)\s+бок/i, /тошнит.*после\s+жирн/i, /отрыжк.*\s+горьк/i, /нал[её]т\s+на\s+язык/i, /бол(ит|ят).*в\s+прав(ом|ый)\s+бок/i, /тошн(ит|ота)\s+(по\s+)?утр/i, /подташнив(ает|ание)\s+(по\s+)?утр/i, /утренняя\s+тошн/i, /рвот[аы]\s+ж[её]лч(ь|ью)/i],
    mild:    [/тяжесть\s+в\s+правом\s+подребер/i, /вздутие\s+после\s+жирн/i, /после\s+жирн.*тошнит/i, /светлый\s+кал/i, /т[её]мная\s+моч/i],
    risk:    [/желчн[аоу]?\s+каменн|камни\s+в\s+желчн|холецистит|джвп|дискинез/i, /лишн\s+вес|жирн\s+пищ|праздничн\s+застоль/i],
    against: [/пожелтел/i, /сильн.*колик/]
  },
  questions:[
    {q:"Горечь/горький/металлический привкус во рту, особенно по утрам?",w:3,key:"bitter"},
    {q:"Тяжесть/тупая боль или распирание в ПРАВОМ подреберье после жирного/жареного?",w:2,key:"right"},
    {q:"Тошнит после жирной пищи, иногда отрыжка горьким?",w:2,key:"naus"},
    {q:"Налёт на языке жёлтый/белый, вздутие после еды?",w:1,key:"bloat"},
    {q:"Ранее по УЗИ находили перегиб/застой желчи/песок/камни?",w:2,key:"hx"}
  ],
  advLow:"Сократите жирное/жареное/копчёное, алкоголь, кофе натощак; ешьте дробно 4–5 раз в день; стол №5 по Певзнеру; при болях — спазмолитики (дротаверин/но-шпа). Запишитесь на УЗИ ОБП (натощак!) и сдайте печеночные пробы.",
  advMed:"Сделайте УЗИ ОБП натощак, сдайте АЛТ/АСТ/билирубин/ГГТП/ЩФ, обратитесь к гастроэнтерологу. Курс урсодезоксихолевой кислоты и спазмолитиков — по назначению.",
  advHigh:"Есть жёлтушность склер/кожи, тёмная моча, светлый кал или сильные колики — срочно к хирургу/гастроэнтерологу для исключения ЖКБ/холедохолитиаза (камней в общем протоке)."
},
{ id:"globus_ph", urgent:false,
  name:"Глобус-фарингеус (ком в горле) / хронический фарингит / ЛОР-проблемы",
  doctor:"ЛОР-врач первично; если норма — гастроэнтеролог/эндокринолог/психотерапевт",
  desc:"Ощущение комка/инородного тела в горле без настоящего затруднения дыхания — частая жалоба: причины от хронического фарингита, ГЭРБ и увеличенных лимфоузлов до тиреопатий и психогенного фактора (тревога/стресс).",
  symptoms:"Ощущение «что-то застряло»/комка в горле, желание откашляться/сглотнуть, сухость/першение, неуверенность при глотании без реальной задержки пищи.",
  tests:"Осмотр ЛОРа (фарингоскопия), УЗИ щитовидной железы + ТТГ, по показаниям ФГДС (исключить ГЭРБ/опухоль).",
  redflags:"РЕАЛЬНОЕ затруднение проглатывания пищи (дисфагия), похудение, кровь в слюне/мокроте, увеличенные плотные безболезненные лимфоузлы — срочно исключить опухоль.",
  triggers:{
    core:    [/ком\s+в\s+горле/i, /застрял.*в\s+горле/i, /что-то\s+мешает\s+в\s+горле/i, /инородное\s+тело\s+в\s+горле/i],
    typical: [/першение\s+в\s+горле/i, /сухость\s+в\s+горле/i, /хронический\s+фарингит/i, /сглатываю.*комок/i, /как\s+сглатываю\s+не\s+проходит/i],
    mild:    [/больно\s+глотать\s+немного/i, /увеличен.*лимфоузел\s+на\s+шее/i, /постоянно\s+сглатываю\s+слюну/i],
    risk:    [/кур[юит]/i, /гэрб|изжога/i, /щитовидн/i, /постоянный\s+стресс/i],
    against: [/не\s+могу\s+глотать\s+пищу|задыхаюсь|сильная\s+боль\s+при\s+глотан/]
  },
  questions:[
    {q:"Ощущение комка есть и на пустой глотке, и во время еды, но пища проходит свободно?",w:2,key:"globus"},
    {q:"Есть сухость/першение, першит или откашливаетесь постоянно?",w:1,key:"phary"},
    {q:"Одновременно есть изжога/отрыжка кислым или горьким? (возможно ГЭРБ)",w:2,key:"gerd"},
    {q:"Увеличены лимфоузлы на шее, есть боль/температура?",w:1,key:"ln"},
    {q:"Трудно ГЛОТАТЬ твёрдую пищу, похудели, есть кровь в слюне? (красные флаги)",w:-3,key:"red"}
  ],
  advLow:"Пейте тёплое, увлажняйте воздух, исключите курение/очень горячую пищу/спирт, полощите горло. Начните с осмотра ЛОРа в поликлинике; если ЛОР ничего не найдёт — проверьте ТТГ и УЗИ ЩЖ.",
  advMed:"Посетите ЛОРа (фарингоскопия) + сдайте ТТГ и сделайте УЗИ щитовидной железы. Если найдут признаки ГЭРБ — курс ИПП под контролем гастроэнтеролога.",
  advHigh:"Если реально трудно глотать пищу или похудение/кровь — срочно к ЛОРу/онкологу для исключения новообразований."
},
{ id:"oral_dys", urgent:false,
  name:"Стоматологическая/полость рта причина привкуса (гингивит/пародонтит/грибок)",
  doctor:"Стоматолог (терапевт/пародонтолог)",
  desc:"Привкус горечи/металла часто дают кровоточивость дёсен (гингивит), пародонтит, кариес, зубной камень, грибковый стоматит, старые пломбы из амальгамы.",
  symptoms:"Кровоточивость дёсен при чистке зубов, налёт, запах изо рта, металлический/горьковатый привкус усиливается утром, после еды.",
  tests:"Профессиональная гигиена у стоматолога, осмотр дёсен, по показаниям посев на Candida.",
  triggers:{
    core:    [/металлическ.*\s+привкус/i, /кровоточ(ат|ивость)\s+дес/i, /десны?\s+кровоточ/i, /кровотечени[ея]\s+из\s+дес[ен]?/i, /запах\s+изо\s+рта/i, /галитоз/i],
    typical: [/пародонтит|гингивит|стоматит/i, /язвочки\s+во\s+рту/i, /нал[её]т\s+на\s+язык/i, /кровь\s+при\s+чистке\s+зубов/i, /зубной\s+камень/i],
    mild:    [/утренн.*\s+привкус/i, /плохая\s+гигиена/i, /давно\s+не\s+был\s+у\s+стоматолога/i],
    risk:    [/курен/i, /брекеты|коронки|амальгам/i, /диабет/i],
    against: []
  },
  questions:[
    {q:"Дёсны кровоточат при чистке зубов или при откусывании твёрдого?",w:2,key:"gum"},
    {q:"Есть язвочки/белый налёт/покраснения во рту или на языке?",w:2,key:"ulcer"},
    {q:"Запах изо рта, который отмечают окружающие?",w:1,key:"smell"},
    {q:"Не были у стоматолога больше 6–12 месяцев?",w:1,key:"dent"}
  ],
  advLow:"Запишитесь на профгигиену и осмотр стоматолога; мягкая щётка, зубная нить, ополаскиватели без спирта, щадящая диета.",
  advMed:"Стоматолог: профгигиена УЗ-скейлером+AirFlow, лечение кариеса/пародонтита; при подозрении на грибок — мазок и местное противогрибковое.",
  advHigh:"Язвы/уплотнения, которые не заживают более 2 недель — срочно к стоматологу/ЛОРу (исключить онкопатологию)."
},
{ id:"dyspeps_ibs", urgent:false,
  name:"Функциональная диспепсия / СРК / ферментная недостаточность",
  doctor:"Гастроэнтеролог",
  desc:"Вздутие, неоформленный стул, дискомфорт после еды — часто на фоне СИБР, лактазной недостаточности, дефицита желчи/панкреатических ферментов.",
  symptoms:"Вздутие после еды, урчание, нерегулярный стул (запор/понос чередуются), слизь в кале, тяжесть, отрыжка.",
  tests:"Копрограмма, кальпротектин, УЗИ ОБП, дыхательный тест на СИБР/лактозу, при тревожных знаках — ФГДС/колоноскопия.",
  triggers:{
    core:    [/вздутие\s+живот/, /метеоризм/, /постоянное\s+вздутие/],
    typical: [/тяжесть\s+в\s+эпигастр.*после\s+ед/, /урчани.*живот/, /стул\s+то\s+запор\s+то\s+понос/, /нерегулярный\s+стул/, /слизь\s+в\s+кале/],
    mild:    [/отрыжка\s+воздух/, /пучит\s+живот/, /газы/, /неоформленный\s+стул/],
    risk:    [/перен[её]с\s+кишечную\s+инфекцию|дисбактериоз|после\s+антибиотиков/],
    against: [/кровь\s+в\s+стуле|похудени|ночная\s+боль|каловыделения\s+с\s+кровью/]
  },
  questions:[
    {q:"Вздутие/газы преимущ. после молочных продуктов? (лактозная недостаточность)",w:2,key:"milk"},
    {q:"Боли проходят ПОСЛЕ ДЕФЕКАЦИИ, стул нерегулярный? (СРК)",w:2,key:"ibs"},
    {q:"Тяжесть и жирный стул после жирной пищи? (ферменты/желчный)",w:1,key:"fat"},
    {q:"Возникло после антибиотиков/кишечной инфекции?",w:1,key:"post"},
    {q:"НЕТ похудения, крови/чёрного стула, ночных поносов?",w:-1,key:"saf"}
  ],
  advLow:"Диета Low-FODMAP 2 нед, ограничьте бобовые/молоко/газировки/сырые овощи поначалу.",
  advMed:"Копрограмма + кальпротектин + УЗИ ОБП у гастроэнтеролога; ферменты, спазмолитики, пробиотики по показаниям.",
  advHigh:"Если есть похудение/кровь — срочно колоноскопия."
},
{ id:"uti_pyel", urgent:false,
  name:"Цистит / пиелонефрит (инфекция МВП)",
  doctor:"Уролог/терапевт; при t и боли в пояснице — срочно",
  desc:"Бактериальное воспаление мочевого пузыря (E. coli в 80%) или восходящее — почек (пиелонефрит, требует срочных антибиотиков).",
  symptoms:"Частое болезненное мочеиспускание малыми порциями, жжение, тянущая боль над лоном, помутнение мочи; при пиелонефрите — t>38, озноб, боль в пояснице.",
  tests:"ОАМ, посев мочи, ОАК, УЗИ почек/мочевого пузыря.",
  triggers:{
    core:    [/рези\s+при\s+мочеиспуск/, /боль\s+при\s+мочеиспуск/, /жжение\s+при\s+моче/, /цистит/],
    typical: [/частое\s+мочеиспуск.*малыми\s+порци/i, /часто\s+бегаю\s+в\s+туалет\s+по[\s-]?маленькому/i, /позыв.*каждые\s+\d+\s+минут/i, /мутн.*моч/i, /боль\s+над\s+лоном/i],
    mild:    [/кровь\s+в\s+конце\s+мочеиспуск/i, /неприятный\s+запах\s+мочи/i, /постоянно\s+хочу\s+в\s+туалет/i],
    risk:    [/(девушк|женщ|женск\s+пол)/, /переохлажд/, /половой\s+ак\s+накануне/, /беременн/, /диабет/]
  },
  questions:[
    {q:"Рези/жжение ПРИ мочеиспускании?",w:2,key:"burn"},
    {q:"Частые позывы каждые 15–30 мин, малыми порциями?",w:2,key:"freq"},
    {q:"Температура >37.5 и боль в пояснице/боку (пиелонефрит)?",w:3,key:"pyelo"},
    {q:"Моча мутная, с запахом или кровью?",w:1,key:"urine"},
    {q:"Был половой акт/переохлаждение накануне?",w:1,key:"risk"}
  ],
  advLow:"Первые признаки — обильное питьё 2–2.5 л, брусника/клюква, канефрон. Если за 24 ч не прошло — к врачу (ОАМ, посев).",
  advMed:"Похоже на цистит. ОАМ+посев, фосфомицин/фурамаг/нитроксолин по назначению врача.",
  advHigh:"Подозрение на ПИЕЛОНЕФРИТ (температура + поясница) — срочно к урологу/терапевту, могут понадобиться парентеральные антибиотики и госпитализация."
},
{ id:"dm2", urgent:false,
  name:"Сахарный диабет (подозрение)",
  doctor:"Эндокринолог/терапевт",
  desc:"Полиурия+полидипсия+полифагия — классическая триада. У 2 типа часто бессимптомное течение.",
  symptoms:"Жажда, сухость во рту, частое обильное мочеиспускание (в т.ч. ночью), зуд кожи/промежности, долгое заживление ран, снижение/набор веса, слабость.",
  tests:"Глюкоза натощак из вены, HbA1c, ГТТ, инсулин, С-пептид, липиды, ОАМ на глюкозу/кетоны.",
  triggers:{
    core:    [/постоянная\s+жажда|сильная\s+жажда|жажда\s+постоянн|жажду\s+постоянн/i, /много\s+пью\s+и\s+вс[её]\s+равно\s+сушит|сушит\s+во\s+рту/i, /полиурия|полидипсия/i, /сухость\s+во\s+рту.*жажда|жажда.*сухость\s+во\s+рту/i],
    typical: [/часто(е)?\s+(обильное\s+)?\s*мочеиспускан|часто\s+хожу\s+в\s+туалет\s+по[\s-]?маленьк|часто\s+писа|мочусь\s+часто/i, /встаю\s+(пить|писать|в\s+туалет)\s+ночью|ночные\s+походы\s+в\s+туалет|встаю\s+ночью\s+в\s+туалет/i, /сухость\s+во\s+рту/i, /зуд\s+(в\s+промежности|кожный|в\s+паху)/i, /долго\s+заживают\s+раны|фурункул|чир[ьй]и/i, /постоянная\s+слабость.*(жажда|пить)/i],
    mild:    [/похудел\s+без\s+диет|резкое\s+похудение/i, /слабость\s+постоянн/i],
    risk:    [/диабет\s+у\s+(родствен|мам|пап)/, /ожирени|лишн\s+вес|имт\s+\d+/, /возраст\s+(45|50|55|60)\+/],
    against: []
  },
  questions:[
    {q:"Пью БОЛЕЕ 3 л в сутки и всё равно сушит во рту?",w:2,key:"drink"},
    {q:"Часто хожу в туалет по-маленькому, в том числе ночью (2+ раз)?",w:2,key:"urine"},
    {q:"Зуд промежности/кожи, долго заживают ранки, фурункулы?",w:1,key:"skin"},
    {q:"Резкое похудение без диет за 1–2 мес?",w:1,key:"wt"},
    {q:"Диабет у близких родственников + избыточный вес?",w:1,key:"risk"}
  ],
  advLow:"Жажда после жары/физнагрузки нормальна; иначе сдайте глюкозу натощак и HbA1c планово.",
  advMed:"Обязательно сдайте глюкозу из вены НАТОЩАК и HbA1c у терапевта/эндокринолога.",
  advHigh:"Выраженная жажда + полиурия + запах ацетона изо рта/рвота — кетоацидоз, срочно."
},
{ id:"headache_mig", urgent:false,
  name:"Мигрень / головная боль напряжения",
  doctor:"Невролог/цефалголог",
  desc:"ГБН — сжимающая «обруч» напряжения; мигрень — пульсирующая односторонняя, с тошнотой и фото/фонофобией, иногда с аурой.",
  symptoms:"См. тест. Учащение >3 приступов в месяц = профилактика (бета-блокаторы, Амитриптилин и др.).",
  tests:"Осмотр невролога, АД; при атипичной — КТ/МРТ, осмотр глазного дна.",
  triggers:{
    core:    [/мигрен/i, /головн.*\s+бол(ит|ь)/i, /болит\s+голова/i, /головная\s+боль/i, /головн.*\s+бол.*(пульсиру|пульсаци)/i, /головн.*\s+бол.*(как\s+обруч|обручем|сжимающ|стягивающ|давящ)/i, /(пульсиру|сжимающ|давящ)\w*\s+головн.*\s+бол/i, /головная\s+боль\s+напряжен/i],
    typical: [/головн.*\s+бол.*с\s+одной\s+сторон/i, /головн.*\s+бол.*(тошнит|тошнота|светобоязн|звукобоязн|боюс[ья]\s+света|не\s+переношу\s+свет)/i, /головн.*\s+бол.*(компьютер|стресс|недосып|напряжен|напряжении|работе)/i, /пульсиру(ет|в\s+виске)/i, /головная\s+боль.*от\s+усталости/i],
    mild:    [/головн[аоу]?\s+бол.*при\s+работе\s+за\s+(компьютер|экран)/i, /головн[аоу]?\s+бол.*стресс/i, /головн[аоу]?\s+бол.*недосып/i, /головн[аоу]?\s+бол.*напряжен/i],
    risk:    [/недосып|обезвоживание|много\s+кофе|красное\s+вино|сыр|шоколад/],
    against: [/громоподоб|худшая\s+в\s+жизни|слабость\s+в\s+конечностях|асимметр/]
  },
  questions:[
    {q:"Боль пульсирующая, с одной стороны, усиливается при движении?",w:2,key:"puls"},
    {q:"Есть тошнота и свет-/звукобоязнь во время приступа?",w:2,key:"naus"},
    {q:"Перед приступом видите вспышки/зигзаги/слепые пятна (аура)?",w:1,key:"aura"},
    {q:"Сжимающая как обруч, без тошноты, после долгой работы/стресса?",w:2,key:"tens"},
    {q:"Частота приступов >2 раз в неделю?",w:1,key:"freq"}
  ],
  advLow:"Нормализация сна/питья, разминка шеи, парацетамол/ибупрофен в начале приступа.",
  advMed:"Дневник головных болей и приём невролога. При мигрени — триптаны в начале приступа (суматриптан 50–100 мг), при частых — профилактика.",
  advHigh:"При изменении характера ГБ или очаговых симптомах — срочно (см. инсульт/САК)."
},
{ id:"dyspeps_bppv", urgent:false,
  name:"Доброкачественное позиционное головокружение (ДППГ) / лабиринтит",
  doctor:"Невролог/ЛОР",
  desc:"Чаще всего смещение отолитов в полукружных каналах — короткие приступы вращения при смене положения головы. Лечится манёвром Эпли.",
  symptoms:"Секунды–минуты вращения при повороте головы/вставании/запрокидывании; более длительные (дни) — после ОРВИ (вестибулярный нейронит).",
  tests:"Проба Дикса-Холлпайка, манёвр Эпли, АД ортостатически, УЗИ БЦА.",
  triggers:{
    core:    [/головокруж/i, /кружит(ся)?\s+голов/i, /голов[ау]\s+круж/i, /вертиго/i, /головокруж.*при\s+повороте\s+головы/i, /кружится\s+голова\s+(когда|при)\s+(ложусь|встаю|запрокидываю|резко\s+встаю)/i, /кружится\s+голова.*(при\s+смене\s+положени|резко)/i],
    typical: [/все\s+кружится.*(секунд|минут)/i, /вертиго/i, /дпг|отолит/i],
    mild:    [/головокруж.*после\s+орви|простуды/i, /резко\s+встаю.*темнеет\s+в\s+глазах/i],
    risk:    [/шейный\s+остеохондроз|шейныи?\s+отдел/],
    against: [/постоянное\s+головокружение\s+(день|дней|недел)/]
  },
  questions:[
    {q:"Вращение секунд/минут ПРИ ПОВОРОТЕ головы или вставании с постели?",w:3,key:"pos"},
    {q:"Возникло после ОРВИ и длится часы/дни?",w:2,key:"postv"},
    {q:"Есть шум в одном ухе или снижение слуха?",w:2,key:"ear"},
    {q:"При вставании резко темнеет в глазах (ортостатика)?",w:1,key:"ortho"},
    {q:"Постоянное «как в тумане» без вращения?",w:-1,key:"fog"}
  ],
  advLow:"Соблюдайте осторожность при смене положения. Манёвр Эпли у ЛОРа/невролога часто излечивает за 1–2 сеанса.",
  advMed:"Осмотр ЛОРа/невролога, проба Дикса-Холлпайка, бетагистин 24 мг × 2 р/сут курсом по назначению.",
  advHigh:"При шуме в ухе + снижении слуха — исключить болезнь Меньера/инсульт ствола (срочно)."
},
{ id:"back_low", urgent:false,
  name:"Люмбоишиалгия / грыжа межпозвоночного диска",
  doctor:"Невролог/вертебролог; нейрохирург при синдроме конского хвоста",
  desc:"Чаще протрузия/грыжа L4–L5/L5–S1 с корешковой компрессией.",
  symptoms:"Боль в пояснице, стреляющая в ягодицу и заднюю/боковую поверхность ноги до стопы, онемение голени/стопы, симптом Ласега.",
  tests:"Осмотр невролога, МРТ поясничного отдела (при неэффективности консервативного лечения 4–6 нед или тревожных знаках).",
  triggers:{
    core:    [/прострел.*поясни/, /люмбаг/, /ишиас/, /стреляет\s+в\s+ног/, /боль\s+в\s+пояснице.*отда[её]т\s+в\s+ног/, /боль\s+в\s+спин|боль\s+в\s+пояснице|болит\s+спин|болит\s+поясниц/i, /остеохондроз/i],
    typical: [/онемени[её]\s+(голени|стопы|ягодиц)/i, /(боль|тянет).*ягодиц.*и\s+по\s+(задней|боковой)\s+поверхности\s+ноги/i, /не\s+могу\s+наклониться/i, /симптом\s+ласег/i],
    mild:    [/тянет\s+ногу\s+сзади/i, /поясниц[ае]\s+после\s+подъ[её]ма\s+тяжест/i, /боль\s+в\s+поясниц[е]/i],
    risk:    [/подъ[её]м\s+тяжест|сидячая\s+работ|гиподинами|ожирение/],
    against: []
  },
  questions:[
    {q:"Боль стреляет/отдаёт в ягодицу и ниже колена по задней стороне ноги?",w:2,key:"rad"},
    {q:"Есть онемение/покалывание в голени/стопе?",w:1,key:"par"},
    {q:"Не могу поднять большой палец ноги/стопу на себя (слабость)?",w:3,key:"weak"},
    {q:"Нарушение мочеиспускания/онемение промежности? (синдром конского хвоста)",w:4,key:"cauda"},
    {q:"Возникло после подъёма тяжести/неудобного движения?",w:1,key:"trig"}
  ],
  advLow:"Покой 1–2 сут, НПВС под прикрытием омепразола 3–5 дней, местно разогревающие гели. После стихания боли — ЛФК.",
  advMed:"Невролог: осмотр, физиотерапия, МРТ по показаниям. ЛФК обязательно.",
  advHigh:"Слабость в ноге/недержание/онемение промежности — нейрохирург СРОЧНО!"
},
{ id:"panic", urgent:false,
  name:"Паническая атака / тревожное расстройство",
  doctor:"Психотерапевт/психиатр",
  desc:"Эпизоды внезапного интенсивного страха с вегетативной симптоматикой. Опасны для жизни сами по себе нет, но важно сначала исключить соматику (ИМ, ТЭЛА, феохромоцитома, тиреотоксикоз, аритмия).",
  symptoms:"Пик за 5–10 мин: сердцебиение, пот, дрожь, удушье, ком в горле, головокружение, страх смерти/сойти с ума, онемение пальцев, дереализация.",
  tests:"ЭКГ, ТТГ, Д-димер при риске, ОАК.",
  triggers:{
    core:    [/паническ.*атак/, /дереализаци/, /страх\s+сойти\s+с\s+ума/, /страх\s+умереть\s+во\s+время\s+приступа/],
    typical: [/внезапный\s+приступ\s+страха\s+с\s+учащ[её]нным\s+сердцебиением/, /ком\s+в\s+горле.*(не\s+могу\s+вздохн|удушье)/, /предчувствие\s+беды/],
    mild:    [/не\s+хватает\s+воздуха\s+при\s+волнени/, /при\s+волнении\s+сердцебиение\s+и\s+дрожь/],
    risk:    [/стресс|недосып|кофеин\s+много|тревожно/],
    against: [/боль\s+за\s+грудин.*нагрузк|отёк\s+ноги|свист\s+в\s+груд/]
  },
  questions:[
    {q:"Пик страха/паники наступает за 5–10 мин и проходит за 20–30 мин?",w:2,key:"timing"},
    {q:"Во время приступа есть ≥4 из: пот/дрожь/удушье/ком/тошнота/головокружение/онемение/жар?",w:2,key:"sym"},
    {q:"Вне приступа есть постоянная тревога ожидания нового?",w:1,key:"ant"},
    {q:"Обследовались (ЭКГ, ТТГ) — отклонений не нашли?",w:1,key:"neg"}
  ],
  advLow:"Техника «4-7-8» дыхания и «5-4-3-2-1», снижение кофеина/алкоголя/энергетиков, нормализация сна.",
  advMed:"Психотерапевт (КБТ), по показаниям СИОЗС; обязательно исключите тиреотоксикоз (ТТГ), феохромоцитому, аритмию.",
  advHigh:"Частые приступы с избеганием мест/ситуаций (агорафобия) — нужна КБТ и, возможно, медикаментозное лечение."
},
{ id:"urt", urgent:false,
  name:"ОРВИ / вирусная инфекция / острый тонзиллофарингит",
  doctor:"Терапевт/ЛОР; при длительности >7 д или налётах на миндалинах",
  desc:"Чаще вирусная инфекция ВДП; антибиотики показаны только при бактериальной ангине (стрептококк) и подтверждённой бактериальной инфекции.",
  symptoms:"Температура до 38–39°C, насморк, боль/першение в горле, кашель, слабость. Белые налёты + высокая t + увеличенные шейные лимфоузлы = ангина (стрептатест).",
  tests:"Стрептатест, ОАК при t>3 д, СРБ.",
  triggers:{
    core:    [/насморк|заложенн.*нос|першение\s+в\s+горле|орви|простуд|болит\s+горло|боль\s+в\s+горле|каш(е|л)ль(?!\w)/i, /сухой\s+кашель|кашляю/i],
    typical: [/боль\s+в\s+горле\s+(при\s+глотан)?/, /кашель\s+с\s+мокротой\s+светлой/, /каш(е|л)ль\s+сухой/, /температур(а|ой|ы)?\s*(37|38|39)/, /чихани|слабост/i],
    mild:    [/ломота\s+в\s+мышцах|ломит\s+тело|слабост.*температур/],
    risk:    [/контакт\s+с\s+заболевшим/],
    against: [/белые\s+нал[её]ты.*миндалин.*высокая\s+температур|температура\s+\d+.*сыпь|одышка/]
  },
  questions:[
    {q:"Белые налёты/гнойные пробки на миндалинах и t>38.5?",w:2,key:"strep"},
    {q:"Сильная боль с одной стороны, не могу глотать слюну?",w:3,key:"quinsy"},
    {q:"Ригидность шеи, головная боль, сыпь?",w:3,key:"men"},
    {q:"Кашель более 2 недель после ОРВИ?",w:1,key:"pertuss"}
  ],
  advLow:"Обильное питьё 2–2.5 л, солевой раствор в нос, полоскание горла, парацетамол при t>38.5.",
  advMed:"Сделайте стрептатест, при положительном — амоксициллин по назначению врача. Осмотр терапевта при длительности >7 дней.",
  advHigh:"Не могу глотать слюну, скованность шеи, сыпь, одышка — срочно."
},
{ id:"otitis", urgent:false,
  name:"Наружный/средний отит, евстахиит (боль в ухе)",
  doctor:"ЛОР/терапевт",
  desc:"Боль, заложенность, стрельба в ухе, снижение слуха; может быть после ОРВИ, ныряния, чистки ушей палочками.",
  symptoms:"Стреляющая/пульсирующая боль в ухе, отдаёт в челюсть/голову, выделения из уха, снижение слуха, температура.",
  tests:"Осмотр ЛОРа (отоскопия), при необходимости посев из уха, ОАК.",
  triggers:{
    core:    [/болит\s+ухо|боль\s+в\s+ухе|стреля(ет)\s+в\s+ух/i, /отит|евстахиит/i, /заложенн.*ух/i],
    typical: [/стреляющ.*боль\s+в\s+ух/, /выделения\s+из\s+уха/i, /снижение\s+слуха.*ух/i, /после\s+орви.*ух/i, /ныря(л|ние).*ух/i],
    mild:    [/чешется\s+ухо/i, /серн.*пробк/i],
    risk:    [/простуд.*неделю/i, /купан.*бассейн/i, /чист.*уши\s+палочк/i],
    against: [/головокруж.*\s+шум\s+в\s+ухе.*снижение\s+слуха/i]
  },
  questions:[
    {q:"В ухе стреляет/пульсирует, боль усиливается ночью?",w:2,key:"throb"},
    {q:"Есть выделения из уха (гной/кровь)?",w:3,key:"perf"},
    {q:"Сильно снижен слух с одной стороны или шум в ухе?",w:2,key:"hl"},
    {q:"Боль появилась после ныряния/чистки ушей/ОРВИ?",w:1,key:"cause"}
  ],
  advLow:"Сухое тепло, сосудосуживающие капли в нос при заложенности, обезболивающее. Не мочите ухо и не чистите палочками.",
  advMed:"Осмотр ЛОРа: при бактериальном отите — ушные/системные антибиотики, при наружном — капли с антибиотиком/кортикостероидом.",
  advHigh:"Отёк за ухом, высокая t, головокружение, парез лица — срочно (мастоидит)."
},
{ id:"gastro_enter", urgent:false,
  name:"Острая кишечная инфекция / гастроэнтерит / пищевое отравление",
  doctor:"Терапевт/инфекционист; при обезвоживании — срочно",
  desc:"Чаще вирусный (ротавирус, норовирус) или бактериальный; опасность — обезвоживание у детей/пожилых.",
  symptoms:"Жидкий стул (понос) несколько раз в сутки, спазмы в животе, тошнота/рвота, температура, слабость.",
  tests:"При длительности >3 д или крови — ОАК, копрограмма, посев кала, ротавирус/норовирус.",
  triggers:{
    core:    [/понос|диарея|жидкий\s+стул|частый\s+стул/i, /рвот.*понос|рвота.*понос/i, /отравлени/i],
    typical: [/спазм.*в\s+животе/i, /болит\s+живот.*понос/i, /тошнит.*понос/i, /температур.*понос/i],
    mild:    [/урчание\s+в\s+животе/i, /слабость.*понос/i, /после\s+еды\s+в\s+общепит/i],
    risk:    [/ел.*несвеж/i, /контакт\s+с\s+заболев/i, /поездк.*юг|отпуск/i],
    against: [/длится\s+(больше\s+)?\d+\s+нед(ел)?/i]
  },
  questions:[
    {q:"Стул чаще 5 раз/сут, есть рвота?",w:2,key:"freq"},
    {q:"Кровь/слизь в стуле, высокая t?",w:3,key:"blood"},
    {q:"Сухость во рту, мало мочи, головокружение при вставании (обезвоживание)?",w:3,key:"dehy"},
    {q:"Болели/ели вместе с кем-то в общепите/дома?",w:1,key:"src"}
  ],
  advLow:"Дробное питьё (Регидрон/солевые растворы по 2–3 глотка каждые 5–10 мин), диета (рис, бананы, сухарики), сорбенты.",
  advMed:"Осмотр терапевта/инфекциониста, при бактериальной причине — антибиотики по назначению, пробиотики.",
  advHigh:"Кровь в стуле, высокая t, обезвоживание, выраженная слабость — срочно."
},
{ id:"constipation", urgent:false,
  name:"Запор (функциональный/алиментарный)",
  doctor:"Терапевт/гастроэнтеролог",
  desc:"Стул реже 3 раз в неделю, плотный, с натуживанием; чаще из-за питания, гиподинамии, препаратов (железо, опиоиды, спазмолитики).",
  symptoms:"Редкий плотный стул, вздутие, дискомфорт в левой подвздошной области, иногда трещины заднего прохода.",
  tests:"При тревожных знаках — колоноскопия, ТТГ, копрограмма.",
  triggers:{
    core:    [/запор|нет\s+стула|редкий\s+стул|не\s+хожу\s+в\s+туалет\s+по[\s-]?больш/i, /трудно\s+сходить\s+в\s+туалет/i],
    typical: [/плотный\s+стул|овечий\s+стул/i, /тужусь\s+в\s+туалет/i, /вздутие.*нет\s+стула/i],
    mild:    [/мало\s+клетчатк/i, /пью\s+мало\s+воды/i, /сидячая\s+работ/i],
    risk:    [/геморрой|трещин/i, /принимаю\s+железо|антидепресс/i, /гипотир/i],
    against: [/кровь\s+в\s+стуле|похудение|сильная\s+боль/i]
  },
  questions:[
    {q:"Стул реже 1 раза в 3 суток, плотный/овечий?",w:2,key:"freq"},
    {q:"Меняете питание — запор уходит? (функциональный)",w:1,key:"diet"},
    {q:"Принимаете железо/спазмолитики/антидепрессанты/опиоидные препараты?",w:1,key:"drug"},
    {q:"Похудение, кровь в стуле, боли в животе без стула более 3 сут?",w:-3,key:"redflag"}
  ],
  advLow:"Пейте 1.5–2 л воды в день, увеличьте клетчатку (овощи, отруби, чернослив), двигательная активность, по необходимости лактулоза/макрогол.",
  advMed:"Если коррекция диеты не помогает >4–6 нед — осмотр терапевта/гастроэнтеролога, ТТГ, копрограмма.",
  advHigh:"Нет стула + газов более 2–3 сут, рвота, сильная боль, кровь — срочно (кишечная непроходимость)."
},
{ id:"abdominal_gen", urgent:false,
  name:"Функциональная абдоминальная боль / гастрит/дуоденит",
  doctor:"Терапевт/гастроэнтеролог",
  desc:"Дискомфорт/боль в животе без уточнённой локализации может быть связана с питанием, гастритом, СРК, рефлюксом.",
  symptoms:"Ноющая/спастическая боль, вздутие, отрыжка, тошнота после еды или натощак.",
  tests:"Осмотр терапевта, по показаниям УЗИ ОБП, ФГДС, копрограмма, ОАК.",
  triggers:{
    core:    [/болит\s+живот|боль\s+в\s+животе/i],
    typical: [/болит\s+в\s+эпигастр|в\s+верху\s+живота|под\s+ложечкой/i, /тошнит.*после\s+ед/i, /отрыжка/i, /ноющ.*боль\s+в\s+живот/i],
    mild:    [/погрешност.*в\s+диете/i, /после\s+жарен|фастфуд/i, /голодн.*боль/i],
    risk:    [/гастрит|язва|хеликобактер/i, /принимаю\s+нпвс|аспирин|ибупроф/i],
    against: [/острая\s+боль|резкая\s+боль|боль\s+справа.*температур/i]
  },
  questions:[
    {q:"Где именно болит (верх, низ, справа, слева, вокруг пупка)?",w:2,key:"loc"},
    {q:"Боль натощак или после еды? Есть отрыжка/изжога?",w:1,key:"food"},
    {q:"Стул нормальный, нет крови/чёрного стула?",w:2,key:"safe"},
    {q:"Принимаете аспирин/ибупрофен/НПВС?",w:1,key:"drug"}
  ],
  advLow:"Щадящая диета, дробное питание, исключить жирное/жареное/алкоголь, при боли — спазмолитик (дротаверин).",
  advMed:"При болях >2 нед — УЗИ ОБП, ФГДС, ОАК, тест на H.pylori, осмотр гастроэнтеролога.",
  advHigh:"Острая сильная боль, доска-живот, чёрный/кровавый стул, рвота кровью, t — срочно хирург."
},
{ id:"dyspnea", urgent:false,
  name:"Одышка (дифференциальная диагностика)",
  doctor:"Терапевт/кардиолог/пульмонолог; при внезапной одышке — срочно",
  desc:"Одышка при нагрузке может указывать на БА, ХОБЛ, анемию, СН; в покое и внезапная — требует срочной помощи (ТЭЛА, пневмоторакс, бронхоспазм, отёк Квинке).",
  symptoms:"Затруднение вдоха/выдоха, нехватка воздуха, удушье, хрипы.",
  tests:"ЭКГ, ЭхоКГ, ОАК, спирометрия, Rg грудной клетки, СРБ, Д-димер при подозрении на ТЭЛА.",
  triggers:{
    core:    [/одышка|трудно\s+дышать|не\s+хватает\s+воздух|затрудн[её]нн?о\s+дыша/i, /удушье/i],
    typical: [/одышка\s+при\s+нагруз|при\s+ходьб|при\s+подъ[её]ме/i, /хрипы\s+в\s+груд/i, /кашель.*одышка/i],
    mild:    [/покашливание/i, /после\s+простуды/i],
    risk:    [/астма|хобл|курен/i, /сердечная\s+недостаточ/i, /анеми/i, /тромбоз|варикоз/i],
    against: []
  },
  questions:[
    {q:"Одышка возникла ВНЕЗАПНО в покое? (ТЭЛА/пневмоторакс/отёк Квинке)",w:4,key:"sudden"},
    {q:"Хрипы, не могу выдохнуть, раньше была бронхиальная астма?",w:2,key:"asthma"},
    {q:"Отёки ног + одышка при нагрузке, в т.ч. в положении лёжа? (сердце)",w:2,key:"chf"},
    {q:"Одышка только при простуде и с температурой/кашлем?",w:1,key:"inf"}
  ],
  advLow:"Если одышка только при значительной нагрузке и нет других жалоб — плановый осмотр терапевта (ЭКГ, спирометрия, ОАК).",
  advMed:"Плановый осмотр терапевта/пульмонолога, спирометрия, ЭКГ, Rg грудной клетки.",
  advHigh:"Внезапная одышка в покое, удушье, посинение губ, боль в груди, отёк лица/языка — звоните 103 НЕМЕДЛЕННО."
},
{ id:"pruritus_rash", urgent:false,
  name:"Кожный зуд/сыпь (аллергия, дерматит, укусы)",
  doctor:"Дерматолог/аллерголог; при отёке Квинке — срочно",
  desc:"Зуд и высыпания могут быть аллергической (крапивница, контактный дерматит), грибковой, паразитарной (чесотка) или вирусной природы.",
  symptoms:"Зуд, покраснение, пузырьки, пятна, шелушение на разных участках кожи.",
  tests:"Осмотр дерматолога, при необходимости общий IgE, соскоб на грибы/клеща.",
  triggers:{
    core:    [/зуд\s+кож|чешет(ся)?/i, /сыпь|крапивница|пятна\s+на\s+кож|покраснен/i, /дерматит/i],
    typical: [/после\s+(нового|съеден|орех|мед|рыб|антибиотик|крем|моющ)/i, /волдыр|пузырьки/i, /шелушит/i],
    mild:    [/укусы?\s+комар/i, /сухая\s+кожа/i],
    risk:    [/аллерги|поллиноз|астма/i],
    against: [/от[её]к\s+лица|язык|гортан|затрудн.*дыша/i]
  },
  questions:[
    {q:"Сыпь в виде волдырей как от крапивы, быстро проходит и появляется в других местах? (крапивница)",w:2,key:"urt"},
    {q:"Сыпь появилась после нового лекарства/еды/крема?",w:2,key:"trig"},
    {q:"Зуд сильнее ночью, есть чесоточные ходы между пальцами? (чесотка)",w:2,key:"scab"},
    {q:"Отёк губ/языка/лица, затруднение дыхания? (отёк Квинке)",w:4,key:"anaph"}
  ],
  advLow:"Антигистаминное (лоратадин/цетиризин), гипоаллергенная диета, увлажнение кожи, исключить контакт с раздражителем.",
  advMed:"Осмотр дерматолога: местные глюкокортикоиды при дерматите, при подозрении на грибы/чесотку — соскоб и спец. лечение.",
  advHigh:"Отёк лица/губ/языка, затруднение дыхания — звоните 103 (анафилаксия/отёк Квинке)."
},
{ id:"arthralgia", urgent:false,
  name:"Боль в суставах (артралгия/артроз/артрит)",
  doctor:"Терапевт/ревматолог/травматолог",
  desc:"Боль в одном или нескольких суставах: травма, артроз, ревматоидный артрит, подагра, реактивный артрит после инфекции.",
  symptoms:"Боль, припухлость, скованность по утрам, ограничение движений.",
  tests:"ОАК, СРБ, РФ, мочевая кислота, Rg/УЗИ сустава по показаниям.",
  triggers:{
    core:    [/бол(ят|ит)\s+сустав|боль\s+в\s+сустав/i, /артрит|артроз/i, /бол(ят|ит)\s+(колен|плеч|локт|тазобедрен|голеностоп|кист|пальц|запяст|лодыж)/i, /сустав(ы)?\s+бол(ят|ит)/i],
    typical: [/припухл.*сустав/i, /скованность\s+по\s+утр/i, /покраснен.*сустав/i, /ноют\s+сустав/i, /хруст.*колен/i],
    mild:    [/после\s+травм|удара|паден/i, /хруст\s+в\s+сустав/i, /после\s+нагрузк/i, /на\s+погод/i],
    risk:    [/возраст\s+(50|60|70)|пожилой/i, /подагра/i, /псориаз/i],
    against: []
  },
  questions:[
    {q:"Сустав опух, горячий, покраснел, есть t? (воспаление/подагра/септический артрит)",w:3,key:"infl"},
    {q:"Скованность по утрам >30 мин и припухание нескольких суставов симметрично? (РА)",w:2,key:"ra"},
    {q:"Боль после травмы/падения/ушиба?",w:2,key:"trauma"},
    {q:"Сильная боль в большом пальце ноги ночью, краснеет? (подагра)",w:2,key:"gout"}
  ],
  advLow:"Покой холод/тепло, НПВС местно в виде геля, ограничение нагрузки, при травме — фиксация.",
  advMed:"Осмотр терапевта/ревматолога/травматолога, ОАК, СРБ, мочевая кислота, УЗИ/Rg сустава.",
  advHigh:"Высокая t, сильный отёк, невозможность наступить/двигать конечностью — срочно (септический артрит, перелом)."
},
{ id:"htn", urgent:false,
  name:"Артериальная гипертензия (повышенное давление)",
  doctor:"Терапевт/кардиолог",
  desc:"Стойкое АД >140/90; требует дообследования и подбора терапии, чтобы предотвратить инсульт/инфаркт.",
  symptoms:"Головная боль (чаще в затылке), мелькание мушек, шум в ушах, тяжесть в голове, носовые кровотечения.",
  tests:"Суточный мониторинг АД, ЭКГ, липиды, глюкоза, креатинин, калий, ТТГ, ЭхоКГ, осмотр глазного дна.",
  triggers:{
    core:    [/высокое\s+давлени|повышенн.*\s+давлени|гипертони|артериальн.*\s+давлени/i, /давлени(е|й)\s+(1[4-9]\d|2\d\d)\/?\d*/],
    typical: [/головн.*\s+бол.*затыл/i, /мушки\s+перед\s+глаз/i, /шум\s+в\s+ушах/i, /давлени(е|й)\s+\d+\/\d+/i],
    mild:    [/тонометр\s+показ/i, /криз/i],
    risk:    [/лишний\s+вес|ожирение/i, /курен/i, /наследств/i, /стресс/i],
    against: []
  },
  questions:[
    {q:"Давление выше 160/100? (гипертензивный криз)",w:2,key:"crisis"},
    {q:"Есть головная боль в затылке, мушки, тошнота, боль за грудиной?",w:2,key:"symp"},
    {q:"Давление повышается регулярно >2 нед? (хроническая АГ)",w:2,key:"chron"},
    {q:"Первый раз такое и АД >180/110 — срочная помощь.",w:3,key:"urg"}
  ],
  advLow:"Контроль АД в дневнике, ограничение соли <5 г/сут, алкоголя, кофе; снижение веса, физ.активность 30 мин/день.",
  advMed:"Осмотр терапевта/кардиолога, подбор гипотензивной терапии, обследование для исключения вторичной АГ.",
  advHigh:"АД >180/110 + головная боль/тошнота/боль за грудиной/нарушение речи/слабость в конечностях — звоните 103."
},
{ id:"edema", urgent:false,
  name:"Отёки (дифференциация почечных/сердечных/венозных)",
  doctor:"Терапевт первично; далее — кардиолог/нефролог/флеболог",
  desc:"Симметричные голени к концу дня при СН/варикозе; отёки лица утром — почки; односторонний — ТГВ/флебит.",
  tests:"ОАМ+белок, креатинин, мочевина, АЛТ/АСТ, альбумин, ТТГ, ЭКГ/ЭхоКГ, УЗИ вен.",
  triggers:{
    core:    [/от[её]к(ают|и|ли)?\s+(ноги|голени|стопы|кисти|лиц|век)/i, /от[её]кли\s+ноги/i, /от[её]к\s+одной\s+ноги/i, /отекают\s+голени/i],
    typical: [/к\s+вечеру\s+отекают\s+ноги/i, /от[её]ки\s+лица\s+утром/i, /пена\s+в\s+моче/i, /от[её]ки\s+к\s+вечеру/i, /следы\s+от\s+резинок\s+носок/i],
    mild:    [/кольца\s+врезаются\s+в\s+пальцы/i, /не\s+могу\s+надеть\s+сапоги\s+к\s+вечеру/i],
    risk:    [/сердечная\s+недостаточ|варикоз/i, /гипотир|заболевани\s+поч/i],
    against: []
  },
  questions:[
    {q:"Отёк ОДНОЙ ноги, боль/покраснение/горячая кожа?",w:3,key:"dvt"},
    {q:"Отёки симметричные голеней к вечеру + одышка при нагрузке?",w:2,key:"chf"},
    {q:"Отёки лица/век утром, пена в моче?",w:2,key:"renal"},
    {q:"Отёки + зябкость/запор/выпадение волос (гипотиреоз)?",w:1,key:"thy"}
  ],
  advLow:"Компрессионный трикотаж, ограничение соли, возвышенное положение ног вечером.",
  advMed:"Обследование у терапевта: ОАМ+белок, креатинин, альбумин, ТТГ, ЭКГ, УЗИ вен.",
  advHigh:"Отёк одной ноги — срочно хирург/флеболог (ТГВ)."
},
{ id:"anemia_general", urgent:false,
  name:"Анемия (железодефицит/В12/фолиевая)",
  doctor:"Терапевт/гематолог",
  desc:"Снижение гемоглобина. ЖДА — самый частый вариант (дефицит железа при скудном питании, кровопотерях, беременности), но причина может быть и в В12/фолиевой дефиците, хроническом заболевании и др.",
  symptoms:"Бледность, слабость, одышка при нагрузке, ломкость ногтей/выпадение волос, головокружения, зябкость конечностей, извращение вкуса (мел, лёд).",
  tests:"ОАК (Hb, эритроциты, MCV, MCH), ферритин (цель >50 нг/мл), железо/ОЖСС/трансферрин, В12, фолиевая кислота.",
  triggers:{
    core:    [/бледность\s+кожи|бледные\s+губы/, /слабость.*одышка\s+при\s+нагрузке.*бледн/],
    typical: [/ломкост.*ногт.*выпад.*\s+волос/, /зябк.*рук\s+и\s+ног/, /головокруж.*слабость.*блед/],
    mild:    [/постоянная\s+слабость\s+и\s+быстрая\s+утомляемость/],
    risk:    [/обильные\s+месячные|менорраги|геморрой.*кровотеч|вегетариан/],
    against: []
  },
  questions:[
    {q:"Сильная бледность губ/конъюнктивы/кожи?",w:2,key:"pale"},
    {q:"Одышка при привычной нагрузке и сердцебиение?",w:2,key:"dys"},
    {q:"Ломкие ногти, выпадение волос, сухая кожа?",w:1,key:"nail"},
    {q:"Хочется есть мел/лёд/сырую крупу? (pica)",w:2,key:"pica"},
    {q:"Обильные менструации/геморроидальные кровотечения/диета без мяса?",w:1,key:"cause"}
  ],
  advLow:"Сдайте ОАК и ферритин планово; не принимайте железо вслепую.",
  advMed:"Сдать ОАК, ферритин, железо/ОЖСС, В12, фолиевую кислоту и посетить терапевта для поиска причины и подбора препарата (тардиферон/сорбифер/мальтофер и т.д. под контролем ферритина).",
  advHigh:"Если Hb <70 г/л или есть обмороки — срочно к врачу."
},
{ id:"joint_arth", urgent:false,
  name:"Артралгия/артрит (ревматоидный, реактивный, подагра, ОА)",
  doctor:"Ревматолог/терапевт",
  desc:"Припухшие/горячие суставы требуют исключения воспалительного артрита; хруст и боль при нагрузке — чаще остеоартроз.",
  tests:"ОАК, СОЭ/СРБ, РФ, АЦЦП, мочевая кислота, АСЛ-О, УЗИ/рентген суставов.",
  triggers:{
    core:    [/припух.*сустав/, /опух.*сустав/, /покрасн.*сустав/, /утренняя\s+скованн/],
    typical: [/боль\s+в\s+сустав.*покраснел/, /горячий\s+сустав/, /симметрич.*поражение\s+сустав/],
    mild:    [/суставы\s+хрустят\s+и\s+болят\s+при\s+нагрузк/],
    risk:    [/подагра|псор/],
    against: []
  },
  questions:[
    {q:"Утренняя скованность >30 минут?",w:2,key:"morn"},
    {q:"Припухшие/горячие/красные суставы?",w:2,key:"swell"},
    {q:"Симметричное поражение мелких суставов кистей?",w:2,key:"sym"},
    {q:"Острая сильная боль в плюснефаланговом суставе большого пальца ноги (подагра)?",w:2,key:"gout"},
    {q:"Псориаз у вас или родственников?",w:1,key:"pso"}
  ],
  advLow:"Остеоартроз: ЛФК, снижение веса, хондропротекторы, НПВС коротким курсом.",
  advMed:"Ревматолог: СРБ, РФ, АЦЦП, МК, УЗИ суставов; подбор базисной терапии.",
  advHigh:"Острый покрасневший горячий сустав с высокой t — срочно (исключить септический артрит и подагра)."
},
{ id:"hypo_hyper_thyr", urgent:false,
  name:"Нарушение функции щитовидной железы",
  doctor:"Эндокринолог",
  desc:"Гипертиреоз: похудение, потливость, тахикардия, дрожь, раздражительность. Гипотиреоз: зябкость, прибавка веса, запоры, слабость, выпадение волос, отёки.",
  tests:"ТТГ, св.Т4, АТ-ТПО, УЗИ ЩЖ.",
  triggers:{
    core:    [/щитовидн.*желез.*не\s+в\s+порядк/, /ттг\s+(повышен|понижен)/, /зоб|увеличение\s+щитовидн/],
    typical: [/не\s+переношу\s+жару.*потливость.*похудел/, /не\s+переношу\s+холод.*зябк.*набрал\s+вес/, /экзофтальм|пучеглаз/],
    mild:    [/тремор\s+рук|раздражительность.*бессонни/, /выпадение\s+волос.*сухая\s+кожа.*запор/],
    risk:    [/аутоиммунн|хашимото|диффузн.*зоб|базедова\s+болезн/],
    against: []
  },
  questions:[
    {q:"Похудение, потливость, жарко, дрожь, сердцебиение (гипер)?",w:2,key:"hyper"},
    {q:"Прибавка веса, зябкость, запоры, вялость, отёки (гипо)?",w:2,key:"hypo"},
    {q:"Прощупывается увеличение на шее, ком в горле?",w:1,key:"goiter"},
    {q:"В семье есть заболевания щитовидки?",w:1,key:"hx"}
  ],
  advLow:"Сдайте ТТГ и свободный Т4 планово; это стандартный профиль у эндокринолога.",
  advMed:"ТТГ, св.Т4, АТ-ТПО, УЗИ ЩЖ у эндокринолога; по результатам подбор терапии (L-Т4 или тиреостатики).",
  advHigh:"Выраженный тиреотоксикоз (тахикардия>120, высокая t, возбуждение) — срочно (тиреотоксический криз)."
},
{ id:"depression_mod", urgent:false,
  name:"Депрессивное/тревожное расстройство",
  doctor:"Психотерапевт/психиатр",
  desc:"Длительное (≥2 нед) снижение настроения с ангедонией; требует диагностики и лечения. Перед этим важно исключить гипотиреоз, В12-дефицит и анемию.",
  symptoms:"Подавленное настроение, потеря интересов, нарушение сна/аппетита, усталость, чувство вины, снижение концентрации, суицидальные мысли.",
  tests:"ТТГ, В12, Д, ферритин, ОАК, шкала PHQ-9/GAD-7.",
  triggers:{
    core:    [/депресс/, /ничего\s+не\s+радует|потер[яю]\s+интерес\s+ко?\s+всем/, /апатия\s+(более|дольше|вторую\s+недел|месяц)/],
    typical: [/бессонниц|ранн.*\s+пробужд|плохой\s+сон\s+(вторую\s+недел|месяц|долго)/, /постоянная\s+слабость\s+и\s+плохое\s+настроение/],
    mild:    [/плаксивость|раздражительность|трудно\s+сосредоточиться/],
    risk:    [/стресс|утрата|травма/],
    against: []
  },
  questions:[
    {q:"Плохое настроение/утрата интересов БОЛЬШИНСТВО ДНЯ ≥2 недель?",w:2,key:"time"},
    {q:"Не радуют даже вещи, которые раньше приносили удовольствие?",w:2,key:"anhed"},
    {q:"Снижение/набор веса >5% за месяц, нарушение сна почти ежедневно?",w:1,key:"body"},
    {q:"Усталость и потеря энергии каждый день?",w:1,key:"fat"},
    {q:"Есть мысли, что не хочется жить/суицидальные мысли?",w:4,key:"sui"}
  ],
  advLow:"Режим сна, прогулки 30 мин, умеренная физнагрузка, социальная активность; при ухудшении — специалист.",
  advMed:"Психотерапевт (КБТ) — метод выбора, при необходимости СИОЗС под наблюдением психиатра; параллельно сдать ТТГ, В12, Д, ферритин.",
  advHigh:"Суицидальные мысли/планы — экстренная помощь (служба психпомощи или психиатрическая скорая)."
}
];

/* ---------- ДВИЖОК ВЕРОЯТНОСТЕЙ ---------- */
// Build a normalized (lowercased + ё→е + CI flag) regex once per condition.
const _reCache = new Map();
function prepRe(re){
  if(_reCache.has(re)) return _reCache.get(re);
  let src = re.source;
  // unify ё → е in regex patterns so we match the normalized text
  src = src.replace(/ё/g,'е');
  let flags = re.flags || '';
  if(!flags.includes('i')) flags += 'i';
  // keep global flag if present (not used here, but avoid breakage)
  let r;
  try{ r = new RegExp(src, flags); }catch(e){ r = re; }
  _reCache.set(re, r);
  return r;
}
function scoreCondition(cond, textNorm, ctx){
  let score=0, hits=[], against=0;
  const negText = stripNegations(textNorm);
  function matchAll(arr, weight, label, cap){
    if(!arr) return 0;
    let found=0, total=0;
    for(const re0 of arr){
      const re = prepRe(re0);
      if(re.test(negText)){
        total += weight;
        hits.push(label+(found>0?'#'+found:''));
        found++;
        if(cap && found>=cap) break;
      }
    }
    return total;
  }
  const c = matchAll(cond.triggers&&cond.triggers.core, 3, 'core', 1);  // one core hit is enough
  const t = matchAll(cond.triggers&&cond.triggers.typical, 2, 'typical', 3);  // sum up to 3 typical matches
  const m = matchAll(cond.triggers&&cond.triggers.mild, 1, 'mild', 2);
  const r = matchAll(cond.triggers&&cond.triggers.risk, 1, 'risk', 1);
  if(cond.triggers&&cond.triggers.against){
    for(const re0 of cond.triggers.against){
      if(prepRe(re0).test(negText)) against += 2;
    }
  }
  score = c + t + m + r - against;
  const clinicalPoints = c + t;
  const maxPossible = 12; // 3 + 2*3 + 2 + 1
  let pct = Math.max(0, Math.min(100, Math.round(score/maxPossible*100)));
  let tier = 'none';
  if(cond.urgent && clinicalPoints>=4 && score>=5) tier='urgent';
  else if(score<2 || clinicalPoints<1) tier='none';
  else if(pct>=60) tier='high';
  else if(pct>=25) tier='med';
  else if(pct>=12) tier='low';
  else tier='none';
  return {cond, score, pct, tier, hits, against, clinicalPoints};
}

function analyzeComplaints(text, ctx){
  ctx = ctx || {};
  if(!text||!text.trim()) return [];
  const norm = normText(text);
  const results = [];
  for(const k of SYMPTOM_KB){
    const s = scoreCondition(k, norm, ctx);
    if(s.tier !== 'none') results.push(s);
  }
  results.sort((a,b)=>{
    const order = {urgent:0, high:1, med:2, low:3, none:4};
    if(order[a.tier]!==order[b.tier]) return order[a.tier]-order[b.tier];
    return b.score-a.score;
  });
  return results;
}

/* ---------- РЕНДЕР ---------- */
function renderComplaintsResult(results, box, rawText){
  if(!box) return;
  if(!results.length){
    const v = (rawText||'').trim();
    let html='<div class="rec-item" style="border-color:#999"><div class="tname">ℹ️ По описанию не найдено специфичных совпадений</div>';
    if(v.length>=3){
      html += '<p>Описание короткое и не содержит типичных признаков заболеваний. Уточните жалобы (характер боли, длительность, что усиляет/ослабляет, сопутствующие симптомы) — или сразу ищите в проверенных медицинских справочниках:</p>';
      const sHtml = renderMedSearchBlock(v, []);
      if(sHtml) html += sHtml;
    }else{
      html += '<p>Опишите жалобы чуть подробнее:</p>'+
        '<ul style="margin:4px 0 0 18px">'+
        '<li><b>Где именно</b> и <b>какой</b> дискомфорт или боль?'+
        '<li><b>Когда началось</b> и как быстро нарастало?'+
        '<li>Что <b>усиляет</b> (еда/нагрузка/дыхание/наклон/стресс) и что <b>ослабляет</b>?'+
        '<li>Есть ли <b>температура, тошнота/рвота, одышка, отёки, слабость, потливость, кашель, изменения стула/мочи, похудение, привкусы во рту</b>?' +
        '<li>Сопутствующие заболевания и принимаемые препараты.'+
        '</ul>';
    }
    html += '<p style="color:#888">Напоминаем: приложение не ставит диагноз. При сильной боли, высокой температуре, кровотечении, затруднении дыхания, неврологических симптомах звоните 103.</p></div>';
    box.innerHTML=html;
    bindMedSearch(box);
    return;
  }
  const urg  = results.filter(r=>r.tier==='urgent');
  const high = results.filter(r=>r.tier==='high');
  const med  = results.filter(r=>r.tier==='med');
  const low  = results.filter(r=>r.tier==='low');
  let html='';
  if(urg.length){
    html += '<div class="rec-item hi" style="border-color:#b3261e;background:#fdecea"><div class="tname" style="color:#b3261e">🚨 СРОЧНО: обнаружены признаки состояний, требующих экстренной помощи!</div><ul style="list-style:none;padding:0;margin:6px 0 0">';
    urg.slice(0,3).forEach(r=>{ html += renderDisease(r,true); });
    html += '</ul></div>';
  }
  // High/med
  const primary = [...high, ...med].slice(0,3);
  if(primary.length){
    html += '<div class="rec-item"><div class="tname">📌 Наиболее вероятные причины (по вашему описанию):</div><ul style="list-style:none;padding:0;margin:6px 0 0">';
    primary.forEach(r=>{ html += renderDisease(r,false); });
    html += '</ul></div>';
  }
  // Low probability (just lines, no questionnaire)
  if(low.length){
    html += '<details class="rec-item" style="background:#fafafa"><summary style="cursor:pointer;color:#555">▸ Другие возможные причины с низкой вероятностью ('+low.length+')</summary><ul style="margin:8px 0 0 18px">';
    low.slice(0,6).forEach(r=>{
      html += `<li><b>${escHtml(r.cond.name)}</b> <span style="color:#888">(${r.pct}% совпадения)</span> — ${escHtml(r.cond.doctor)}</li>`;
    });
    html += '</ul></details>';
  }
  // Блок интернет-поиска в мед. справочниках
  const forSearch = [].concat(
    results.filter(r=>r.tier==='urgent'),
    results.filter(r=>r.tier==='high'),
    results.filter(r=>r.tier==='med')
  ).slice(0,5);
  const searchHtml = renderMedSearchBlock(rawText||'', forSearch);
  if(searchHtml) html += searchHtml;
  html += '<div class="rec-item" style="background:#f5f5f5"><p style="margin:0;color:#666;font-size:13px">⚠ Приложение даёт справочные подсказки и не заменяет осмотр врача. Вероятность — оценка по ключевым словам, а не диагноз. При угрожающих симптомах звоните 103. Если вы не нашли похожих состояний — дополните описание деталями (характер боли, время начала, сопутствующие симптомы).</p></div>';
  box.innerHTML = html;
  bindQuestionnaires(box);
  bindMedSearch(box);
}

function tierColor(tier){
  return ({urgent:'#b3261e',high:'#ef6c00',med:'#f9a825',low:'#558b2f'})[tier]||'#555';
}
function tierLabel(tier){
  return ({urgent:'🚑 СРОЧНО',high:'🟠 высокая',med:'🟡 средняя',low:'🟢 низкая'})[tier]||'';
}

function renderDisease(r, isUrg){
  const c = r.cond;
  const color = tierColor(r.tier);
  let h = `<li style="margin:12px 0;padding:10px 12px;border-left:4px solid ${color};background:#fff;border-radius:0 8px 8px 0;box-shadow:0 1px 2px rgba(0,0,0,0.05)">`;
  h += `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px">`;
  h += `<div style="font-weight:700;color:${color};font-size:16px;flex:1;min-width:220px">${escHtml(c.name)}</div>`;
  h += `<span style="background:${color}1f;color:${color};padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600">${tierLabel(r.tier)} · ${r.pct}%</span>`;
  h += `</div>`;
  h += `<div style="margin:6px 0;color:#444"><b style="color:#1565c0">➜ Врач:</b> ${escHtml(c.doctor)}</div>`;
  if(c.desc)    h += `<div style="margin:5px 0;font-size:14px"><b>Что это:</b> ${escHtml(c.desc)}</div>`;
  if(c.symptoms)h += `<div style="margin:5px 0;font-size:14px"><b>Как проявляется:</b> ${escHtml(c.symptoms)}</div>`;
  if(c.tests)   h += `<div style="margin:5px 0;font-size:14px"><b>Обследование:</b> ${escHtml(c.tests)}</div>`;
  if(c.risks)   h += `<div style="margin:5px 0;font-size:13px;color:#555"><b>Факторы риска:</b> ${escHtml(c.risks)}</div>`;
  if(c.redflags)h += `<div style="margin:6px 0;padding:6px 8px;background:#fff3e0;border-left:3px solid #ef6c00;border-radius:4px;font-size:13px"><b style="color:#ef6c00">⚠ Тревожные признаки:</b> ${escHtml(c.redflags)}</div>`;
  // Show questionnaire only for primary+urgent (top 3) AND probability >= med (≥40%)
  if(c.questions && c.questions.length && (isUrg || r.tier==='high' || r.tier==='med')){
    h += `<div style="margin-top:8px">`;
    h += `<button class="btn btn-quiz" data-qz="${c.id}" style="background:#1565c0;color:#fff;border:none;padding:7px 14px;border-radius:18px;cursor:pointer;font-weight:600">🔎 Проверить детально (опросный лист)</button>`;
    h += `<div class="quiz-block" data-qz-body="${c.id}" style="display:none;margin-top:8px"></div>`;
    h += `</div>`;
  }else if(c.questions && r.tier==='low'){
    h += `<div style="margin-top:6px;font-size:13px;color:#888">Сходство небольшое. Опросный лист появится, если описание будет содержать больше характерных признаков.</div>`;
  }
  h += `</li>`;
  return h;
}

/* ---------- ОПРОСНИК ---------- */
function buildQuiz(cond, answers){
  let score=0, max=0;
  cond.questions.forEach((q,i)=>{
    let w = q.w||1; if(w<0) w=0; // ignore against-questions in percentage, but use them in advice
    max += w;
    if(answers[i]===true) score += (q.w||1);
  });
  const pct = max? Math.round(Math.max(0,score)/max*100) : 0;
  let tier, tierText, tierColor, adv;
  if(pct>=70){ tier='high'; tierText='высокая'; tierColor='#b3261e'; adv=cond.advHigh; }
  else if(pct>=40){ tier='med'; tierText='средняя'; tierColor='#ef6c00'; adv=cond.advMed; }
  else if(pct>=20){ tier='low'; tierText='низкая'; tierColor='#2e7d32'; adv=cond.advLow; }
  else { tier='min'; tierText='малая'; tierColor='#1565c0'; adv=cond.advLow; }
  let html = `<div style="background:#f9fbe7;border:1px solid #c0ca33;border-radius:8px;padding:10px;margin-top:8px">`;
  html += `<div><b>🧾 Результат уточнения:</b> вероятность по <b>${escHtml(cond.name)}</b> — <span style="color:${tierColor};font-weight:700">${tierText} (${pct}%)</span></div>`;
  html += `<div style="margin-top:6px"><b>📌 Рекомендация:</b> ${escHtml(adv||cond.advice||'')}</div>`;
  // Recommended tests reminder if med/high
  if(tier==='high'||tier==='med'){
    if(cond.tests) html += `<div style="margin-top:6px;font-size:13px;color:#444"><b>🧪 Обсудите с врачом:</b> ${escHtml(cond.tests)}</div>`;
    if(cond.redflags) html += `<div style="margin-top:4px;font-size:13px;color:#b3261e"><b>⚠</b> ${escHtml(cond.redflags)}</div>`;
  }
  html += `<div style="margin-top:8px"><button class="btn" data-qz-reset="${cond.id}">↺ Закрыть опрос</button></div>`;
  html += `</div>`;
  return html;
}

function buildQuizForm(cond){
  let html = `<div style="background:#e3f2fd;border-radius:8px;padding:10px;margin-top:6px"><div style="margin-bottom:6px;color:#0d47a1;font-weight:600">Ответьте на вопросы «Да»/«Нет»:</div>`;
  cond.questions.forEach((q,i)=>{
    html += `<div class="q-row" style="margin:8px 0;display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px">
      <div style="flex:1;min-width:240px">${i+1}. ${escHtml(q.q)}</div>
      <div>
        <button type="button" class="chip q-yes" data-i="${i}" data-ans="1" style="background:#e8f5e9;border-color:#2e7d32;color:#1b5e20;min-width:60px;border-radius:14px;padding:6px 12px;cursor:pointer;font-weight:600">Да</button>
        <button type="button" class="chip q-no"  data-i="${i}" data-ans="0" style="background:#ffebee;border-color:#b3261e;color:#b3261e;min-width:60px;border-radius:14px;padding:6px 12px;cursor:pointer;font-weight:600">Нет</button>
      </div>
    </div>`;
  });
  html += `<div style="margin-top:8px"><button type="button" class="btn btn-primary" data-qz-calc>📊 Рассчитать вероятность</button></div>`;
  html += `<div class="quiz-res" style="margin-top:8px"></div></div>`;
  return html;
}

function bindQuestionnaires(box){
  if(!box) return;
  box.querySelectorAll('button[data-qz]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.getAttribute('data-qz');
      const body = box.querySelector(`.quiz-block[data-qz-body="${id}"]`);
      if(!body) return;
      const cond = SYMPTOM_KB.find(k=>k.id===id);
      if(!cond) return;
      body.style.display='block';
      body.innerHTML = buildQuizForm(cond);
      btn.style.display='none';
      const answers = new Array(cond.questions.length).fill(null);
      body.querySelectorAll('.q-yes,.q-no').forEach(b=>{
        b.addEventListener('click',()=>{
          const i = +b.getAttribute('data-i');
          const ans = b.getAttribute('data-ans')==='1';
          answers[i] = ans;
          body.querySelectorAll('.q-row')[i].querySelectorAll('.chip').forEach(c=>{c.style.outline='';c.style.transform='';});
          b.style.outline='2px solid currentColor';
        });
      });
      const calc = body.querySelector('[data-qz-calc]');
      if(calc) calc.addEventListener('click',()=>{
        // Require at least 2 answers
        const answered = answers.filter(a=>a!==null).length;
        const resBox = body.querySelector('.quiz-res');
        if(answered<Math.min(3, cond.questions.length)){
          resBox.innerHTML = '<div style="color:#b3261e;margin-top:6px">Ответьте хотя бы на 3 вопроса, чтобы рассчитать.</div>';
          return;
        }
        resBox.innerHTML = buildQuiz(cond, answers.map(v=>v===true));
        try{ resBox.scrollIntoView({behavior:'smooth', block:'start'}); }catch(_){ try{ resBox.scrollIntoView(); }catch(e){} }
        const reset = resBox.querySelector('[data-qz-reset]');
        if(reset) reset.addEventListener('click',()=>{
          body.style.display='none';
          body.innerHTML='';
          btn.style.display='';
        });
      });
    });
  });
}

function bindComplaintsTab(){
  const ta = document.getElementById('complaintsText');
  const btn = document.getElementById('complaintsGo');
  const webBtn = document.getElementById('complaintsWebSearch');
  const box = document.getElementById('complaintsResult');
  if(!ta||!btn||!box||btn.dataset.bound) return;
  btn.dataset.bound='1';
  function getText(){ return (ta.value||'').trim(); }
  function run(webOnly){
    const v = getText();
    if(v.length<3){ box.innerHTML='<div class="rec-item"><p>Введите хотя бы 2–3 слова жалоб (например: «боль в правом подреберье после жирного, горечь во рту по утрам»). Короткие фразы вроде «кашель», «головная боль», «горечь во рту» уже распознаются и дают предварительную оценку.</p></div>'; return; }
    let res = [];
    if(!webOnly){
      res = analyzeComplaints(v);
      renderComplaintsResult(res, box, v);
    }else{
      // Web-only: analyze first to get best disease names for keywords, then just render the search block + disclaimer
      res = analyzeComplaints(v);
      const primary=[].concat(res.filter(r=>r.tier==='urgent'),res.filter(r=>r.tier==='high'),res.filter(r=>r.tier==='med')).slice(0,5);
      const searchHtml = renderMedSearchBlock(v, primary);
      let h = '<div class="rec-item"><div class="tname">🌐 Поиск в специализированных медицинских справочниках</div><p style="font-size:13px;color:#555">Локальный анализ не запускался — сразу открываем готовый поиск в проверенных медицинских источниках по вашему описанию. Воспользуйтесь кнопкой «🔍 Проанализировать жалобы», чтобы сначала получить предварительную оценку внутри приложения.</p>';
      h += searchHtml + '</div>';
      h += '<div class="rec-item" style="background:#f5f5f5"><p style="margin:0;color:#666;font-size:13px">⚠ Сайты дают справочную информацию и не заменяют врача. При угрожающих симптомах — 103.</p></div>';
      box.innerHTML = h;
      bindMedSearch(box);
    }
    try{ box.scrollIntoView({behavior:'smooth', block:'start'}); }catch(_){ try{ box.scrollIntoView(); }catch(e){} }
  }
  btn.addEventListener('click', ()=>run(false));
  if(webBtn) webBtn.addEventListener('click', ()=>run(true));
  ta.addEventListener('keydown',(e)=>{ if((e.ctrlKey||e.metaKey)&&e.key==='Enter') run(false); });
  document.querySelectorAll('[data-complaint-sample]').forEach(c=>c.addEventListener('click',()=>{
    ta.value = (ta.value ? ta.value+' ' : '') + c.dataset.complaintSample;
    ta.focus();
    run(false);
  }));
}
document.addEventListener('DOMContentLoaded', bindComplaintsTab);
if(document.readyState!=='loading') bindComplaintsTab();

// Quick file picker on decode tab
  const qf = ecvEl('ecvGalleryQuick');
  if (qf){
    qf.addEventListener('change',e=>{
      if (!e.target.files || !e.target.files[0]){ e.target.value=''; return; }
      const f = e.target.files[0];
      const r = new FileReader();
      r.onload = ev=>{
        openEcgViewer({dataUrl:ev.target.result},{runAuto:true});
        e.target.value='';
      };
      r.readAsDataURL(f);
    });
  }

  // ---------- Version check (overridable via csl.by/version.json) ----------
  const CURRENT_VERSION = '1.8.49';
  const VERSION_URL = 'https://csl.by/apps/budzdorov/version.json';
  function showVersionBanner(html, isUpdate){
    let b = document.getElementById('versionBanner');
    if (!b){
      b = document.createElement('div');
      b.id='versionBanner';
      b.style.cssText='position:fixed;left:10px;right:10px;top:10px;padding:12px 14px;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:100;font-size:calc(14px * var(--fz));color:#fff;display:flex;align-items:flex-start;gap:10px;justify-content:space-between';
      b.style.background = isUpdate ? '#b3261e' : '#2e7d32';
      document.body.appendChild(b);
    }
    b.style.background = isUpdate ? '#b3261e' : '#2e7d32';
    b.innerHTML = `<div style="flex:1">${html}</div><button id="vbClose" style="background:rgba(255,255,255,.2);border:none;color:#fff;border-radius:6px;padding:4px 10px;cursor:pointer">✕</button>`;
    b.querySelector('#vbClose').addEventListener('click',()=>b.remove());
  }
  function versionCmp(a,b){
    const pa=(a||'').split('.').map(x=>parseInt(x,10)||0);
    const pb=(b||'').split('.').map(x=>parseInt(x,10)||0);
    for(let i=0;i<3;i++){ if((pa[i]||0)>(pb[i]||0))return 1; if((pa[i]||0)<(pb[i]||0))return -1; }
    return 0;
  }
  function checkVersion(force){
    const last=localStorage.getItem('budzdorov_lastcheck');
    const today=new Date().toISOString().slice(0,10);
    if (!force && last===today){
      // still show cached result if any
      const cached = localStorage.getItem('budzdorov_lastversion');
      if (cached && cached!==CURRENT_VERSION){
        showVersionBanner(`🔄 Доступна новая версия <b>${cached}</b>.<br>Скачать: <a href="https://csl.by/apps/budzdorov/BudZdorov.apk" style="color:#fff;text-decoration:underline">csl.by/apps/budzdorov</a>`, true);
      }
      return;
    }
    try{
      fetch(VERSION_URL+'?t='+Date.now(),{cache:'no-store',mode:'cors'})
        .then(r=>{ if(!r.ok) throw new Error('net'); return r.text(); })
        .then(txt=>{
          let j; try{ j=JSON.parse(txt); }catch(e){
            // Maybe HTML page instead — assume no update info
            j={latest:CURRENT_VERSION};
          }
          localStorage.setItem('budzdorov_lastcheck',today);
          if (j && j.latest){ localStorage.setItem('budzdorov_lastversion',j.latest); }
          if (j && j.latest && versionCmp(j.latest, CURRENT_VERSION)>0){
            const msg = j.message||'Улучшения анализов, ЭКГ-анализатора и исправления.';
            showVersionBanner(`🔄 Доступна новая версия <b>${j.latest}</b>: ${msg}<br>Скачать: <a href="https://csl.by/apps/budzdorov/BudZdorov.apk" style="color:#fff;text-decoration:underline">csl.by/apps/budzdorov/BudZdorov.apk</a>`, true);
          } else if (force){
            showVersionBanner(`✅ У вас актуальная версия (${CURRENT_VERSION}).`, false);
          }
        })
        .catch(()=>{
          if (force) showVersionBanner(`⚠ Не удалось проверить обновления (нет сети или сайт недоступен). Текущая версия ${CURRENT_VERSION}.`, false);
        });
    }catch(e){ if (force) showVersionBanner(`⚠ Не удалось проверить обновления.`, false); }
  }
  // Add "check updates" button to About tab
  const aboutCard2 = document.querySelector('.about-card');
  if (aboutCard2){
    const chk = document.createElement('button');
    chk.className='btn'; chk.textContent='🔄 Проверить обновления';
    chk.addEventListener('click',()=>checkVersion(true));
    const ver = aboutCard2.querySelector('.version');
    aboutCard2.insertBefore(chk, ver);
  }
  setTimeout(checkVersion, 2500);

  // ---------- Service Worker: офлайн-режим для PWA (только http/https) ----------
  // В APK приложение работает с file:///android_asset, где Service Worker не
  // поддерживается WebView, поэтому там регистрация пропускается.
  if ((location.protocol==='http:'||location.protocol==='https:') && 'serviceWorker' in navigator){
    window.addEventListener('load',()=>{ navigator.serviceWorker.register('sw.js').catch(()=>{}); });
  }
})();
