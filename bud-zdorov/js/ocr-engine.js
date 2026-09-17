/* ================================================================
 *  OCR-ENGINE v2 (1.8.50) — извлечение показателей лабораторного
 *  бланка по принципам специализированных сервисов (AWS Textract,
 *  Azure Document Intelligence, Google Document AI):
 *
 *   1. LAYOUT-АНАЛИЗ: слова с bounding box группируются в строки
 *      таблицы по Y, затем в ячейки по X-зазорам. Имя показателя и
 *      его значение связываются ГЕОМЕТРИЕЙ (одна строка таблицы),
 *      а не поиском чисел в тексте — это главная причина ошибок v1.
 *   2. CONFIDENCE: у каждого слова есть уверенность OCR; уверенность
 *      значения = минимум по его цифрам. Низкая уверенность → элемент
 *      помечается «требует проверки» и не вписывается молча
 *      (порог-правило из документации Textract/Tesseract).
 *   3. ВАЛИДАЦИЯ: значение сверяется с физиологически возможными
 *      границами; десятичная запятая НЕ «придумывается» (сдвиг запятой
 *      разрешён только когда целое число физически невозможно).
 *   4. ЕДИНИЦЫ: распознаётся колонка единиц (г/л, ммоль/л, mg/dL…) и
 *      значение приводится к единице приложения (конвертация).
 *   5. FALLBACK: если геометрии нет (старый OCR/текст) — строгий
 *      построчный текстовый разбор без глобального поиска.
 *
 *  Файл чистый (без DOM) — тестируется в Node.
 * ================================================================ */
