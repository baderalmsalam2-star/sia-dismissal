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

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } };

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
  function undoTo(id, prev) {
    return () => (prev ? write('PUT', `calls/${id}`, prev) : write('DELETE', `calls/${id}`));
  }
  function callStudent(s) {
    const prev = (root.calls || {})[s.id];
    write('PUT', `calls/${s.id}`, { t: SV });
    if (navigator.vibrate) navigator.vibrate(30);
    toast(`تم نداء ${s.n}`, 'ok', { label: 'تراجع', fn: undoTo(s.id, prev) });
  }
  function markOut(s) {
    const prev = (root.calls || {})[s.id];
    write('PATCH', `calls/${s.id}`, { o: SV });
    toast(`${s.n} خرج`, '', { label: 'تراجع', fn: undoTo(s.id, prev) });
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
      withBack ? el('a', { class: 'back', href: link('home'), 'aria-label': 'الرئيسية' }, '›') : null,
      el('img', { class: 'topbar-logo', src: 'assets/logo.png', alt: '' }),
      el('div', { class: 'topbar-title' }, el('strong', null, title), el('small', null, CFG.schoolName || '')),
      statusPill());
  }

  function localBanner() {
    if (REMOTE) return null;
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
        el('a', { class: 'tile', href: link('manage') },
          el('span', { class: 'tile-icon', 'aria-hidden': 'true' }, '🗂️'),
          el('span', null, el('strong', null, 'التوزيع والإعدادات'), el('small', null, 'نقل الطلبة بين المباني، الإضافة والحذف، الروابط'))),
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
    app.append(
      bar,
      localBanner(),
      el('div', { class: 'controls' }, el('div', { class: 'search-wrap' }, search, clearBtn), jump, summary),
      list);

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
    cleanup = () => clearInterval(iv);
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

    app.append(
      el('header', { class: 'scr-head' },
        el('a', { class: 'scr-home', href: link('home'), title: 'تغيير الرمز' },
          el('img', { class: 'scr-logo', src: 'assets/logo.png', alt: 'الرئيسية' })),
        el('div', { class: 'scr-title' }, title, sub),
        stats,
        el('div', { class: 'scr-time' }, clock, dateEl)),
      body, notFound, startBtn);

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
      if (!scope) { title.textContent = 'رمز غير معروف'; sub.textContent = ''; return; }

      title.textContent = scope.title;
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
    cleanup = () => { clearInterval(t1); clearInterval(t2); document.removeEventListener('visibilitychange', onVis); };
  }

  // ---------- التوزيع والإعدادات ----------
  function viewManage() {
    document.body.className = 'page-manage';
    const body = el('main', { class: 'manage' });
    app.append(topbar('التوزيع والإعدادات'), localBanner(), body);

    let fb = lsGet('km-mb') || 'all';
    let fq = '';
    let pending = false;

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
        row('🏠 الصفحة الرئيسية (للمعلمات)', absLink('home')),
        buildings().map((b) => [
          row(`📣 نداء ${b.name} (المواقف)`, absLink('call', { code: b.code || b.name })),
          row(`🖥️ شاشة ${b.name} — الرمز ${b.code || '—'}`, absLink('screen', { code: b.code || b.name })),
        ]),
        el('details', null,
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
          return el('div', { class: 'bld-row' },
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
            }, 'حذف'));
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
          }, 'استرجاع القائمة الأولية') : null),
        el('p', { class: 'hint' }, 'النداءات تتصفّر تلقائيًا كل يوم جديد.'),
        REMOTE ? el('p', { class: 'hint' }, 'رمز المدرسة: ', el('code', null, KEY)) : null);
    }

    function render() {
      pending = false;
      if (!ready) { body.replaceChildren(el('p', { class: 'empty-note' }, 'جاري التحميل…')); return; }
      const y = window.scrollY;
      const empty = !Object.keys(root.students || {}).length;
      body.replaceChildren(
        empty && window.SEED ? el('section', { class: 'card warn' },
          el('p', null, `القائمة فاضية. عبّئها بالقائمة الأولية (${Object.keys(window.SEED.students).length} طالب وطالبة):`),
          el('button', {
            class: 'btn primary big', type: 'button',
            onclick: () => { write('PUT', '', JSON.parse(JSON.stringify(window.SEED))); toast('تمت التعبئة', 'ok'); },
          }, 'تعبئة القائمة')) : null,
        buildingsCard(),
        moveClassCard(),
        studentsCard(),
        linksCard(),
        settingsCard(),
        bulkCard(),
        toolsCard());
      window.scrollTo(0, y);
    }

    // لا نعيد الرسم أثناء الكتابة في حقل حتى لا يضيع المؤشر
    const maybeRender = () => {
      const a = document.activeElement;
      if (a && body.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { pending = true; return; }
      render();
    };
    const onFocusOut = () => setTimeout(() => { if (pending) maybeRender(); }, 50);
    body.addEventListener('focusout', onFocusOut);
    subs.add(maybeRender);
    render();
  }

  route();
})();
