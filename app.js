(() => {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const app = document.getElementById('app');

  // ---------- أدوات صغيرة ----------
  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'style') e.style.cssText = v;
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (k === 'value' || k === 'checked') e[k] = v;
        else e.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const k of kids.flat(Infinity)) {
      if (k == null || k === false) continue;
      e.append(k.nodeType ? k : String(k));
    }
    return e;
  }

  const arDigits = (s) => String(s || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  const norm = (s) => arDigits(s)
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/\s+/g, '').toLowerCase();

  // كلمات الاسم للمطابقة: بدون حركات ولا "ال" التعريف، و«عبد الله» تُعامل ككلمة وحدة
  function nameWords(s) {
    return arDigits(s)
      .replace(/[ً-ْـ]/g, '')
      .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
      .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
      .replace(/(^|\s)(عبد|ابو|بو|ام|اب)\s+/g, '$1$2')
      .toLowerCase()
      .split(/[\s._-]+/)
      .filter((w) => w && !/^(بن|ابن|بنت|آل)$/.test(w))
      .map((w) => (w.length > 4 ? w.replace(/^ال/, '') : w))
      .filter(Boolean);
  }

  // كم يشبه الاسم القديم (a) الاسم الجديد (b)؟ 0 = ما يشبه، 100 = مطابق
  function nameScore(a, b) {
    if (!a.length || !b.length) return 0;
    const has = (w) => b.some((x) => x === w || (x.length > 3 && w.length > 3 && (x.startsWith(w) || w.startsWith(x))));
    const sameEnds = a[0] === b[0] && a[a.length - 1] === b[b.length - 1];
    const covered = a.filter(has).length;
    if (covered < a.length && !sameEnds) return 0;
    if (a.join(' ') === b.join(' ')) return 100;
    let s = (covered / a.length) * 50;
    if (a[0] === b[0]) s += 25;
    if (a[a.length - 1] === b[b.length - 1]) s += 25;
    return Math.round(s);
  }

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } };

  // جهاز المسؤول: يُعلَّم عند فتح صفحة التوزيع، وعليه وحده يظهر زرها في الرئيسية
  const isAdmin = () => lsGet('km-admin') === '1';

  // وجهة ثابتة لهذا الجهاز (للتلفزيونات): الرابط الواحد يفتحها مباشرة عند التشغيل
  const homeTarget = () => { try { return JSON.parse(lsGet('km-home-target') || 'null'); } catch { return null; } };
  const setHomeTarget = (t) => lsSet('km-home-target', t ? JSON.stringify(t) : null);
  let autoOpened = false; // يفتح تلقائيًا مرة واحدة لكل تشغيل، حتى لا يحبس المستخدم

  const timeFmt = new Intl.DateTimeFormat('ar-KW-u-nu-latn', { hour: 'numeric', minute: '2-digit' });
  const dateFmt = new Intl.DateTimeFormat('ar-KW-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' });

  function ago(t) {
    const m = Math.floor((Date.now() - t) / 60000);
    if (m < 1) return 'الآن';
    if (m === 1) return 'قبل دقيقة';
    if (m === 2) return 'قبل دقيقتين';
    if (m <= 10) return `قبل ${m} دقائق`;
    return `قبل ${m} دقيقة`;
  }

  // ---------- الرابط والرمز ----------
  const hashParams = () => new URLSearchParams(location.hash.replace(/^#/, ''));
  let P = hashParams();
  const KEY = P.get('k') || lsGet('km-key') || '';
  if (P.get('k')) lsSet('km-key', KEY);
  const DB = (P.get('db') || CFG.dbUrl || '').replace(/\/+$/, '');
  const REMOTE = !!(DB && KEY);

  function link(v, extra) {
    const p = new URLSearchParams();
    if (KEY) p.set('k', KEY);
    if (P.get('db')) p.set('db', P.get('db'));
    if (v && v !== 'home') p.set('v', v);
    for (const [k, val] of Object.entries(extra || {})) p.set(k, val);
    return '#' + p.toString();
  }
  const absLink = (v, extra) => location.href.split('#')[0] + link(v, extra);

  function newKey() {
    const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
    const a = new Uint8Array(24);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => abc[b % abc.length]).join('');
  }

  // ---------- الحالة والمزامنة ----------
  let root = {};
  let ready = !REMOTE;
  let status = REMOTE ? 'connecting' : 'local';
  const subs = new Set();
  let emitQueued = false;
  function emit() {
    if (emitQueued) return;
    emitQueued = true;
    setTimeout(() => { emitQueued = false; subs.forEach((f) => f()); }, 0);
  }
  function setStatus(s) { if (status !== s) { status = s; emit(); } }

  function setAt(path, val) {
    const parts = String(path || '').split('/').filter(Boolean);
    if (!parts.length) { root = (val && typeof val === 'object') ? val : {}; return; }
    let o = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
      o = o[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (val == null) delete o[last]; else o[last] = val;
  }

  const SV = { '.sv': 'timestamp' };
  function localize(d) {
    if (d && typeof d === 'object') {
      if (d['.sv']) return Date.now();
      const o = {};
      for (const k in d) o[k] = localize(d[k]);
      return o;
    }
    return d;
  }

  function applyLocal(method, path, data) {
    if (method === 'DELETE') setAt(path, null);
    else if (method === 'PATCH') for (const [k, v] of Object.entries(data)) setAt((path ? path + '/' : '') + k, v);
    else setAt(path, data);
  }

  async function write(method, path, data) {
    applyLocal(method, path, localize(data));
    emit();
    if (!REMOTE) { saveLocal(); return true; }
    try {
      const url = `${DB}/schools/${encodeURIComponent(KEY)}${path ? '/' + path : ''}.json`;
      const r = await fetch(url, { method, body: method === 'DELETE' ? undefined : JSON.stringify(data) });
      if (!r.ok) throw new Error(String(r.status));
      return true;
    } catch (err) {
      toast('تعذّر الحفظ — تأكد من الإنترنت وحاول مرة ثانية', 'err');
      return false;
    }
  }

  // اتصال مباشر مع Firebase (بدون مكتبات) عن طريق EventSource
  let es = null;
  let lastBeat = Date.now();
  function connect() {
    if (es) es.close();
    es = new EventSource(`${DB}/schools/${encodeURIComponent(KEY)}.json`);
    const beat = () => { lastBeat = Date.now(); };
    es.onopen = () => { beat(); setStatus(ready ? 'ok' : 'connecting'); };
    es.addEventListener('put', (e) => {
      beat();
      const m = JSON.parse(e.data);
      setAt(m.path, m.data);
      ready = true;
      setStatus('ok');
      emit();
    });
    es.addEventListener('patch', (e) => {
      beat();
      const m = JSON.parse(e.data);
      for (const [k, v] of Object.entries(m.data || {})) setAt(m.path.replace(/\/$/, '') + '/' + k, v);
      emit();
    });
    es.addEventListener('keep-alive', () => { beat(); if (ready) setStatus('ok'); });
    es.addEventListener('cancel', () => setStatus('denied'));
    es.onerror = () => { if (es.readyState !== 1) setStatus('off'); };
  }

  // الوضع التجريبي: البيانات محفوظة على هذا الجهاز وتتزامن بين تبويبات المتصفح نفسه
  const LS_STATE = 'km-local-state-v2';
  let bc = null;
  function loadLocal() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(LS_STATE)); } catch { s = null; }
    if (!s || typeof s !== 'object') {
      root = window.SEED ? JSON.parse(JSON.stringify(window.SEED)) : {};
      saveLocal(true);
      return;
    }
    root = s;
  }
  function saveLocal(silent) {
    lsSet(LS_STATE, JSON.stringify(root));
    if (!silent && bc) bc.postMessage(1);
  }

  if (REMOTE) {
    connect();
    // إذا انقطع البث بصمت (مهم للتلفزيونات) نعيد الاتصال
    setInterval(() => { if (Date.now() - lastBeat > 75000) { setStatus('off'); lastBeat = Date.now(); connect(); } }, 20000);
  } else {
    loadLocal();
    try { bc = new BroadcastChannel('km'); bc.onmessage = () => { loadLocal(); emit(); }; } catch { bc = null; }
    window.addEventListener('storage', (e) => { if (e.key === LS_STATE) { loadLocal(); emit(); } });
  }

  // ---------- قراءة البيانات ----------
  const cmpText = (a, b) => String(a).localeCompare(String(b), 'ar', { numeric: true });

  // معلومات الصف من اسمه: "G5A" ← صف 5 شعبة A، "بنات G6" ← بنات صف 6
  function classInfo(label) {
    const L = arDigits(label);
    const m = L.match(/(\d{1,2})\s*([A-Za-z])?/);
    return {
      n: m ? Number(m[1]) : null,
      sec: m && m[2] ? m[2].toUpperCase() : '',
      girls: /بنات/.test(L),
    };
  }
  function cmpClass(a, b) {
    const x = classInfo(a);
    const y = classInfo(b);
    return (x.n ?? 99) - (y.n ?? 99) || cmpText(x.sec, y.sec) || cmpText(a, b);
  }

  const buildings = () => Object.entries(root.buildings || {})
    .map(([id, b]) => ({ id, ...b }))
    .sort((a, b) => (a.order || 0) - (b.order || 0) || cmpText(a.id, b.id));
  const bld = (id) => (root.buildings || {})[id] || {};
  const bldName = (id) => bld(id).name || 'بدون مبنى';
  const students = () => Object.entries(root.students || {}).map(([id, s]) => ({ id, ...s }));
  const classesOf = (bid) => {
    const set = new Set();
    for (const s of students()) if (!bid || s.b === bid) set.add(s.c || '—');
    return [...set].sort(cmpClass);
  };
  // الرقم السري لصفحة التوزيع — فاضي = بدون قفل
  const adminPin = () => String((root.settings || {}).pin || '').trim();
  // الجهاز مفتوح إذا حفظ نفس الرقم الحالي، فتغيير الرقم يقفل كل الأجهزة تلقائيًا
  const unlocked = () => { const p = adminPin(); return !p || lsGet('km-unlock') === p; };

  const minutes = () => {
    const m = Number((root.settings || {}).minutes);
    return Number.isFinite(m) && m >= 0 ? m : 20;
  };
  const isToday = (t) => new Date(t).toDateString() === new Date().toDateString();

  // حالة الطالب اليوم: none (لم يُنادَ) | called (وصل ولي الأمر) | out (خرج)
  function stateOf(id) {
    const c = (root.calls || {})[id];
    if (!c || typeof c.t !== 'number' || !isToday(c.t)) return { st: 'none' };
    if (typeof c.o === 'number') return { st: 'out', t: c.t, o: c.o };
    const m = minutes();
    if (m > 0 && Date.now() - c.t > m * 60000) return { st: 'out', t: c.t, o: c.t + m * 60000, auto: true };
    return { st: 'called', t: c.t };
  }

  // ---------- رموز الدخول ----------
  const NUMW = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    واحد: 1, اول: 1, اولي: 1, اثنين: 2, ثاني: 2, ثانيه: 2, ثلاث: 3, ثلاثه: 3, ثالث: 3, ثالثه: 3,
    اربع: 4, اربعه: 4, رابع: 4, رابعه: 4, خمس: 5, خمسه: 5, خامس: 5, خامسه: 5, ست: 6, سته: 6, سادس: 6, سادسه: 6,
    سبع: 7, سبعه: 7, سابع: 7, سابعه: 7, ثمان: 8, ثمانيه: 8, ثامن: 8, ثامنه: 8, تسع: 9, تسعه: 9, تاسع: 9, تاسعه: 9,
    عشر: 10, عشره: 10, عاشر: 10, عاشره: 10,
  };
  const gradeWord = (w) => NUMW[w] ?? NUMW[w.replace(/^ال/, '')] ?? w;

  // يرجع { title, sub, ids:Set, b? } أو null
  function resolveCode(raw) {
    const words = String(raw || '').trim().split(/\s+/).map((w) => String(gradeWord(norm(w))));
    const c = words.join('').replace(/[-_.]/g, '');
    if (!c) return null;
    const all = students();
    const pick = (fn) => new Set(all.filter(fn).map((s) => s.id));
    const buildingByCode = (n) => buildings().find((b) => String(b.code || '').replace(/^0+/, '') === String(n));
    let m;

    // رقم فقط ← رقم المبنى، وإذا ما فيه مبنى بهذا الرقم ← الصف
    if ((m = c.match(/^(?:مبني)?0*(\d{1,3})$/))) {
      const b = buildingByCode(m[1]);
      if (b) return { title: b.name, sub: b.desc || '', ids: pick((s) => s.b === b.id), b: b.id };
      const n = Number(m[1]);
      if (n >= 1 && n <= 12) return gradeScope(n, '', false, pick);
    }
    // بنات: B6 / بنات 6 / girls 6
    if ((m = c.match(/^(?:بنات|girls|b)(?:grade|g|صف|الصف)?(\d{1,2})$/)) || (m = c.match(/^(?:grade|g|صف|الصف)?(\d{1,2})بنات$/))) {
      return gradeScope(Number(m[1]), '', true, pick);
    }
    // صف أو شعبة: G5 / grade five / G5A / 5A / صف خامس
    if ((m = c.match(/^(?:grade|gr|g|صف|الصف|جريد)?(\d{1,2})([a-d])?$/))) {
      return gradeScope(Number(m[1]), (m[2] || '').toUpperCase(), false, pick);
    }
    // اسم صف أو اسم معلمة (مثل: رعاية، إلهام)
    const q = norm(raw);
    const classes = [...new Set(all.map((s) => s.c))].filter((cl) => norm(cl).includes(q));
    if (classes.length) {
      const set = new Set(classes);
      return { title: classes.length === 1 ? classes[0] : raw.trim(), sub: classes.length > 1 ? classes.join('، ') : '', ids: pick((s) => set.has(s.c)) };
    }
    const b = buildings().find((x) => norm(x.name) === q || norm(x.name).includes(q));
    if (b) return { title: b.name, sub: b.desc || '', ids: pick((s) => s.b === b.id), b: b.id };
    return null;
  }
  function gradeScope(n, sec, girls, pick) {
    const ids = pick((s) => {
      const i = classInfo(s.c);
      return i.n === n && i.girls === girls && (!sec || i.sec === sec);
    });
    if (!ids.size) return null;
    return { title: `${girls ? 'بنات · ' : ''}Grade ${n}${sec}`, sub: '', ids };
  }

  // ---------- تنبيه صغير ----------
  let toastTimer = null;
  function toast(msg, kind, action) {
    const t = document.getElementById('toast');
    t.replaceChildren(el('span', null, msg));
    if (action) {
      t.append(el('button', {
        class: 'toast-btn', type: 'button',
        onclick: () => { action.fn(); t.className = ''; },
      }, action.label));
    }
    t.className = 'show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, action ? 6000 : 2800);
  }

  async function copy(text, label) {
    try { await navigator.clipboard.writeText(text); toast(`تم نسخ ${label}`, 'ok'); }
    catch { prompt('انسخ الرابط:', text); }
  }

  // ---------- العمليات ----------
  // نأخذ نسخة من الحالة السابقة، لأن الكتابة تعدّل الكائن نفسه
  function undoTo(id) {
    const prev = (root.calls || {})[id];
    const snap = prev && typeof prev === 'object' ? { ...prev } : null;
    return () => (snap ? write('PUT', `calls/${id}`, snap) : write('DELETE', `calls/${id}`));
  }

  // آخر إجراء — يبقى متاحًا للتراجع حتى بعد اختفاء التنبيه
  let lastAct = null;
  function remember(label, fn) { lastAct = { label, fn }; }
  function undoLast() {
    if (!lastAct) return;
    const a = lastAct;
    lastAct = null;
    a.fn();
    toast(`تم التراجع عن ${a.label}`, 'ok');
  }

  function callStudent(s) {
    const fn = undoTo(s.id);
    write('PUT', `calls/${s.id}`, { t: SV });
    if (navigator.vibrate) navigator.vibrate(30);
    remember(`نداء ${s.n}`, fn);
    toast(`تم نداء ${s.n}`, 'ok', { label: 'تراجع', fn: undoLast });
  }
  function markOut(s) {
    const fn = undoTo(s.id);
    write('PATCH', `calls/${s.id}`, { o: SV });
    remember(`خروج ${s.n}`, fn);
    toast(`${s.n} خرج`, '', { label: 'تراجع', fn: undoLast });
  }

  // زر التراجع الظاهر — يختفي إذا ما فيه إجراء
  function undoButton(cls) {
    const b = el('button', { class: cls, type: 'button', hidden: true, onclick: undoLast });
    const upd = () => {
      b.hidden = !lastAct;
      if (lastAct) b.textContent = `↶ تراجع عن ${lastAct.label}`;
    };
    upd();
    subs.add(upd);
    return b;
  }

  // أزرار التمرير لأعلى/أسفل — تفيد على الجوال والقوائم الطويلة
  function scrollPad() {
    const by = (dir) => window.scrollBy({ top: dir * Math.round(window.innerHeight * 0.8), behavior: 'smooth' });
    const up = el('button', { class: 'sp-btn', type: 'button', 'aria-label': 'أعلى', onclick: () => by(-1) }, '▲');
    const down = el('button', { class: 'sp-btn', type: 'button', 'aria-label': 'أسفل', onclick: () => by(1) }, '▼');
    const top = el('button', { class: 'sp-btn sp-top', type: 'button', 'aria-label': 'البداية', onclick: () => window.scrollTo({ top: 0, behavior: 'smooth' }) }, '⤒');
    const pad = el('div', { class: 'scrollpad', hidden: true }, top, up, down);
    const upd = () => {
      const scrollable = document.documentElement.scrollHeight > window.innerHeight + 120;
      pad.hidden = !scrollable;
      if (!scrollable) return;
      const y = window.scrollY;
      top.hidden = y < 200;
      up.disabled = y < 20;
      down.disabled = y + window.innerHeight >= document.documentElement.scrollHeight - 20;
    };
    window.addEventListener('scroll', upd, { passive: true });
    window.addEventListener('resize', upd);
    const iv = setInterval(upd, 1200);
    pad.dispose = () => { window.removeEventListener('scroll', upd); window.removeEventListener('resize', upd); clearInterval(iv); };
    subs.add(upd); // بعد ما تتحمل القائمة
    setTimeout(upd, 0);
    upd();
    return pad;
  }

  // ---------- أجزاء مشتركة ----------
  const STATUS = {
    ok: ['متصل', 'ok'],
    connecting: ['جاري الاتصال…', 'wait'],
    off: ['غير متصل', 'bad'],
    denied: ['الرمز غير صالح', 'bad'],
    local: ['وضع تجريبي', 'local'],
  };
  function statusPill() {
    const d = el('span', { class: 'status' });
    const upd = () => {
      const [t, c] = STATUS[status] || STATUS.off;
      d.className = 'status ' + c;
      d.textContent = t;
    };
    upd();
    subs.add(upd);
    return d;
  }

  function topbar(title, withBack = true) {
    return el('header', { class: 'topbar' },
      withBack ? el('a', { class: 'back', href: link('home'), 'aria-label': 'رجوع للرئيسية' },
        el('span', { class: 'back-i' }, '›'), el('span', { class: 'back-t' }, 'رجوع')) : null,
      el('img', { class: 'topbar-logo', src: 'assets/logo.png', alt: '' }),
      el('div', { class: 'topbar-title' }, el('strong', null, title), el('small', null, CFG.schoolName || '')),
      statusPill());
  }

  function localBanner() {
    if (REMOTE) return '';
    return el('div', { class: 'banner' },
      el('strong', null, 'وضع تجريبي: '),
      DB ? 'افتح رابط المدرسة (فيه الرمز) عشان تتزامن الأجهزة.'
         : 'البيانات على هذا الجهاز فقط. لربط الجوال بالتلفزيونات أضف رابط Firebase في config.js.');
  }

  // ---------- التنقل ----------
  let cleanup = null;
  function route() {
    const next = hashParams();
    if (next.get('k') && next.get('k') !== KEY) { lsSet('km-key', next.get('k')); location.reload(); return; }
    P = next;
    if (cleanup) { cleanup(); cleanup = null; }
    subs.clear();
    app.replaceChildren();
    document.body.className = '';
    window.scrollTo(0, 0);
    const views = { home: viewHome, call: viewCall, screen: viewScreen, manage: viewManage };
    (views[P.get('v') || 'home'] || viewHome)();
  }
  window.addEventListener('hashchange', route);

  function codeForm(big) {
    const input = el('input', {
      class: 'code-input', placeholder: 'رقم المبنى أو الصف (25 / G5)', autocomplete: 'off',
      enterkeyhint: 'go', 'aria-label': 'رمز الدخول', value: '',
    });
    const err = el('p', { class: 'code-err', role: 'alert' });
    const go = (e) => {
      if (e) e.preventDefault();
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      // الرقم السري يفتح التوزيع من نفس الخانة
      const pin = adminPin();
      if (pin && arDigits(v) === pin) {
        lsSet('km-unlock', pin);
        lsSet('km-admin', '1');
        input.value = '';
        location.hash = link('manage');
        return;
      }
      if (ready && !resolveCode(v)) { err.textContent = 'ما لقينا مبنى أو صف بهذا الرمز'; input.select(); return; }
      lsSet('km-last-code', v);
      location.hash = link('screen', { code: v });
    };
    return el('form', { class: 'code-form' + (big ? ' big' : ''), onsubmit: go },
      el('label', null, 'دخول المعلمين والشاشات'),
      el('div', { class: 'code-row' }, input, el('button', { class: 'btn primary', type: 'submit' }, 'دخول')),
      err);
  }

  // ---------- الرئيسية ----------
  function viewHome() {
    document.body.className = 'page-home';
    const body = el('main', { class: 'home' });
    app.append(topbar(CFG.appName || 'نداء الانصراف', false), localBanner(), body);
    const form = codeForm(true);

    function render() {
      if (document.activeElement && form.contains(document.activeElement)) return;
      body.replaceChildren();
      if (DB && !KEY) {
        body.append(el('section', { class: 'card setup' },
          el('h2', null, 'أول مرة؟'),
          el('p', null, 'أنشئ رمزًا خاصًا للمدرسة. بعدها كل رابط تنسخه من صفحة التوزيع يحمل هذا الرمز.'),
          el('button', {
            class: 'btn primary big', type: 'button',
            onclick: () => { const k = newKey(); lsSet('km-key', k); location.hash = '#k=' + k + '&v=manage'; location.reload(); },
          }, 'إنشاء رمز المدرسة')));
        return;
      }
      if (REMOTE && ready && !Object.keys(root.students || {}).length) {
        body.append(el('section', { class: 'card warn' },
          el('p', null, 'قائمة الطلبة فاضية.'),
          el('a', { class: 'btn primary', href: link('manage') }, 'افتح التوزيع وعبّئ القائمة')));
      }
      // هذا الجهاز مثبّت على شاشة معيّنة؟ نفتحها مع مهلة قصيرة للإلغاء
      const t = homeTarget();
      if (t) {
        if (!autoOpened) {
          autoOpened = true;
          let n = 3;
          const num = el('b', null, String(n));
          const card = el('section', { class: 'card warn autogo' },
            el('p', null, `جاري فتح ${t.label} خلال `, num, ' ثوانٍ…'),
            el('button', {
              class: 'btn', type: 'button',
              onclick: () => { clearInterval(iv); card.remove(); render(); },
            }, 'إلغاء — أبي أختار غيرها'));
          const iv = setInterval(() => {
            if (!document.body.contains(card)) { clearInterval(iv); return; }
            n--;
            num.textContent = String(n);
            if (n <= 0) { clearInterval(iv); location.hash = link(t.v, { code: t.code }); }
          }, 1000);
          body.append(card);
        } else {
          body.append(el('section', { class: 'card' },
            el('p', { class: 'hint' }, 'هذا الجهاز مثبّت على:'),
            el('a', { class: 'btn primary big', href: link(t.v, { code: t.code }) }, t.label),
            el('button', {
              class: 'btn small ghost', type: 'button',
              onclick: () => { setHomeTarget(null); toast('تم إلغاء التثبيت', 'ok'); render(); },
            }, 'إلغاء التثبيت')));
        }
      }
      body.append(
        form,
        el('div', { class: 'screens' },
          buildings().map((b) => el('div', { class: 'screen-link' },
            el('a', { class: 'screen-main', href: link('screen', { code: b.code || b.name }) },
              el('strong', null, b.name),
              el('small', null, b.desc || ''),
              el('span', { class: 'code-tag' }, 'الرمز: ', el('b', null, b.code || '—'))),
            el('div', { class: 'b-actions' },
              el('a', { class: 'btn small primary', href: link('call', { code: b.code || b.name }) }, '📣 النداء'),
              el('a', { class: 'btn small', href: link('screen', { code: b.code || b.name }) }, '🖥️ الشاشة')),
            b.map ?el('a', { class: 'map-link', href: b.map, target: '_blank', rel: 'noopener' }, '📍 ', b.addr || 'الموقع') : null))),
        el('a', { class: 'tile tile-call', href: link('call') },
          el('span', { class: 'tile-icon', 'aria-hidden': 'true' }, '📣'),
          el('span', null, el('strong', null, 'النداء — المواقف'), el('small', null, 'للمسؤول عند كل مبنى: اضغط على اسم الطالب فيظهر على شاشة المبنى'))),
        // التوزيع يظهر فقط على جهاز المسؤول (اللي فتح صفحة التوزيع مرة من رابطها المباشر)
        isAdmin() ? el('a', { class: 'tile', href: link('manage') },
          el('span', { class: 'tile-icon', 'aria-hidden': 'true' }, '🗂️'),
          el('span', null, el('strong', null, 'التوزيع والإعدادات'), el('small', null, 'نقل الطلبة بين المباني، الإضافة والحذف، الروابط'))) : '',
      );
    }
    subs.add(render);
    render();
  }

  // ---------- النداء (المواقف) — لكل مبنى نداؤه الخاص ----------
  function viewCall() {
    document.body.className = 'page-call';
    const code = P.get('code') || '';

    // بدون مبنى: اختيار المبنى أولًا
    if (!code) {
      const body = el('main', { class: 'home' });
      app.append(topbar('النداء — اختر المبنى'), localBanner(), body);
      const render = () => {
        const last = lsGet('km-call-code');
        body.replaceChildren(
          el('p', { class: 'hint' }, 'كل مبنى له نداؤه الخاص. اختر المبنى اللي أنت عنده:'),
          el('div', { class: 'pick' }, buildings().map((b) => el('a', {
            class: 'pick-b' + (String(b.code) === last ? ' last' : ''),
            href: link('call', { code: b.code || b.name }),
          }, el('strong', null, b.name), el('small', null, b.desc || '')))));
      };
      subs.add(render);
      render();
      return;
    }

    lsSet('km-call-code', code);
    let q = '';
    let onlyCalled = false;

    const search = el('input', {
      class: 'search', type: 'search', placeholder: 'ابحث باسم الطالب أو العائلة…',
      autocomplete: 'off', enterkeyhint: 'search', 'aria-label': 'بحث',
    });
    const clearBtn = el('button', {
      class: 'search-clear', type: 'button', 'aria-label': 'مسح البحث',
      onclick: () => { search.value = ''; q = ''; render(); search.focus(); },
    }, '×');
    search.addEventListener('input', () => { q = search.value; render(); });

    const bar = topbar('النداء');
    const titleEl = bar.querySelector('.topbar-title strong');
    const jump = el('nav', { class: 'tabs', 'aria-label': 'الصفوف' });
    const summary = el('div', { class: 'summary' });
    const list = el('main', { class: 'call-list' });
    const undoRow = el('div', { class: 'undo-row' }, undoButton('btn undo-btn'),
      el('a', { class: 'btn small ghost', href: link('call') }, 'تغيير المبنى'));
    const pad = scrollPad();
    app.append(
      bar,
      localBanner(),
      el('div', { class: 'controls' }, el('div', { class: 'search-wrap' }, search, clearBtn), jump, summary, undoRow),
      list, pad);

    function render() {
      list.replaceChildren();
      if (!ready) { list.append(el('p', { class: 'empty-note' }, 'جاري التحميل…')); return; }
      const scope = resolveCode(code);
      if (!scope) {
        list.append(el('p', { class: 'empty-note' }, 'ما لقينا المبنى. ', el('a', { href: link('call') }, 'اختر المبنى')));
        return;
      }
      titleEl.textContent = `النداء — ${scope.title}`;
      document.title = `نداء ${scope.title}`;

      const all = [...scope.ids].map((id) => ({ id, ...root.students[id], ...stateOf(id) }));
      const nCalled = all.filter((s) => s.st === 'called').length;
      const nOut = all.filter((s) => s.st === 'out').length;
      summary.replaceChildren(
        el('span', { class: 'sum-stats' },
          el('span', { class: 'dot called' }), 'ينتظر ', el('b', null, String(nCalled)),
          el('span', { class: 'dot out' }), 'خرج ', el('b', null, String(nOut)),
          el('span', { class: 'dot none' }), 'الباقي ', el('b', null, String(all.length - nCalled - nOut))),
        el('button', {
          class: 'chip' + (onlyCalled ? ' on' : ''), type: 'button', 'aria-pressed': String(onlyCalled),
          onclick: () => { onlyCalled = !onlyCalled; render(); },
        }, onlyCalled ? 'عرض الكل' : 'المنتظرين فقط'));

      const nq = norm(q);
      const rows = all.filter((s) => (!onlyCalled || s.st === 'called')
        && (!nq || norm(s.n).includes(nq) || norm(s.c).includes(nq)));

      // أزرار الانتقال السريع للصفوف
      const classes = [...new Set(rows.map((s) => s.c))].sort(cmpClass);
      jump.replaceChildren(...(onlyCalled ? [] : classes.map((c) => el('button', {
        class: 'tab', type: 'button',
        onclick: () => {
          const h = list.querySelector(`[data-class="${CSS.escape(c)}"]`);
          if (h) window.scrollTo({ top: h.getBoundingClientRect().top + window.scrollY - document.querySelector('.controls').getBoundingClientRect().bottom - 8, behavior: 'smooth' });
        },
      }, c))));

      if (!rows.length) {
        list.append(el('p', { class: 'empty-note' }, onlyCalled ? 'ما فيه أحد ينتظر الحين.' : 'ما فيه نتائج.'));
        return;
      }

      const tile = (s) => el('div', { class: 'nt ' + s.st },
        el('button', { class: 'nt-main', type: 'button', onclick: () => callStudent(s) },
          el('span', { class: 'nt-name' }, s.n),
          el('span', { class: 'nt-meta' },
            s.st === 'called' ? `⏳ ينتظر · ${ago(s.t)}`
              : s.st === 'out' ? `✓ خرج ${timeFmt.format(s.o)}`
              : (onlyCalled || nq ? s.c : ''))),
        s.st === 'called'
          ? el('button', { class: 'nt-out', type: 'button', 'aria-label': `${s.n} خرج`, onclick: () => markOut(s) }, 'خرج ✓')
          : null);

      if (onlyCalled) {
        list.append(el('div', { class: 'ngrid' }, rows.sort((a, b) => b.t - a.t).map(tile)));
        return;
      }
      for (const c of classes) {
        const items = rows.filter((s) => s.c === c).sort((a, b) => cmpText(a.n, b.n));
        const outN = items.filter((s) => s.st === 'out').length;
        list.append(
          el('h4', { class: 'group', 'data-class': c }, c, el('small', null, `${outN}/${items.length} خرج`)),
          el('div', { class: 'ngrid' }, items.map(tile)));
      }
    }

    subs.add(render);
    render();
    const iv = setInterval(render, 30000);
    cleanup = () => { clearInterval(iv); pad.dispose(); };
  }

  // ---------- صفحة المبنى / الصف (التلفزيون أو جوال المعلمة) ----------
  let actx = null;
  function chime() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t0 = actx.currentTime;
      [[784, 0], [1047, 0.2]].forEach(([f, d]) => {
        const o = actx.createOscillator();
        const g = actx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + d);
        g.gain.exponentialRampToValueAtTime(0.4, t0 + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.7);
        o.connect(g).connect(actx.destination);
        o.start(t0 + d);
        o.stop(t0 + d + 0.75);
      });
    } catch { /* الصوت غير متاح */ }
  }

  function viewScreen() {
    document.body.className = 'page-screen';
    const code = P.get('code') || '';

    const title = el('h1');
    const sub = el('small');
    const clock = el('div', { class: 'clock' });
    const dateEl = el('div', { class: 'date' });
    const stats = el('div', { class: 'stats' });
    const cardsWrap = el('div', { class: 'grid' });
    const calledEmpty = el('div', { class: 'called-empty' }, el('p', null, 'لا يوجد أحد بانتظار الخروج'));
    const roster = el('div', { class: 'roster' });
    const body = el('main', { class: 'scr-body' },
      el('section', { class: 'panel called-panel' },
        el('h2', null, el('span', { class: 'dot called' }), 'وصل ولي الأمر — بانتظار الخروج'),
        cardsWrap, calledEmpty),
      el('section', { class: 'panel roster-panel' },
        el('h2', null, 'كل الطلبة',
          el('span', { class: 'legend' },
            el('span', null, el('span', { class: 'dot none' }), 'لم يُنادَ'),
            el('span', null, el('span', { class: 'dot called' }), 'ينتظر'),
            el('span', null, el('span', { class: 'dot out' }), 'خرج'))),
        roster));
    const notFound = el('div', { class: 'scr-msg', hidden: true },
      el('img', { src: 'assets/logo.png', alt: '' }),
      el('p', null, 'ما لقينا مبنى أو صف بالرمز: ', el('b', null, code)),
      el('a', { class: 'btn primary big', href: link('home') }, 'رجوع وإدخال رمز ثاني'));

    let wakeLock = null;
    const startBtn = el('button', {
      class: 'start', type: 'button',
      onclick: async () => {
        chime();
        try { await document.documentElement.requestFullscreen(); } catch { /* ignore */ }
        try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
        startBtn.remove();
      },
    }, '🔊 اضغط لتشغيل الصوت وملء الشاشة');

    // الرجوع: نخرج من ملء الشاشة أولًا وإلا ما يبين زر الرجوع في المتصفح
    async function goBack() {
      try { if (document.fullscreenElement) await document.exitFullscreen(); } catch { /* ignore */ }
      try { if (wakeLock) { await wakeLock.release(); wakeLock = null; } } catch { /* ignore */ }
      location.hash = link('home');
    }
    const backBtn = el('button', { class: 'scr-back', type: 'button', 'aria-label': 'رجوع للرئيسية', onclick: goBack },
      el('span', { class: 'back-i' }, '›'), el('span', null, 'رجوع'));

    // تثبيت هذه الشاشة على الجهاز: بعدها الرابط الواحد يفتحها مباشرة
    const pinBtn = el('button', { class: 'scr-pin', type: 'button' });
    const pinned = () => { const t = homeTarget(); return !!t && t.v === 'screen' && t.code === code; };
    const updPin = () => {
      const on = pinned();
      pinBtn.textContent = on ? '📌 شاشة هذا الجهاز' : '📌 ثبّتها على هذا الجهاز';
      pinBtn.classList.toggle('on', on);
      pinBtn.title = on
        ? 'هذا الجهاز يفتح هذه الشاشة مباشرة — اضغط للإلغاء'
        : 'خلّي الرابط الرئيسي يفتح هذه الشاشة مباشرة على هذا الجهاز';
    };
    pinBtn.addEventListener('click', () => {
      if (pinned()) { setHomeTarget(null); toast('تم إلغاء التثبيت', 'ok'); }
      else {
        setHomeTarget({ v: 'screen', code, label: `شاشة ${(title.textContent || '').trim()}`.trim() });
        toast('تم — الرابط الرئيسي يفتح هذه الشاشة على هذا الجهاز', 'ok');
      }
      updPin();
    });
    const onKey = (e) => {
      if (e.key === 'Escape' && !document.fullscreenElement) goBack();
      else if (e.key === 'Backspace' && !/INPUT|TEXTAREA/.test((e.target || {}).tagName || '')) { e.preventDefault(); goBack(); }
    };
    document.addEventListener('keydown', onKey);

    const undoBtn = undoButton('scr-undo');
    const pad = scrollPad();

    app.append(
      el('header', { class: 'scr-head' },
        el('a', { class: 'scr-home', href: link('home'), title: 'تغيير الرمز' },
          el('img', { class: 'scr-logo', src: 'assets/logo.png', alt: 'الرئيسية' })),
        backBtn,
        pinBtn,
        el('div', { class: 'scr-title' }, title, sub),
        undoBtn,
        stats,
        el('div', { class: 'scr-time' }, clock, dateEl)),
      body, notFound, startBtn, pad);

    const cards = new Map();
    let first = true;

    function tick() {
      const now = new Date();
      clock.textContent = timeFmt.format(now);
      dateEl.textContent = dateFmt.format(now);
    }

    function render() {
      if (!ready) { title.textContent = 'جاري التحميل…'; return; }
      const scope = code ? resolveCode(code) : { title: 'كل المباني', sub: '', ids: new Set(students().map((s) => s.id)) };
      notFound.hidden = !!scope;
      body.hidden = !scope;
      stats.hidden = !scope;
      pinBtn.hidden = !scope;
      if (!scope) { title.textContent = 'رمز غير معروف'; sub.textContent = ''; return; }

      title.textContent = scope.title;
      updPin();
      sub.textContent = [scope.sub, CFG.schoolName].filter(Boolean).join(' · ');
      document.title = `${scope.title} · نداء الانصراف`;

      const list = [...scope.ids].map((id) => ({ id, ...root.students[id], ...stateOf(id) }));
      const called = list.filter((s) => s.st === 'called').sort((a, b) => b.t - a.t);
      const nOut = list.filter((s) => s.st === 'out').length;
      const multiB = new Set(list.map((s) => s.b)).size > 1;

      stats.replaceChildren(
        el('div', { class: 'stat called' }, el('b', null, String(called.length)), el('span', null, 'ينتظر')),
        el('div', { class: 'stat out' }, el('b', null, String(nOut)), el('span', null, 'خرج')),
        el('div', { class: 'stat none' }, el('b', null, String(list.length - called.length - nOut)), el('span', null, 'لم يُنادَ')));

      // البطاقات الكبيرة للمنتظرين (نحافظ عليها حتى لا تتكرر الحركة)
      const seen = new Set();
      let fresh = false;
      called.forEach((s, i) => {
        seen.add(s.id);
        let card = cards.get(s.id);
        if (!card || card.dataset.t !== String(s.t)) {
          if (card) card.remove();
          card = el('button', { class: 'card' + (first ? '' : ' fresh'), type: 'button', title: 'اضغط عند خروج الطالب' },
            el('span', { class: 'card-name' }),
            el('span', { class: 'card-meta' }, el('span', { class: 'badge' }), el('span', { class: 'ago' })));
          card.dataset.t = String(s.t);
          card.addEventListener('click', () => markOut(root.students[s.id] ? { id: s.id, ...root.students[s.id] } : s));
          cards.set(s.id, card);
          cardsWrap.append(card);
          if (!first) fresh = true;
        }
        card.querySelector('.card-name').textContent = s.n;
        card.querySelector('.badge').textContent = multiB ? `${s.c} · ${bldName(s.b)}` : s.c;
        card.querySelector('.ago').textContent = ago(s.t);
        card.style.order = String(i);
        card.classList.toggle('latest', i === 0 && Date.now() - s.t < 90000);
      });
      for (const [id, card] of cards) if (!seen.has(id)) { card.remove(); cards.delete(id); }
      const n = called.length;
      cardsWrap.style.setProperty('--cols', n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4);
      cardsWrap.hidden = n === 0;
      calledEmpty.hidden = n > 0;

      // كل الطلبة مجمّعين حسب الصف
      const groups = new Map();
      for (const s of list) {
        const g = multiB && scope.b == null ? `${s.c}` : s.c;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(s);
      }
      const rank = { called: 0, none: 1, out: 2 };
      roster.replaceChildren(...[...groups.keys()].sort(cmpClass).map((g) => {
        const items = groups.get(g).sort((a, b) => rank[a.st] - rank[b.st] || cmpText(a.n, b.n));
        const outN = items.filter((s) => s.st === 'out').length;
        return el('div', { class: 'rgroup' },
          el('h3', null, g, el('small', null, `${outN}/${items.length} خرج`)),
          el('div', { class: 'pills' }, items.map((s) => el('span', {
            class: 'pill ' + s.st,
            title: s.st === 'out' ? `خرج ${timeFmt.format(s.o)}` : s.st === 'called' ? 'ينتظر الخروج' : '',
            onclick: s.st === 'called' ? () => markOut({ id: s.id, ...root.students[s.id] }) : null,
          }, s.st === 'out' ? '✓ ' : '', s.n))));
      }));

      if (fresh) chime();
      first = false;
    }

    const onVis = async () => {
      if (document.visibilityState === 'visible' && wakeLock !== null) {
        try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
      }
    };
    document.addEventListener('visibilitychange', onVis);

    tick();
    subs.add(render);
    render();
    const t1 = setInterval(tick, 1000);
    const t2 = setInterval(render, 15000);
    cleanup = () => {
      clearInterval(t1);
      clearInterval(t2);
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('keydown', onKey);
      pad.dispose();
    };
  }

  // ---------- التوزيع والإعدادات ----------
  function viewManage() {
    document.body.className = 'page-manage';
    const body = el('main', { class: 'manage' });
    const pad = scrollPad();
    app.append(topbar('التوزيع والإعدادات'), localBanner(), body, pad);

    let fb = lsGet('km-mb') || 'all';
    let fq = '';
    let pending = false;
    let reviewing = false; // مراجعة الأسماء مفتوحة — ما نعيد الرسم حتى ما تضيع
    const openBoxes = new Set(); // الأقسام المفتوحة، حتى ما تنسكر عند إعادة الرسم
    const keepOpen = (id) => ({
      open: openBoxes.has(id) ? true : null,
      ontoggle: (e) => (e.target.open ? openBoxes.add(id) : openBoxes.delete(id)),
    });

    const bldSelect = (value, onchange, withAll) => {
      const s = el('select', { onchange: (e) => onchange(e.target.value) },
        withAll ? el('option', { value: 'all' }, 'كل المباني') : null,
        buildings().map((b) => el('option', { value: b.id }, b.name)));
      s.value = value || (withAll ? 'all' : (buildings()[0] || {}).id || '');
      return s;
    };

    function linksCard() {
      const row = (label, url) => el('div', { class: 'link-row' },
        el('a', { href: url, target: '_blank', rel: 'noopener' }, label),
        el('button', { class: 'btn small', type: 'button', onclick: () => copy(url, label) }, 'نسخ'));
      const grades = [...new Set(students().map((s) => classInfo(s.c)).filter((i) => i.n)
        .map((i) => (i.girls ? `B${i.n}` : `G${i.n}`)))].sort(cmpClass);
      return el('section', { class: 'card' },
        el('h2', null, 'الروابط'),
        el('p', { class: 'hint' }, REMOTE
          ? 'كل رابط فيه رمز المدرسة. أرسل رابط الصفحة الرئيسية للمعلمات، وكل وحدة تكتب رمز مبناها أو صفها.'
          : 'الروابط تشتغل الحين على هذا الجهاز فقط (وضع تجريبي).'),
        el('p', { class: 'hint' }, adminPin()
          ? '🔒 رابط التوزيع محمي بالرقم السري. وتقدر بدله تكتب الرقم في خانة الدخول بالصفحة الرئيسية.'
          : '⚠️ رابط التوزيع خاصّ بك — لا ترسله لأحد. زرّه مخفي عن الصفحة الرئيسية، لكن بدون رقم سري أي أحد عنده الرابط يقدر يفتحه.'),
        row('🏠 الصفحة الرئيسية (للمعلمات)', absLink('home')),
        row('🗂️ التوزيع والإعدادات (خاص بك)', absLink('manage')),
        buildings().map((b) => [
          row(`📣 نداء ${b.name} (المواقف)`, absLink('call', { code: b.code || b.name })),
          row(`🖥️ شاشة ${b.name} — الرمز ${b.code || '—'}`, absLink('screen', { code: b.code || b.name })),
        ]),
        el('details', keepOpen('grades'),
          el('summary', null, 'روابط الصفوف (رمز كل صف)'),
          el('p', { class: 'hint' }, 'البنين: G ورقم الصف (G5). البنات: B ورقم الصف (B6). الشعبة: G5A.'),
          grades.map((g) => row(`🖥️ ${g}`, absLink('screen', { code: g })))));
    }

    function buildingsCard() {
      const blds = buildings();
      return el('section', { class: 'card' },
        el('h2', null, 'المباني ورموزها'),
        el('div', { class: 'bld-head' }, el('span', null, 'الاسم'), el('span', null, 'الرمز'), el('span', null, 'الوصف'), el('span')),
        blds.map((b) => {
          const n = students().filter((s) => s.b === b.id).length;
          return el('div', { class: 'bld-item' }, el('div', { class: 'bld-row' },
            el('input', {
              value: b.name || '', 'aria-label': 'اسم المبنى',
              onchange: (e) => { const v = e.target.value.trim(); if (v) write('PATCH', `buildings/${b.id}`, { name: v }); },
            }),
            el('input', {
              value: b.code || '', 'aria-label': 'رمز الدخول', class: 'code-field', dir: 'ltr',
              onchange: (e) => {
                const v = arDigits(e.target.value).trim();
                if (blds.some((x) => x.id !== b.id && String(x.code) === v)) { toast('هذا الرمز مستخدم لمبنى ثاني', 'err'); e.target.value = b.code || ''; return; }
                write('PATCH', `buildings/${b.id}`, { code: v });
              },
            }),
            el('input', {
              value: b.desc || '', 'aria-label': 'الوصف', placeholder: `${n} طالب`,
              onchange: (e) => write('PATCH', `buildings/${b.id}`, { desc: e.target.value.trim() }),
            }),
            el('button', {
              class: 'btn small ghost', type: 'button', disabled: n > 0 ? true : null,
              title: n > 0 ? `فيه ${n} طالب — انقلهم أولًا` : 'حذف',
              onclick: () => { if (confirm(`حذف ${b.name}؟`)) write('DELETE', `buildings/${b.id}`); },
            }, 'حذف')),
          // العنوان ورابط الخريطة — يظهران للمعلمات في الصفحة الرئيسية
          el('details', { class: 'bld-extra', ...keepOpen('loc' + b.id) },
            el('summary', null, b.map ? '📍 الموقع — مضبوط' : '📍 أضف موقع المبنى على الخريطة'),
            el('div', { class: 'bld-loc' },
              el('input', {
                value: b.addr || '', placeholder: 'العنوان (مثل: قطعة 3، شارع 5)', 'aria-label': `عنوان ${b.name}`,
                onchange: (e) => write('PATCH', `buildings/${b.id}`, { addr: e.target.value.trim() }),
              }),
              el('input', {
                value: b.map || '', placeholder: 'الصق رابط خرائط قوقل', dir: 'ltr', type: 'url',
                'aria-label': `رابط خريطة ${b.name}`, inputmode: 'url',
                onchange: (e) => {
                  const v = e.target.value.trim();
                  if (v && !/^https?:\/\//i.test(v)) { toast('الرابط لازم يبدأ بـ https', 'err'); return; }
                  write('PATCH', `buildings/${b.id}`, { map: v });
                  toast(v ? `تم حفظ موقع ${b.name}` : `تم مسح موقع ${b.name}`, 'ok');
                },
              }),
              b.map ? el('a', { class: 'btn small', href: b.map, target: '_blank', rel: 'noopener' }, 'جرّب الرابط') : null)));
        }),
        el('button', {
          class: 'btn', type: 'button',
          onclick: () => {
            let i = blds.length + 1;
            while ((root.buildings || {})['b' + i]) i++;
            write('PUT', `buildings/b${i}`, { name: 'مبنى جديد', code: '', desc: '', order: i });
          },
        }, '+ إضافة مبنى'));
    }

    function settingsCard() {
      return el('section', { class: 'card' },
        el('h2', null, 'الخروج التلقائي'),
        el('div', { class: 'inline wrap' },
          el('span', null, 'إذا ما أحد ضغط "خرج"، يُعتبر الطالب خارج بعد'),
          el('input', {
            type: 'number', min: '0', max: '180', value: String(minutes()), class: 'num', 'aria-label': 'الدقائق',
            onchange: (e) => write('PATCH', 'settings', { minutes: Math.max(0, Number(e.target.value) || 0) }),
          }),
          el('span', null, 'دقيقة'),
          el('span', { class: 'muted' }, '(0 = أبدًا)')));
    }

    function pinCard() {
      const cur = adminPin();
      const inp = el('input', {
        value: cur, inputmode: 'numeric', dir: 'ltr', class: 'num', 'aria-label': 'الرقم السري',
        placeholder: 'بدون رقم', autocomplete: 'off',
      });
      const save = () => {
        const v = arDigits(inp.value).replace(/\s/g, '');
        if (v && !/^\d{4,8}$/.test(v)) { toast('الرقم لازم يكون من 4 إلى 8 أرقام', 'err'); inp.select(); return; }
        if (v === cur) { toast('ما فيه تغيير'); return; }
        if (!v && !confirm('إلغاء الرقم السري؟ صفحة التوزيع تصير مفتوحة لأي أحد عنده الرابط.')) { inp.value = cur; return; }
        write('PATCH', 'settings', { pin: v });
        lsSet('km-unlock', v || null); // نبقي هذا الجهاز مفتوحًا
        toast(v ? 'تم حفظ الرقم السري' : 'تم إلغاء الرقم السري', 'ok');
      };
      return el('section', { class: 'card' },
        el('h2', null, '🔒 الرقم السري لصفحة التوزيع'),
        el('p', { class: 'hint' }, cur
          ? 'اكتبه في خانة الدخول بالصفحة الرئيسية وتنفتح لك صفحة التوزيع من أي جهاز.'
          : 'بدون رقم سري، أي أحد عنده الرابط الرئيسي يقدر يفتح صفحة التوزيع. حط رقمًا من 4 إلى 8 أرقام.'),
        el('div', { class: 'inline wrap' },
          inp,
          el('button', { class: 'btn primary', type: 'button', onclick: save }, 'حفظ'),
          cur ? el('button', {
            class: 'btn small ghost danger', type: 'button',
            onclick: () => { inp.value = ''; save(); },
          }, 'إلغاء الرقم') : null),
        cur ? el('p', { class: 'hint' }, '⚠️ اكتبه عندك في مكان آمن — إذا نسيته ما فيه طريقة تسترجعه إلا من قاعدة البيانات مباشرة.') : null,
        el('p', { class: 'hint' }, 'تغيير الرقم يقفل كل الأجهزة الثانية تلقائيًا.'));
    }

    function moveClassCard() {
      const cSel = el('select', { 'aria-label': 'الصف' }, classesOf(null).map((c) => el('option', { value: c }, c)));
      const bSel = bldSelect(null, () => {}, false);
      return el('section', { class: 'card' },
        el('h2', null, 'نقل صف كامل'),
        el('p', { class: 'hint' }, 'مثلًا اليوم G5A في مبنى 25، وباكر في مبنى 10.'),
        el('div', { class: 'inline wrap' },
          cSel, el('span', null, 'إلى'), bSel,
          el('button', {
            class: 'btn primary', type: 'button',
            onclick: () => {
              const c = cSel.value;
              const b = bSel.value;
              const patch = {};
              for (const s of students()) if (s.c === c && s.b !== b) patch[`${s.id}/b`] = b;
              const n = Object.keys(patch).length;
              if (!n) { toast('الصف أصلًا في هذا المبنى'); return; }
              write('PATCH', 'students', patch);
              toast(`تم نقل ${n} من ${c} إلى ${bldName(b)}`, 'ok');
            },
          }, 'نقل')));
    }

    function studentsCard() {
      const list = students()
        .filter((s) => fb === 'all' || s.b === fb)
        .sort((a, b) => cmpClass(a.c, b.c) || cmpText(a.n, b.n));
      const applyFilter = () => {
        const q = norm(fq);
        body.querySelectorAll('.mrow').forEach((r) => { r.hidden = !!q && !r.dataset.q.includes(q); });
      };
      const searchIn = el('input', {
        type: 'search', placeholder: 'بحث…', value: fq, 'aria-label': 'بحث في الطلبة',
        oninput: (e) => { fq = e.target.value; applyFilter(); },
      });

      // إضافة طالب
      const nName = el('input', { placeholder: 'اسم الطالب', 'aria-label': 'اسم الطالب الجديد' });
      const nClass = el('input', { placeholder: 'الصف (مثل G5A)', list: 'classlist', 'aria-label': 'الصف' });
      const nB = bldSelect(fb === 'all' ? null : fb, () => {}, false);
      const add = () => {
        const n = nName.value.trim();
        if (!n) { nName.focus(); return; }
        const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        write('PUT', `students/${id}`, { n, c: nClass.value.trim() || '—', b: nB.value });
        toast(`تمت إضافة ${n}`, 'ok');
        nName.value = '';
        nName.focus();
      };
      nName.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

      const card = el('section', { class: 'card' },
        el('h2', null, 'الطلبة ', el('span', { class: 'muted' }, `(${list.length})`)),
        el('datalist', { id: 'classlist' }, classesOf(null).map((c) => el('option', { value: c }))),
        el('div', { class: 'add-row' }, nName, nClass, nB, el('button', { class: 'btn primary', type: 'button', onclick: add }, 'إضافة')),
        el('div', { class: 'inline wrap filters' },
          bldSelect(fb, (v) => { fb = v; lsSet('km-mb', v); render(); }, true), searchIn),
        el('div', { class: 'mlist' },
          list.map((s) => el('div', { class: 'mrow', 'data-q': norm(s.n) + '|' + norm(s.c) },
            el('input', {
              class: 'm-name', value: s.n, 'aria-label': 'الاسم',
              onchange: (e) => { const v = e.target.value.trim(); if (v) write('PATCH', `students/${s.id}`, { n: v }); },
            }),
            el('input', {
              class: 'm-class', value: s.c || '', list: 'classlist', 'aria-label': 'الصف', dir: 'auto',
              onchange: (e) => write('PATCH', `students/${s.id}`, { c: e.target.value.trim() || '—' }),
            }),
            bldSelect(s.b, (v) => write('PATCH', `students/${s.id}`, { b: v }), false),
            el('button', {
              class: 'btn small ghost danger', type: 'button', 'aria-label': `حذف ${s.n}`,
              onclick: () => { if (confirm(`حذف ${s.n} من القائمة؟`)) { write('DELETE', `students/${s.id}`); write('DELETE', `calls/${s.id}`); } },
            }, 'حذف')))));
      setTimeout(applyFilter, 0);
      return card;
    }

    function bulkCard() {
      const ta = el('textarea', { rows: '5', placeholder: 'كل سطر اسم طالب\nأو: الاسم، الصف' });
      const cls = el('input', { placeholder: 'الصف الافتراضي', list: 'classlist' });
      const b = bldSelect(null, () => {}, false);
      return el('section', { class: 'card' },
        el('h2', null, 'إضافة مجموعة أسماء مرة وحدة'),
        ta,
        el('div', { class: 'inline wrap' }, cls, b,
          el('button', {
            class: 'btn primary', type: 'button',
            onclick: () => {
              const patch = {};
              let i = 0;
              for (const line of ta.value.split('\n')) {
                const [n, c] = line.split(/[،,\t]/).map((x) => (x || '').replace(/^[\s*\-•\d.)٠-٩]+/, '').trim());
                if (!n) continue;
                patch['s' + Date.now().toString(36) + (i++).toString(36) + Math.random().toString(36).slice(2, 4)] = { n, c: c || cls.value.trim() || '—', b: b.value };
              }
              if (!i) { toast('ما فيه أسماء'); return; }
              write('PATCH', 'students', patch);
              ta.value = '';
              toast(`تمت إضافة ${i} اسم`, 'ok');
            },
          }, 'إضافة')));
    }

    // لصق الأسماء الكاملة (ثلاثية/رباعية) وتحديث أسماء الطلبة الموجودين بدل إضافتهم من جديد
    function renameCard() {
      const ta = el('textarea', {
        rows: '6', dir: 'auto',
        placeholder: 'الصق الأسماء الكاملة، كل سطر اسم\nمثال: عبدالله محمد فهد الصالح\nأو مع الصف: عبدالله محمد الصالح، G5A',
      });
      const scope = bldSelect(fb === 'all' ? null : fb, () => {}, true);
      const out = el('div');
      const card = el('section', { class: 'card' },
        el('h2', null, 'تحديث الأسماء الكاملة'),
        el('p', { class: 'hint' }, 'يطابق كل اسم مع الطالب الموجود ويحدّث اسمه فقط — ما يضيف أسماء مكررة. راجع المطابقة قبل الحفظ.'),
        ta,
        el('div', { class: 'inline wrap', style: 'margin-top:8px' },
          el('span', null, 'ابحث في'), scope,
          el('button', { class: 'btn primary', type: 'button', onclick: () => preview() }, 'طابِق وراجِع')),
        out);

      // قائمة اختيار الطالب — تُعبّأ عند فتحها فقط حتى ما تثقل الجوال
      function targetSelect(chosenId, pool, byId) {
        const label = (st) => `${st.n} · ${st.c || '—'}`;
        const cur = byId[chosenId];
        const s = el('select', { class: 'rn-target', 'aria-label': 'الطالب المقابل' },
          el('option', { value: chosenId || '' }, cur ? label(cur) : '— تجاهل —'));
        let filled = false;
        const fill = () => {
          if (filled) return;
          filled = true;
          const v = s.value;
          s.replaceChildren(el('option', { value: '' }, '— تجاهل —'), pool.map((st) => el('option', { value: st.id }, label(st))));
          s.value = v;
        };
        s.addEventListener('focus', fill);
        s.addEventListener('pointerdown', fill);
        return s;
      }

      function preview() {
        const bid = scope.value;
        const pool = students()
          .filter((s) => bid === 'all' || s.b === bid)
          .sort((a, b) => cmpClass(a.c, b.c) || cmpText(a.n, b.n));
        const byId = Object.fromEntries(pool.map((s) => [s.id, s]));

        const lines = [];
        for (const raw of ta.value.split('\n')) {
          const [n, c] = raw.split(/[،,\t]/).map((x) => (x || '').replace(/^[\s*\-•\d.)٠-٩]+/, '').trim());
          if (n) lines.push({ name: n, cls: (c || '').trim(), w: nameWords(n) });
        }
        if (!lines.length) { out.replaceChildren(el('p', { class: 'hint' }, 'ما فيه أسماء في المربع.')); return; }
        if (!pool.length) { out.replaceChildren(el('p', { class: 'hint' }, 'ما فيه طلبة في هذا النطاق.')); return; }
        reviewing = true;

        // نجمع كل الاحتمالات ونوزّعها من الأقوى للأضعف حتى ما يتكرر طالب
        const pairs = [];
        lines.forEach((ln, li) => {
          pool.forEach((st) => {
            const sc = nameScore(nameWords(st.n), ln.w);
            if (sc >= 60) pairs.push({ li, id: st.id, sc });
          });
        });
        pairs.sort((a, b) => b.sc - a.sc);
        const takenLine = new Set();
        const takenStu = new Set();
        for (const p of pairs) {
          if (takenLine.has(p.li) || takenStu.has(p.id)) continue;
          takenLine.add(p.li);
          takenStu.add(p.id);
          lines[p.li].id = p.id;
          lines[p.li].sc = p.sc;
        }

        const rows = lines.map((ln) => {
          const sel = targetSelect(ln.id || '', pool, byId);
          const cls = ln.id ? (ln.sc >= 85 ? '' : ' weak') : ' none';
          return { ln, sel, node: el('div', { class: 'rn-row' + cls }, el('span', { class: 'rn-new' }, ln.name), sel) };
        });
        const matched = lines.filter((l) => l.id).length;
        const missed = pool.filter((s) => !takenStu.has(s.id));

        out.replaceChildren(
          el('div', { class: 'rn-sum' },
            el('span', null, `تطابق ${matched} من ${lines.length}`),
            lines.length - matched ? el('span', { class: 'bad' }, `${lines.length - matched} بدون مقابل`) : null,
            missed.length ? el('span', { class: 'muted' }, `${missed.length} طالب ما وصلهم تحديث`) : null),
          el('div', { class: 'rn-out' }, rows.map((r) => r.node)),
          el('button', {
            class: 'btn primary big', type: 'button', style: 'margin-top:10px',
            onclick: () => {
              const patch = {};
              const used = new Set();
              let dup = 0;
              let n = 0;
              for (const r of rows) {
                const id = r.sel.value;
                if (!id || !byId[id]) continue;
                if (used.has(id)) { dup++; continue; }
                used.add(id);
                if (byId[id].n !== r.ln.name) { patch[`${id}/n`] = r.ln.name; n++; }
                if (r.ln.cls && byId[id].c !== r.ln.cls) patch[`${id}/c`] = r.ln.cls;
              }
              if (dup) { toast(`${dup} أسماء مربوطة بنفس الطالب — صحّحها أولًا`, 'err'); return; }
              if (!Object.keys(patch).length) { toast('ما فيه تغيير'); return; }
              write('PATCH', 'students', patch);
              ta.value = '';
              toast(`تم تحديث ${n} اسم`, 'ok');
              reviewing = false;
              render();
            },
          }, 'احفظ التحديث'),
          el('button', {
            class: 'btn ghost', type: 'button', style: 'margin-top:10px',
            onclick: () => { reviewing = false; out.replaceChildren(); },
          }, 'إلغاء'),
          missed.length ? el('details', { style: 'margin-top:10px' },
            el('summary', null, `طلبة ما وصلهم تحديث (${missed.length})`),
            el('p', { class: 'hint' }, missed.map((s) => `${s.n} (${s.c || '—'})`).join('، '))) : null);
      }

      return card;
    }

    function toolsCard() {
      return el('section', { class: 'card' },
        el('h2', null, 'أدوات'),
        el('div', { class: 'inline wrap' },
          el('button', {
            class: 'btn', type: 'button',
            onclick: () => { if (confirm('تصفير اليوم؟ (كل النداءات وحالات الخروج)')) write('DELETE', 'calls'); },
          }, 'تصفير اليوم'),
          window.SEED ? el('button', {
            class: 'btn ghost danger', type: 'button',
            onclick: () => {
              if (!confirm('هذا يستبدل كل المباني والطلبة بالقائمة الأولية. متأكد؟')) return;
              write('PUT', '', JSON.parse(JSON.stringify(window.SEED)));
              toast('تمت تعبئة القائمة الأولية', 'ok');
            },
          }, 'استرجاع القائمة الأولية') : null,
          el('button', {
            class: 'btn', type: 'button',
            title: 'يخفي زر التوزيع من الصفحة الرئيسية على هذا الجهاز',
            onclick: () => {
              if (!confirm('إخفاء زر التوزيع من الصفحة الرئيسية على هذا الجهاز؟ تقدر ترجع له دائمًا برابط التوزيع المباشر.')) return;
              lsSet('km-admin', null);
              toast('تم الإخفاء من هذا الجهاز', 'ok');
              location.hash = link('home');
            },
          }, 'أخفِ زر التوزيع من هذا الجهاز')),
        el('p', { class: 'hint' }, 'النداءات تتصفّر تلقائيًا كل يوم جديد.'),
        REMOTE ? el('p', { class: 'hint' }, 'رمز المدرسة: ', el('code', null, KEY)) : null);
    }

    // شاشة القفل — تظهر إذا فيه رقم سري وهذا الجهاز ما فتحه
    let tries = 0;
    let lockedUntil = 0;
    function lockCard() {
      const inp = el('input', {
        type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'code-input',
        placeholder: '••••', 'aria-label': 'الرقم السري',
      });
      const err = el('p', { class: 'code-err', role: 'alert' });
      const go = (e) => {
        if (e) e.preventDefault();
        if (Date.now() < lockedUntil) {
          err.textContent = `محاولات كثيرة — انتظر ${Math.ceil((lockedUntil - Date.now()) / 1000)} ثانية`;
          return;
        }
        if (arDigits(inp.value).trim() === adminPin()) {
          lsSet('km-unlock', adminPin());
          lsSet('km-admin', '1');
          tries = 0;
          render();
          return;
        }
        tries++;
        if (tries >= 5) { lockedUntil = Date.now() + 30000; tries = 0; err.textContent = 'محاولات كثيرة — انتظر 30 ثانية'; }
        else err.textContent = 'الرقم غير صحيح';
        inp.select();
      };
      setTimeout(() => inp.focus(), 50);
      return el('form', { class: 'card code-form', onsubmit: go },
        el('label', null, '🔒 صفحة التوزيع مقفلة'),
        el('p', { class: 'hint' }, 'اكتب الرقم السري للدخول.'),
        el('div', { class: 'code-row' }, inp, el('button', { class: 'btn primary', type: 'submit' }, 'دخول')),
        err,
        el('p', { class: 'hint' }, el('a', { href: link('home') }, '← رجوع للرئيسية')));
    }

    function render() {
      pending = false;
      if (!ready) { body.replaceChildren(el('p', { class: 'empty-note' }, 'جاري التحميل…')); return; }
      if (!unlocked()) { body.replaceChildren(lockCard()); return; }
      lsSet('km-admin', '1'); // وصل هنا = مصرّح له، فنظهر زر التوزيع على هذا الجهاز
      const y = window.scrollY;
      const empty = !Object.keys(root.students || {}).length;
      body.replaceChildren(
        empty && window.SEED ? el('section', { class: 'card warn' },
          el('p', null, `القائمة فاضية. عبّئها بالقائمة الأولية (${Object.keys(window.SEED.students).length} طالب وطالبة):`),
          el('button', {
            class: 'btn primary big', type: 'button',
            onclick: () => { write('PUT', '', JSON.parse(JSON.stringify(window.SEED))); toast('تمت التعبئة', 'ok'); },
          }, 'تعبئة القائمة')) : '',
        buildingsCard(),
        moveClassCard(),
        studentsCard(),
        linksCard(),
        settingsCard(),
        pinCard(),
        renameCard(),
        bulkCard(),
        toolsCard());
      window.scrollTo(0, y);
    }

    // لا نعيد الرسم أثناء الكتابة في حقل حتى لا يضيع المؤشر
    const maybeRender = () => {
      if (reviewing) { pending = true; return; }
      const a = document.activeElement;
      if (a && body.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { pending = true; return; }
      render();
    };
    const onFocusOut = () => setTimeout(() => { if (pending) maybeRender(); }, 50);
    body.addEventListener('focusout', onFocusOut);
    subs.add(maybeRender);
    render();
    cleanup = () => pad.dispose();
  }

  route();
})();