(function(root){
'use strict';
const E = {};

/* ---------- утилиты ---------- */
function norm(s){ return String(s||'').toLowerCase().replace(/ё/g,'е').replace(/[^a-zа-я0-9]/g,''); }
E.norm = norm;
function mean(a){ return a.length? a.reduce((x,y)=>x+y,0)/a.length : 0; }
function median(a){ if(!a.length) return 0; const s=a.slice().sort((x,y)=>x-y); return s[(s.length/2)|0]; }

/* ---------- словари соответствий именам бланков ---------- */
E.ALIASES = [
  { ids:['aptt'], names:['ачтв ratio','ачтв','аптв','ахтв','активированное частичное тромбопластиновое','ptt','aptt'] },
  { ids:['pti'], names:['% активности протромбинового комплекса','протромбинового комплекса','активности протромбинового','% протромбина по квику','% по квику','prothrombin index','пти','pti'] },
  { ids:['pt'], names:['пв ratio','pb ratio','пр ratio','prothrombin ratio','prothrombin time','pt ratio','протромбиновое время','пв','pb','мно','mho','инр','inr'] },
  { ids:['fib'], names:['фибриноген по клаусу','фибриноген','fibrinogen','фбг'] },
  { ids:['tt'], names:['тромбиновое время','тв ','thrombin time'] },
  { ids:['dimer'], names:['д-димер','d-dimer','д димер'] },
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
  { ids:['baso'], names:['базофилы (кач)','базофилы,%','базофилы, %','базофилы кач','basophils %'] },
  { ids:['baso_abs'], names:['базофилы (кол)','базофилы кол','базофилы, 10','basophils absolute','абс. базофилы'] },
  { ids:['eo'], names:['эозинофилы (кач)','эозинофилы,%','эозинофилы, %','эозинофилы кач','eosinophil %','эозинофилы'] },
  { ids:['eos_abs'], names:['эозинофилы (кол)','эозинофилы кол','эозинофилы, 10','eosinophil absolute','абс. эозинофилы'] },
  { ids:['neut'], names:['нейтрофилы (кач)','нейтрофилы,%','нейтрофилы, %','нейтрофилы кач','сегментоядерные нейтрофилы','neutrophil %','нейтрофилы общие'] },
  { ids:['neut_abs'], names:['нейтрофилы (кол)','нейтроциты кол','нейтрофилы кол','нейтрофилы, 10','нейтрофилы абс','neutrophil absolute','абс. нейтрофилы'] },
  { ids:['lym'], names:['лимфоциты (кач)','лимфоциты,%','лимфоциты, %','лимфоциты кач','lymphocyte %','лимфоциты'] },
  { ids:['lym_abs'], names:['лимфоциты (кол)','лимфоциты кол','лимфоциты, 10','лимфоциты абс','lymphocyte absolute','абс. лимфоциты'] },
  { ids:['mono'], names:['моноциты (кач)','моноциты,%','моноциты, %','моноциты кач','monocyte %','моноциты'] },
  { ids:['mono_abs'], names:['моноциты (кол)','моноциты кол','моноциты, 10','моноциты абс','monocyte absolute','абс. моноциты'] },
  { ids:['band'], names:['палочкоядерные','палочкоядер','band neut','band form','сдвиг влево'] },
  { ids:['meta'], names:['незрелые гранулоциты','metamyelocyte','метамиелоциты','юные нейтрофилы','миелоциты','юные гранулоциты'] },
  { ids:['glu'], names:['глюкоза','glucose','сахар в крови','сахар крови','глюк'] },
  { ids:['chol'], names:['холестерин общий','общий холестерин','общ. холестерин','холестерол','cholesterol total','total chol'] },
  { ids:['ldl'], names:['лпнп','лнп','ldl','липопротеины низкой плотности','холестерин лпнп','холестерин лнп'] },
  { ids:['hdl'], names:['лпвп','лвп','hdl','липопротеины высокой плотности','холестерин лпвп','холестерин лвп'] },
  { ids:['tg'], names:['триглицериды','триглицерид','трлг','triglyceride','tg'] },
  { ids:['creat'], names:['креатинин','creatinine','креат.'] },
  { ids:['urea'], names:['мочевина','urea','bun'] },
  { ids:['ua'], names:['мочевая кислота','uric acid','урическая к-та','uric','мочевой кислоты'] },
  { ids:['bili_total'], names:['билирубин общий','общий билирубин','bilirubin total','общ. билируб'] },
  { ids:['bili_dir'], names:['билирубин прямой','прямой билирубин','bilirubin direct','связанный билируб','конъюгирован'] },
  { ids:['alt'], names:['алт','аланин','алат','alt','аланинаминотрансфер'] },
  { ids:['ast'], names:['аст','аспартат','асат','ast','аспартатаминотрансфер'] },
  { ids:['alp'], names:['щелочная фосфатаза','щф','alp','alkaline phosph'] },
  { ids:['ggt'], names:['гамма-гт','гаммагт','ггт','ггтп','ggt','gamma glutamyl','γ-гт'] },
  { ids:['ldh'], names:['лдг','лактатдегидрогеназа','ldh','лактатдегидроген'] },
  { ids:['ck'], names:['кфк','креатинфосфокиназа','креатинкиназа','ck','креатин киназа'] },
  { ids:['amyl'], names:['альфа амилаза','альфа-амилаза','амилаза общая','амилаза','amylase','α-амилаза','панкреатическая амилаза'] },
  { ids:['tprot'], names:['общий белок','total protein','общ. белок'] },
  { ids:['alb'], names:['альбумин','albumin'] },
  { ids:['fe'], names:['железо сывороточное','сывороточное железо','serum iron','железо сыв','железо','fe'] },
  { ids:['cl'], names:['хлор','хлориды','chloride','хлор сыворот','cl'] },
  { ids:['ferritin'], names:['ферритин','ferritin'] },
  { ids:['crp'], names:['с-реактивный белок','срб','c-реактив','crp','c-reactive','с реактив'] },
  { ids:['tsh'], names:['ттг','tsh','тиреотропный гормон','тиреотропн'] },
  { ids:['ft4'], names:['т4 св','т4 свободный','свободный т4','free t4','ft4','тироксин свободный'] },
  { ids:['ft3'], names:['т3 св','т3 свободный','свободный т3','free t3','ft3','трийодтиронин свобод'] },
  { ids:['atpo'], names:['ат-тпо','ат к тпо','антитела к тпо','анти тпо','anti-tpo','аттпо','анти-тпо'] },
  { ids:['vitd'], names:['25(он)d','25-он d','25 он d','25(oh)d','25-hydroxyvitamin','витамин д','витамин d','25-гидрокси'] },
  { ids:['vitb12'], names:['витамин в12','цианокобаламин','в12','vitamin b12','cobalamin','b12'] },
  { ids:['vitb9'], names:['фолиевая кислота','фолат','folic acid','folate','в9','vitamin b9'] },
  { ids:['k'], names:['калий','kalium','k+','сывороточный калий','k'] },
  { ids:['na'], names:['натрий','natrium','na+','сывороточный натрий','na'] },
  { ids:['ca'], names:['кальций общий','общий кальций','calcium total','общ. кальций','кальций','ca'] },
  { ids:['mg'], names:['магний','magnesium','сывороточный магний','mg'] },
  { ids:['phos'], names:['фосфор неорганический','неорганический фосфор','р неорг','phosphorus','сывороточный фосфор','фосфор'] },
  { ids:['zn'], names:['цинк','zinc','zn'] },
  { ids:['troponin'], names:['тропонин','troponin','тропонин i','тропонин т','high-sensitivity troponin'] },
  { ids:['bnp'], names:['нбп','bnp','nt-probnp','probnp','натрийуретический пептид','мозговой натрийуретический'] },
  { ids:['u_prot'], names:['белок в моче','urine protein','белок мочи','protein urine'] },
  { ids:['u_glu'], names:['глюкоза мочи','сахар мочи','глюкозурия','glucose urine'] },
  { ids:['u_leu'], names:['лейкоциты мочи','лейкоцитурия','wbc urine','лейкоциты в моче'] },
  { ids:['u_bld'], names:['эритроциты мочи','гематурия','rbc urine','эритроциты в моче','кровь в моче'] },
  { ids:['u_dens'], names:['относительная плотность','плотность мочи','удельный вес','urine density','относ плотност'] },
  { ids:['u_ph'], names:['реакция мочи','ph мочи','рh мочи','ph'] },
  { ids:['u_epi'], names:['эпителий плоский','плоский эпителий'] }
];

/* ---------- единицы: приведение к единице приложения ---------- */
// factor: значение_приложения = значение_бланка * factor
E.UNIT_CONV = {
  hgb:  [ {re:/g\/dl|г\/дл|g\/dl/i, f:10} ],
  glu:  [ {re:/mg\/dl|мг\/дл/i, f:1/18.016} ],
  chol: [ {re:/mg\/dl|мг\/дл/i, f:1/38.67} ],
  ldl:  [ {re:/mg\/dl|мг\/дл/i, f:1/38.67} ],
  hdl:  [ {re:/mg\/dl|мг\/дл/i, f:1/38.67} ],
  tg:   [ {re:/mg\/dl|мг\/дл/i, f:1/88.57} ],
  creat:[ {re:/mg\/dl|мг\/дл/i, f:88.4} ],
  urea: [ {re:/mg\/dl|мг\/дл/i, f:1/2.801} ],
  ua:   [ {re:/mg\/dl|мг\/дл/i, f:59.48} ],
  bili_total:[ {re:/mg\/dl|мг\/дл/i, f:17.1} ],
  bili_dir:  [ {re:/mg\/dl|мг\/дл/i, f:17.1} ],
  ca:   [ {re:/mg\/dl|мг\/дл/i, f:0.2495} ],
  fe:   [ {re:/мкг\/дл|ug\/dl|µg\/dl|mcg\/dl/i, f:0.179} ]
};
const UNIT_CELL_RE = /^(\d+\s*)?(x?\s*10\s*[\^⁰¹²³4-9]*\s*)?(г\/л|г\/дл|мг\/л|мг\/дл|мкг\/л|мкг\/мл|мкг\/дл|мкмоль\/л|ммоль\/л|моль\/л|ед\/л|е\/л|мкме\/мл|ме\/л|нг\/мл|нг\/дл|пг\/мл|g\/l|g\/dl|mg\/dl|mg\/l|mmol\/l|µmol\/l|umol\/l|mol\/l|u\/l|iu\/l|miu\/ml|ng\/ml|pg\/ml|mcg\/dl|µg\/dl|%|сек|мин|фл|fl|пг|pg|мм\/ч|мкм|мл|k\/mcb|клет\/мкл|10\^9\/л|10\^12\/л|10\^3\/мкл|10\/л)$/i;
const SCALE_RE = /^10\s*[\^⁰¹²³⁴⁵⁶⁷⁸⁹*x×]?\s*\d?\s*(\/?\s*(л|l|мкл|mkl|dl|дл))/i;
const REF_RE = /(\d[0-9.,]*\s*[-–—]\s*\d)|^<|^>|^не\s|^\(отриц|отрицат|обнаруж/i;

/* ---------- ожидаемые (физиологические) границы ---------- */
E.buildExpected = function(groups){
  const out = {};
  (groups||[]).forEach(g=>(g.tests||[]).forEach(t=>{
    if(!t||!t.id||!t.ranges||out[t.id]) return;
    let lo=Infinity, hi=-Infinity;
    Object.keys(t.ranges).forEach(k=>{
      const r=t.ranges[k];
      if(Array.isArray(r)&&r.length===2){ if(r[0]<lo)lo=r[0]; if(r[1]>hi)hi=r[1]; }
    });
    if(isFinite(lo)&&isFinite(hi)) out[t.id]={lo,hi,unit:t.unit||''};
  }));
  return out;
};

/* ---------- 1. строки таблицы из слов ---------- */
E.rowsFromWords = function(words){
  const ws = (words||[]).filter(w=>w && w.text && String(w.text).trim() && w.bbox);
  if(!ws.length) return [];
  ws.forEach(w=>{ w._cy=(w.bbox.y0+w.bbox.y1)/2; w._h=Math.max(1,w.bbox.y1-w.bbox.y0); });
  ws.sort((a,b)=>a._cy-b._cy || a.bbox.x0-b.bbox.x0);
  const medH = median(ws.map(w=>w._h)) || 12;
  const rows=[]; let cur=[ws[0]], curY=ws[0]._cy;
  for(let i=1;i<ws.length;i++){
    const w=ws[i];
    if(Math.abs(w._cy-curY) <= medH*0.6){ cur.push(w); curY=mean(cur.map(x=>x._cy)); }
    else { rows.push(cur); cur=[w]; curY=w._cy; }
  }
  rows.push(cur);
  return rows.map(rw=>{
    rw.sort((a,b)=>a.bbox.x0-b.bbox.x0);
    return rw;
  });
};

/* ---------- 2. ячейки строки по X-зазорам ---------- */
E.cellsFromRow = function(rowWords){
  const cw = median(rowWords.map(w=>{
    const len=Math.max(1,(w.text||'').length);
    return (w.bbox.x1-w.bbox.x0)/len;
  })) || 8;
  const thr = Math.max(cw*2.2, 6);
  const cells=[]; let cur=[rowWords[0]];
  for(let i=1;i<rowWords.length;i++){
    const gap = rowWords[i].bbox.x0 - rowWords[i-1].bbox.x1;
    if(gap > thr){ cells.push(cur); cur=[rowWords[i]]; }
    else cur.push(rowWords[i]);
  }
  cells.push(cur);
  return cells.map(cwds=>{
    const text = cwds.map(w=>w.text).join(' ');
    const confs = cwds.map(w=>typeof w.confidence==='number'?w.confidence:(w.conf||90));
    return {
      text,
      conf: Math.min.apply(null, confs.concat([100])),
      x0: cwds[0].bbox.x0,
      x1: cwds[cwds.length-1].bbox.x1,
      words: cwds
    };
  });
};

E.buildTable = function(words){
  return E.rowsFromWords(words).map(rw=>{
    const cells = E.cellsFromRow(rw);
    return { cells, text: cells.map(c=>c.text).join('  '), conf: mean(cells.map(c=>c.conf)) };
  });
};

/* ---------- 3. разбор числа с учётом OCR-ошибок ---------- */
function parseNumTok(tok){
  let t = String(tok).trim();
  t = t.replace(/^[<>≈~]=?/,'').replace(/[↑↓↔▲▼»»]$/,'');
  t = t.replace(/[|lIі](?=\d)/g,'1');           // «l38» → «138»
  t = t.replace(/(?<=\d)[oOоО](?=\d)/g,'0');    // «1o0» → «100»
  t = t.replace(/(?<=\d)[,\.](?=\d{3,})/,'');   // «1,380» тыс → не наш случай, пропускаем осторожно
  if(!/^\d+([.,]\d+)?$/.test(t)){
    // «почти число»: двойники цифр буквами, но только если в токене уже есть цифры
    const fixed = String(t).replace(/\s+/g,'')
      .replace(/[OoОо]/g,'0').replace(/[lIІ]/g,'1').replace(/B/g,'8')
      .replace(/З/g,'3').replace(/S/g,'5').replace(/,/g,'.');
    if(/\d/.test(String(t)) && /^[\d.]+$/.test(fixed)){
      const parts = fixed.split('.');
      if(parts.length<=2) t = parts.length===2 ? parts[0]+'.'+parts[1] : parts[0];
    }
  }
  if(!/^\d+([.,]\d+)?$/.test(t)) return null;
  return parseFloat(t.replace(',','.'));
}
E.parseNumTok = parseNumTok;

function tokensOf(cellText){
  // «9 , 5» → «9,5» (разорванная запятая), затем токены по пробелам
  const s = String(cellText).replace(/(\d)\s*([,.])\s*(?=\d)/g,'$1$2');
  return s.split(/\s+/).filter(Boolean);
}

function isRefCell(text){ return REF_RE.test(String(text).trim()); }
function isUnitCell(text){ const t=String(text).trim(); return UNIT_CELL_RE.test(t) || SCALE_RE.test(t); }
function numericCellInfo(cell){
  // возвращает {value, conf, shifted, raw} для ячейки-значения
  const toks = tokensOf(cell.text);
  // ячейка может содержать «138 г/л» — берём первый числовой токен
  for(const tok of toks){
    const v = parseNumTok(tok);
    if(v==null) continue;
    if(/^(10)[\^⁰¹²³⁴⁵⁶⁷⁸⁹]/.test(tok)) continue;      // шкала 10^9
    const wordConf = cell.words.filter(w=>(w.text||'').indexOf(tok)>=0).map(w=>typeof w.confidence==='number'?w.confidence:(w.conf||90));
    return { value:v, conf: wordConf.length? Math.min.apply(null,wordConf) : cell.conf, shifted:false, raw:tok };
  }
  return null;
}

/* сдвиг запятой: только если целое физически невозможно, а вариант с запятой правдоподобен.
 * Работаем с ИСХОДНЫМ токеном, чтобы не терять ведущие нули («045» → 0.45, а не 4.5). */
function maybeShift(rawTok, exp){
  if(!exp) return null;
  const s = String(rawTok).replace(/[^\d]/g,'');
  if(!s || s.length<2) return null;
  const value = parseInt(s,10);
  const implausible = value > exp.hi*4 || (value < exp.lo*0.2 && value>=10);
  if(!implausible) return null;
  for(let cut=1; cut<s.length; cut++){
    const v = parseFloat(s.slice(0,cut)+'.'+s.slice(cut));
    if(v>=exp.lo*0.3 && v<=exp.hi*3) return v;
  }
  return null;
}

/* ---------- 4. сопоставление строки таблицы с показателем ---------- */
function matchAlias(nameText){
  const raw = String(nameText||'');
  const nn = norm(raw);
  if(!nn || nn.length<2) return null;
  let best=null, bestScore=0;
  for(const a of E.ALIASES){
    for(const nm of a.names){
      const key = norm(nm);
      if(!key || key.length<2) continue;
      let score=0;
      if(key.length<=3){
        // короткие аббревиатуры (ПВ, ТТГ, CK, Fe, Ca, K, pH) — только целым «словом»,
        // иначе «fe» находилось бы внутри «ferritin», «ca» внутри «calcium» и т.п.
        const re = new RegExp('(^|[^a-zа-я0-9])'+key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'([^a-zа-я0-9]|$)','i');
        if(re.test(raw)) score = 60 + key.length;
      } else {
        if(nn.indexOf(key)>=0) score = key.length*10+5;                    // точное вхождение
        else if(nn.length>=6 && key.indexOf(nn)===0) score = nn.length*10; // имя бланка — начало алиаса
        else if(key.length>=6 && nn.indexOf(key.slice(0,6))>=0) score = 40; // усечённое/искажённое имя
      }
      if(score>bestScore){ best=a; bestScore=score; }
    }
  }
  return best;
}
E.matchAlias = matchAlias;

/* бланк в 2 колонки: на одной высоте могут стоять две логические строки
 * («Глюкоза 9,5 | Гемоглобин 138»). Режем физическую строку на сегменты по границе
 * «новое имя показателя после уже встретившегося числа». */
function splitRowSegments(cells){
  const segs=[]; let cur=[];
  for(const c of cells){
    const t=(c.text||'').trim();
    const looksName = /[a-zа-я]/i.test(t) && !isUnitCell(t) && !isRefCell(t) && !/^\d/.test(t);
    const curHasNumber = cur.some(x=>/\d/.test(x.text||''));
    if(looksName && curHasNumber && matchAlias(t)){ segs.push(cur); cur=[]; }
    cur.push(c);
  }
  if(cur.length) segs.push(cur);
  return segs.length? segs : [cells];
}
E.splitRowSegments = splitRowSegments;

function analyzeRow(row, expected){
  const cells = row.cells;
  if(!cells.length) return null;
  // имя = ведущие ячейки, пока не встретим чисто числовую/единицу/референс
  let nameParts=[], i=0;
  for(; i<cells.length; i++){
    const t = cells[i].text;
    const hasLetters = /[a-zа-я]/i.test(t);
    const info = numericCellInfo(cells[i]);
    if(!hasLetters && info) break;
    if(isUnitCell(t) || isRefCell(t)) break;
    nameParts.push(t);
    // имя может сразу содержать значение («Глюкоза 9,5») — проверим хвост
  }
  const nameText = nameParts.join(' ');
  const alias = matchAlias(nameText);
  if(!alias) return null;
  const rest = cells.slice(nameParts.length);
  const exp = expected[alias.ids.find(id=>expected[id])] || null;
  // единица и значение среди остальных ячеек
  let unitText='';
  let valueInfo=null;
  for(const c of rest){
    const t=c.text.trim();
    if(!valueInfo && isUnitCell(t)){ unitText += ' '+t; continue; }
    if(isRefCell(t)) continue;                    // колонка референса — НЕ значение
    if(!valueInfo){
      // ячейка «имя+число» или чисто числовая
      const info = numericCellInfo(c);
      if(info){ valueInfo = Object.assign({unit:''}, info); continue; }
    }
    if(valueInfo && !unitText && isUnitCell(t)) unitText = t;
  }
  // если значение не найдено в отдельных ячейках — поищем в хвосте последней ячейки имени
  if(!valueInfo && nameParts.length){
    const last = cells[nameParts.length-1];
    const toks = tokensOf(last.text);
    for(let k=toks.length-1;k>=0;k--){
      const v = parseNumTok(toks[k]);
      if(v!=null){ valueInfo={value:v, conf:last.conf, shifted:false, raw:toks[k]}; break; }
    }
  }
  if(!valueInfo) return { alias, value:null, conf:row.conf, raw:row.text, flags:['novalue'] };
  let value = valueInfo.value, flags=[];
  // конвертация единиц
  const convList = E.UNIT_CONV[alias.ids[0]];
  if(convList && unitText){
    for(const cv of convList){
      if(cv.re.test(unitText)){ value = value*cv.f; flags.push('unit:'+unitText.trim()); break; }
    }
  }
  // сдвиг запятой — только крайний случай
  if(exp && Number.isInteger(value)){
    const sh = maybeShift(valueInfo.raw, exp);
    if(sh!=null){ value=sh; valueInfo.shifted=true; flags.push('shift'); }
  }
  if(exp && (value < exp.lo*0.15 || value > exp.hi*8)) flags.push('range');
  if(valueInfo.conf < 60) flags.push('lowconf');
  return { alias, value, conf: valueInfo.conf, raw: row.text, flags, unit: unitText.trim() };
}
E.analyzeRow = analyzeRow;

/* ---------- 5. главный вход: таблица из слов ---------- */
E.parseFromWords = function(words, expected){
  expected = expected || {};
  const rows = E.buildTable(words);
  const results=[]; const taken=new Set();
  const parsed = [];
  for(const r of rows){
    const segs = splitRowSegments(r.cells);
    if(segs.length<=1){ parsed.push({row:r, res:analyzeRow(r, expected)}); continue; }
    for(const s of segs){
      const seg = { cells:s, text:s.map(c=>c.text).join('  '), conf:Math.min.apply(null, s.map(c=>c.conf==null?90:c.conf)) };
      parsed.push({row:seg, res:analyzeRow(seg, expected)});
    }
  }
  for(let i=0;i<parsed.length;i++){
    const p = parsed[i];
    if(!p.res || !p.res.alias) continue;
    const tidKey = p.res.alias.ids[0];
    if(taken.has(tidKey)) continue;
    let res = p.res;
    if(res.value==null){
      // строка с именем, но без значения: пробуем следующую строку без имени (разорванная строка таблицы)
      const nxt = parsed[i+1];
      if(nxt && !nxt.res){
        const cands = nxt.row.cells.filter(c=>!isRefCell(c.text) && !isUnitCell(c.text) && numericCellInfo(c));
        if(cands.length){
          const info = numericCellInfo(cands[0]);
          let value=info.value, flags=['merged'];
          const exp = expected[res.alias.ids.find(id=>expected[id])];
          if(exp && Number.isInteger(value)){ const sh=maybeShift(info.raw,exp); if(sh!=null){value=sh;flags.push('shift');} }
          if(info.conf<60) flags.push('lowconf');
          res = Object.assign({}, res, {value, conf:Math.min(info.conf, res.conf)-5, flags, raw:res.raw+' | '+nxt.row.text});
        }
      }
      if(res.value==null) continue;
    }
    taken.add(tidKey);
    res.method='table';
    results.push(res);
  }
  return results;
};

/* ---------- 6. текстовый fallback (строки без геометрии) ---------- */
E.parseFromText = function(text, expected){
  expected = expected || {};
  const lines = String(text||'').split('\n').map(l=>l.trim()).filter(l=>l.length>=3 && /[0-9]/.test(l));
  const results=[]; const taken=new Set();
  for(const line of lines){
    // грубые «ячейки» по двойным пробелам (колонки бланка), иначе строка целиком
    const parts = line.split(/\s{2,}/).filter(Boolean);
    const row = { cells:(parts.length>1?parts:[line]).map(t=>({text:t, conf:70, words:[]})), text:line, conf:70 };
    const res = analyzeRow(row, expected);
    if(!res || !res.alias || res.value==null) continue;
    if(taken.has(res.alias.ids[0])) continue;
    taken.add(res.alias.ids[0]);
    res.method='text';
    results.push(res);
  }
  return results;
};

root.OCREngine = E;
})(typeof window!=='undefined' ? window : globalThis);
