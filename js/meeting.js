/* Running a meeting (admins): setup → who's here → meeting → wrap-up.
   Notes are kept on this device (no passphrase; the device lock protects them). At End meeting, follow-ups
   go to the to-do list and decisions replace the group's Decisions list. */
(function () {
  const A = window.App, sb = A.sb, esc = A.esc, I = window.ICON, R = window.RING, q = A.q;
  const root = document.getElementById('app');
  const dlg = document.getElementById('dlg');
  const MODELS = [['claude-sonnet-5-5', 'Sonnet 5.5 (recommended)'], ['claude-haiku-5-5', 'Haiku 5.5 (cheapest)'], ['claude-opus-5-5', 'Opus 5.5 (most capable)']];
  const MAMMOTH = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';
  const JSPDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
  const freshMeeting = () => ({ id: uid(), phase: 'setup', meta: { title: '', date: A.todayISO(), location: '', startTime: '', openingPrayer: '', closingPrayer: '', confidential: false },
    present: [], items: [], cur: 0, startedAt: null, endedAt: null, sync: {}, exported: false });
  const newItem = (title = '', detail = '') => ({ id: uid(), title, detail, notes: '', decision: '', followUp: false, task: '', assignees: [], due: '', openedAt: null, visited: false, kind: 'normal' });

  let C = null;              // context from the app: uid, me (person), group, people, offline, goHome
  let D = null;              // this admin's saved meeting data while the meeting screens are open
  let active = false, intent = 'continue';
  let syncing = false, pendingFile = null, background = false;

  /* ---------- storage ---------- */
  const markerKey = () => 'mm_active:' + C.uid;
  function writeMarker() {
    const m = D.meeting;
    const phase = m.phase === 'setup' && !m.items.length && !m.meta.title ? 'empty' : m.phase;
    try { localStorage.setItem(markerKey(), JSON.stringify({ phase, title: m.meta.confidential ? '' : m.meta.title })); } catch (e) {}
  }
  let saveT;
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(store, 350);
    writeMarker();
    if (D.meeting.phase === 'meeting') Live.push(snapshot());
  }
  function store() { if (!D) return; try { Vault.save(D); } catch (e) { A.toast(e.message); } }
  function saveNow() { clearTimeout(saveT); writeMarker(); store(); return Promise.resolve(); }
  const M = () => D.meeting;
  const cur = () => M().items[M().cur];
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };

  /* ---------- people (saved on the device so meetings work offline) ---------- */
  const people = () => (D.cache.people || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const personName = id => ((D.cache.people || []).find(m => m.id === id) || {}).name || 'Former member';
  const online = () => !C.offline && navigator.onLine && !!sb;

  /* ---------- busy overlay ---------- */
  const busy = m => { document.getElementById('busyMsg').textContent = m; document.getElementById('busy').classList.add('on'); };
  const unbusy = () => document.getElementById('busy').classList.remove('on');

  /* ---------- entry and exit ---------- */
  function open(ctx) {
    C = ctx; active = true;
    A.loadScript(JSPDF).catch(() => {});      // keep the PDF tool cached for offline meetings
    if (D) return background ? afterLoad() : render();   // a background send may have the last meeting loaded
    if (document.getElementById('lockForm')) return;   // never wipe an old passphrase being typed
    D = Vault.load();
    if (D) return afterLoad();
    if (Vault.legacy()) return renderLegacy();
    D = blank(); afterLoad();
  }
  const blank = () => ({ v: 3, settings: { apiKey: '', model: MODELS[0][0] }, cache: { people: [] }, meeting: freshMeeting() });
  function close() {
    if (!active) return;
    active = false; dlg.open && dlg.close();
    if (D) { if (D.meeting.phase === 'meeting') Live.pause(); saveNow(); }
    D = null; pendingFile = null; keepAwake(false); unbusy();
  }
  function marker(u) { try { return JSON.parse(localStorage.getItem('mm_active:' + u)); } catch (e) { return null; } }

  /* ---------- notes saved with the old passphrase (one time) ---------- */
  function renderLegacy(err) {
    root.innerHTML = `<div class="gate"><form class="card" id="lockForm" autocomplete="off">
      <div class="badge">${I('lock', 'i', 28)}</div>
      <h1>Meeting notes</h1>
      <p>Meeting notes no longer need a passphrase. Enter your old one once to bring over the notes saved on this device.</p>
      <label class="sr" for="pw1">Old passphrase</label><input class="input" type="password" id="pw1" autocomplete="current-password" placeholder="Old passphrase" required>
      <div class="err" id="lockErr">${esc(err || '')}</div>
      <button class="btn primary block" type="submit">Bring over notes</button>
      <button class="btn ghost block" type="button" id="lockFresh" style="color:var(--muted)">Start fresh instead</button>
      <button class="btn ghost block" type="button" id="lockBack" style="color:var(--muted)">Back to home</button>
    </form></div>`;
    setTimeout(() => { const p = document.getElementById('pw1'); if (p) p.focus(); }, 50);
    on('lockBack', () => C.goHome());
    on('lockFresh', () => {
      if (!confirm('Start fresh? The notes saved with your old passphrase are erased from this device. Items already in the to-do list stay there.')) return;
      Vault.dropLegacy(); D = blank(); afterLoad();
    });
    document.getElementById('lockForm').onsubmit = async e => {
      e.preventDefault();
      busy('Bringing over your notes…');
      try {
        const data = await Vault.unlockLegacy(document.getElementById('pw1').value);
        unbusy();
        if (!active) return;
        D = data; afterLoad();
      } catch (ex) { unbusy(); renderLegacy(ex.message); }
    };
  }
  /* The group's names from the database, plus any name this meeting still uses that the fresh list lacks
     (a name added on Who's here moments ago, or one deleted since), so nobody turns into "Former member". */
  function freshPeople() {
    const list = C.people.map(p => ({ id: p.id, name: p.name }));
    const m = D.meeting, used = new Set([...(m.present || []), ...(m.items || []).flatMap(i => i.assignees || [])]);
    (D.cache.people || []).forEach(p => { if (used.has(p.id) && !list.some(x => x.id === p.id)) list.push(p); });
    return list;
  }
  function afterLoad() {
    if (!C.offline) D.cache = { people: freshPeople(), at: new Date().toISOString() };
    const m = M();
    const empty = m.phase === 'setup' && !m.items.length && !m.meta.title;
    if (intent === 'new' && m.phase === 'done') {
      if (m.exported || confirm('Start a new meeting? The last meeting’s notes are cleared from this device. If you still need them, cancel and download the PDF or save a copy first.')) {
        D.meeting = freshMeeting(); D.agendaDraft = '';
      }
    } else if (intent === 'new' && empty) { D.meeting = freshMeeting(); }
    intent = 'continue';
    save(); render();
    if (M().phase === 'done') syncTracker();
    if (M().phase === 'meeting') startLive();
  }

  setInterval(() => {
    if (!active || !D) return;
    const el = document.getElementById('elapsed'); if (el) el.textContent = elapsed();
  }, 30000);

  /* ---------- top-level render ---------- */
  function render() {
    if (!active) return;
    if (!D) return;
    const p = M().phase;
    keepAwake(p === 'meeting');
    if (p === 'attendance') renderAttendance();
    else if (p === 'meeting') renderMeeting();
    else if (p === 'done') renderDone();
    else renderSetup();
  }

  /* ---------- setup ---------- */
  function renderSetup() {
    const m = M(), meta = m.meta;
    root.innerHTML = `<div class="setup">
      <div class="bar">
        <button class="icon-btn" id="homeBtn" aria-label="Back to home">${I('back')}</button>
        <h1>New meeting</h1>
        <button class="icon-btn" id="openBtn" aria-label="Open a saved meeting file">${I('folder')}</button>
        <button class="icon-btn" id="settingsBtn" aria-label="Settings">${I('gear')}</button>
        <button class="btn primary" id="toAtt" ${m.items.length ? '' : 'disabled'}>Next: who’s here${I('next')}</button>
      </div>
      <div class="setup-g">
        <div class="setup-l">
          <section class="card">
            <h2>Agenda</h2>
            <label class="sr" for="agText">Agenda text</label>
            <textarea class="textarea" id="agText" rows="6" placeholder="Paste the agenda here, or load a file.">${esc(D.agendaDraft || '')}</textarea>
            <div id="pending">${pendingFile ? `<span class="filechip">${I('clip', 'i', 16)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pendingFile.name)}</span><button class="mini" id="clrFile" aria-label="Remove file" style="width:34px;height:34px;background:none">${I('x', 'i', 16)}</button></span>` : ''}</div>
            <div class="row" style="margin-top:14px">
              <button class="btn" id="loadFile">${I('clip')}Load file or photo</button>
              <button class="btn soft" id="readAgenda">Read agenda</button>
            </div>
            <p class="note-s">${smart() ? 'Paste the agenda, or load a PDF, Word file or photo, then tap Read agenda.' : 'Paste the agenda or load a Word or text file, then tap Read agenda. Each line becomes an item; indented lines become details.'}</p>
          </section>
          <section class="card">
            <h2>Meeting</h2>
            <div class="field"><label class="label" for="mTitle">Name</label><input class="input" id="mTitle" data-meta="title" value="${esc(meta.title)}" placeholder="e.g. Board meeting"></div>
            <div class="grid2 field">
              <div><label class="label" for="mDate">Date</label><input class="input" type="date" id="mDate" data-meta="date" value="${esc(meta.date)}"></div>
              <div><label class="label" for="mStart">Start time</label><input class="input" type="time" id="mStart" data-meta="startTime" value="${esc(meta.startTime || '')}"></div>
              <div><label class="label" for="mOpen">Opening prayer</label><input class="input" id="mOpen" data-meta="openingPrayer" value="${esc(meta.openingPrayer || '')}" placeholder="Brother…"></div>
              <div><label class="label" for="mPrayer">Closing prayer</label><input class="input" id="mPrayer" data-meta="closingPrayer" value="${esc(meta.closingPrayer || '')}" placeholder="Brother…"></div>
            </div>
            <div class="field"><label class="label" for="mLoc">Location</label><input class="input" id="mLoc" data-meta="location" value="${esc(meta.location)}" placeholder="Optional"></div>
            <button class="switch" role="switch" id="confSw" aria-checked="${meta.confidential}"><span class="track"></span>Confidential</button>
            <p class="note-s" style="margin-top:4px">Keeps this meeting’s agenda and notes on this device only. Follow-ups and decisions still go to the group.</p>
          </section>
        </div>
        <section class="card">
          <div class="row" style="justify-content:space-between;margin-bottom:8px"><h2 style="margin:0">Items</h2>
            <div class="row">${online() && !m.items.some(i => i.kind === 'carryover') ? `<button class="btn sm soft" id="addCarry">${I('refresh', 'i', 16)}Add open action items</button>` : ''}<button class="btn sm" id="addRow">${I('plus', 'i', 16)}Add item</button></div></div>
          <div id="rows">${m.items.length ? m.items.map((it, i) => `<div class="arow" data-i="${i}"><span class="num">${i + 1}</span>
              <button class="fs" data-act="edit" aria-label="Edit item ${i + 1}"><b>${esc(it.title || 'Untitled item')}</b>${it.kind === 'carryover' ? `<span>${(it.carry || []).length} open items from the to-do list<span class="tag">Live</span></span>` : it.detail ? `<span>${esc(it.detail)}</span>` : ''}</button>
              <button class="mini" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">${I('up', 'i', 18)}</button><button class="mini" data-act="down" ${i === m.items.length - 1 ? 'disabled' : ''} aria-label="Move down">${I('down', 'i', 18)}</button><button class="mini danger" data-act="del" aria-label="Remove">${I('x', 'i', 18)}</button></div>`).join('')
            : '<p class="muted" style="margin:4px 0">No items yet. Read the agenda, or add items by hand.</p>'}</div>
        </section>
      </div></div>`;
    on('homeBtn', () => C.goHome());
    on('openBtn', () => document.getElementById('openFile').click());
    on('settingsBtn', settingsDialog);
    root.querySelectorAll('[data-meta]').forEach(el => el.addEventListener('input', () => { meta[el.dataset.meta] = el.value; save(); }));
    on('confSw', () => { meta.confidential = !meta.confidential; save(); renderSetup(); });
    const ag = document.getElementById('agText'); ag.oninput = () => { D.agendaDraft = ag.value; save(); };
    on('loadFile', () => document.getElementById('agendaFile').click());
    on('clrFile', () => { pendingFile = null; renderSetup(); });
    on('readAgenda', readAgenda);
    on('addRow', () => { m.items.push(newItem()); save(); renderSetup(); editRow(m.items.length - 1); });
    on('addCarry', addCarryover);
    document.getElementById('rows').addEventListener('click', e => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const i = +b.closest('.arow').dataset.i, L = m.items;
      if (b.dataset.act === 'edit') return editRow(i);
      if (b.dataset.act === 'up' && i > 0) [L[i - 1], L[i]] = [L[i], L[i - 1]];
      if (b.dataset.act === 'down' && i < L.length - 1) [L[i + 1], L[i]] = [L[i], L[i + 1]];
      if (b.dataset.act === 'del') L.splice(i, 1);
      save(); renderSetup();
    });
    on('toAtt', () => {
      m.items = m.items.filter(i => i.title.trim() || i.detail.trim() || i.kind === 'carryover');
      if (!m.items.length) return A.toast('Give at least one item a title.');
      m.phase = 'attendance'; save(); render(); window.scrollTo(0, 0);
    });
  }
  function editRow(i) {
    const it = M().items[i];
    dlg.innerHTML = `<h2>Item ${i + 1}</h2>
      <div class="field"><label class="label" for="rTitle">Title</label><input class="input" id="rTitle" value="${esc(it.title)}" placeholder="Item title"></div>
      ${it.kind === 'carryover' ? '' : `<div class="field"><label class="label" for="rDetail">Details (optional)</label><textarea class="textarea" id="rDetail" rows="3" placeholder="Presenter, sub-points…">${esc(it.detail)}</textarea></div>`}
      <div class="dlg-actions"><button class="btn" id="rCancel">Cancel</button><button class="btn primary" id="rOk">Done</button></div>`;
    dlg.showModal();
    setTimeout(() => document.getElementById('rTitle').focus(), 30);
    on('rCancel', () => { dlg.close(); if (!it.title && !it.detail && it.kind !== 'carryover') { M().items.splice(i, 1); save(); renderSetup(); } });
    on('rOk', () => {
      it.title = document.getElementById('rTitle').value.trim();
      const d = document.getElementById('rDetail'); if (d) it.detail = d.value.trim();
      dlg.close();
      if (!it.title && !it.detail && it.kind !== 'carryover') M().items.splice(i, 1);
      save(); renderSetup();
    });
  }

  /* agenda import */
  /* first clock time in the agenda text, as 24-hour HH:MM ("6:30 PM", "6 pm", "18:30") */
  function findTime(text) {
    let m = /\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s*m\.?(?![a-z])/i.exec(text);
    if (m && +m[1] >= 1 && +m[1] <= 12) { let h = +m[1] % 12; if (/p/i.test(m[3])) h += 12; return String(h).padStart(2, '0') + ':' + (m[2] || '00'); }
    m = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
    return m ? m[1].padStart(2, '0') + ':' + m[2] : '';
  }
  /* "Closing prayer: Brother Smith", "Closing prayer – Bro. Smith", "Closing prayer by Brother Smith";
     the same for "Opening prayer" (or "Invocation"). */
  const prayerRe = word => new RegExp('(?:' + word + ')[^\\S\\n]*(?:[:\\-–—][^\\S\\n]*)?(?:by[^\\S\\n]+)?([^\\n]*)', 'i');
  const findClosingPrayer = text => findPrayer(text, prayerRe('closing[^\\S\\n]+prayer'));
  const findOpeningPrayer = text => findPrayer(text, prayerRe('opening[^\\S\\n]+prayer|invocation'));
  function findPrayer(text, re) {
    const m = re.exec(text);
    if (!m) return '';
    return m[1].replace(/[^\S\n]*[-–—(]?[^\S\n]*\d{1,2}(:\d{2})?[^\S\n]*([ap]\.?[^\S\n]*m\.?)?\)?[^\S\n]*$/i, '').replace(/[.;,:\-–—]+$/, '').trim();
  }
  function splitAgenda() {
    const out = [];
    const all = document.getElementById('agText').value || '';
    all.split(/\r?\n/).forEach(raw => {
      if (!raw.trim()) return;
      const isSub = /^(\t| {2,})/.test(raw) || /^\s*([a-z][.)]|[-•*–])\s/.test(raw);
      const clean = raw.replace(/^\s*(\d+(\.\d+)*[.)]?|[IVXLC]+[.)]|[A-Za-z][.)]|[-•*–])\s+/, '')
        .replace(/^\s*\d{1,2}(:\d{2}\s*([ap]\.?\s*m\.?)?|\s*[ap]\.?\s*m\.?)\s*[-–—]?\s*/i, '').trim();
      if (isSub && out.length) out[out.length - 1].detail += (out[out.length - 1].detail ? '\n' : '') + clean;
      else out.push({ title: clean, detail: '' });
    });
    applyAgenda(out, { startTime: findTime(all), openingPrayer: findOpeningPrayer(all), closingPrayer: findClosingPrayer(all) });
  }
  function applyAgenda(list, meta = {}) {
    list = (list || []).filter(x => x && String(x.title || '').trim());
    if (!list.length) return A.toast('No agenda items found.');
    const m = M();
    const keep = m.items.filter(i => i.kind === 'carryover');
    const normal = m.items.filter(i => i.kind !== 'carryover');
    if (normal.length && !confirm(`Replace the ${normal.length} items already listed?`)) return;
    const fresh = list.map(x => newItem(String(x.title).trim(), String(x.detail || '').trim()));
    if (keep.length) fresh.splice(Math.min(1, fresh.length), 0, ...keep);
    m.items = fresh;
    if (!m.meta.title && meta.title) m.meta.title = meta.title;
    if (!m.meta.location && meta.location) m.meta.location = meta.location;
    if (meta.startTime && /^\d{2}:\d{2}$/.test(meta.startTime)) m.meta.startTime = meta.startTime;
    if (meta.openingPrayer) m.meta.openingPrayer = String(meta.openingPrayer).trim();
    if (meta.closingPrayer) m.meta.closingPrayer = String(meta.closingPrayer).trim();
    if (meta.date && /^\d{4}-\d{2}-\d{2}$/.test(meta.date) && m.meta.date === A.todayISO()) m.meta.date = meta.date;
    save(); renderSetup(); A.toast(list.length + ' items loaded. Check them on the right.');
  }
  const toB64 = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
  const shrinkImage = f => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => { const k = Math.min(1, 1800 / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(img.src); res(c.toDataURL('image/jpeg', 0.85).split(',')[1]); };
    img.onerror = () => rej(new Error('unsupported image')); img.src = URL.createObjectURL(f);
  });
  document.getElementById('agendaFile').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f || !D) return;
    const n = f.name.toLowerCase();
    try {
      if (f.type === 'application/pdf' || n.endsWith('.pdf') || f.type.startsWith('image/')) {
        if (M().meta.confidential) return A.toast('Confidential meetings stay on this device, so PDFs and photos can’t be read. Paste the text instead.');
        if (!D.settings.apiKey) return A.toast('To read PDFs and photos, add your Anthropic key in Settings. Or paste the text.');
        pendingFile = f.type.startsWith('image/')
          ? { name: f.name, block: { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await shrinkImage(f) } } }
          : { name: f.name, block: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: await toB64(f) } } };
      } else if (n.endsWith('.docx')) {
        busy('Reading Word file…'); await A.loadScript(MAMMOTH);
        const r = await window.mammoth.extractRawText({ arrayBuffer: await f.arrayBuffer() });
        D.agendaDraft = r.value.replace(/\n{3,}/g, '\n\n').trim(); pendingFile = null; unbusy(); save();
        A.toast('Loaded. Tap Read agenda.');
      } else { D.agendaDraft = (await f.text()).trim(); pendingFile = null; save(); }
      renderSetup();
    } catch (err) { unbusy(); A.toast('Couldn’t read that file: ' + err.message); }
  };

  async function callClaude(content, system, maxTokens) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': D.settings.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: D.settings.model || MODELS[0][0], max_tokens: maxTokens, system, messages: [{ role: 'user', content }] })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || ('Couldn’t reach the service (' + res.status + ')'));
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }
  function parseJSON(t) { const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a < 0 || b < a) throw new Error('Couldn’t read that. Try again.'); return JSON.parse(t.slice(a, b + 1)); }

  function smart() { return !!D.settings.apiKey && !M().meta.confidential; }
  function readAgenda() {
    const txt = (document.getElementById('agText').value || '').trim();
    if (!pendingFile && !txt) return A.toast('Paste an agenda or load a file first.');
    if (smart() && navigator.onLine) return smartParseAgenda();
    splitAgenda();
  }
  async function smartParseAgenda() {
    const txt = (document.getElementById('agText').value || '').trim();
    const content = []; if (pendingFile) content.push(pendingFile.block);
    content.push({ type: 'text', text: `Extract the agenda items in order. Return JSON only, in this shape:
{"title":"meeting name or empty","date":"YYYY-MM-DD or empty","location":"or empty","startTime":"meeting start time as 24-hour HH:MM, or empty","openingPrayer":"name of whoever gives the opening prayer or invocation, exactly as written (e.g. Brother Ruiz), or empty","closingPrayer":"name of whoever gives the closing prayer, exactly as written (e.g. Brother Smith), or empty","items":[{"title":"short item title","detail":"presenter, sub-points, or supporting info; empty if none"}]}
Rules: one entry per top-level agenda item; fold sub-items into "detail" (use line breaks); keep standard items like Call to Order, Approval of Minutes, and Adjournment; drop page headers, footers, and logistics that are not agenda items; never invent anything.
${txt ? 'Agenda text:\n' + txt : 'The agenda is in the attached file.'}` });
    busy('Reading the agenda…');
    try {
      const out = parseJSON(await callClaude(content, 'You convert meeting agendas into structured JSON. Respond with JSON only.', 4000));
      unbusy(); pendingFile = null;
      if (txt) { out.startTime = out.startTime || findTime(txt); out.openingPrayer = out.openingPrayer || findOpeningPrayer(txt); out.closingPrayer = out.closingPrayer || findClosingPrayer(txt); }
      applyAgenda(out.items, out);
    } catch (err) {
      unbusy();
      if (txt && !pendingFile) splitAgenda();
      else A.toast('Couldn’t read that file. Try again, or paste the text.');
    }
  }

  /* open items from the to-do list become one live agenda item */
  async function addCarryover() {
    busy('Getting open items…');
    try {
      const items = await q(sb.from('items').select('*').eq('status', 'open'));
      const ids = items.map(i => i.id);
      const [asg, ups] = ids.length ? await Promise.all([
        q(sb.from('item_assignees').select('*').in('item_id', ids)),
        q(sb.from('item_updates').select('*').in('item_id', ids).eq('kind', 'note').order('created_at', { ascending: false }))
      ]) : [[], []];
      unbusy();
      if (!items.length) return A.toast('No open action items.');
      const carry = items.sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999')).map(it => {
        const who = asg.filter(a => a.item_id === it.id).map(a => personName(a.person_id));
        const latest = ups.find(u => u.item_id === it.id);
        return { id: it.id, title: it.title, who, due: it.due_date || '', latest: latest ? latest.body : '', closed: false };
      });
      const m = M();
      const it = newItem('Open action items', carryDetail(carry)); it.kind = 'carryover'; it.carry = carry;
      m.items.splice(Math.min(1, m.items.length), 0, it);
      save(); renderSetup(); A.toast(carry.length + ' open items added');
    } catch (e) { unbusy(); A.toast('Couldn’t reach the to-do list: ' + e.message); }
  }
  function carryDetail(carry) {
    return carry.map(c => `• ${c.title} — ${c.who.join(', ') || 'unassigned'}${c.due ? ', due ' + A.fmtDate(c.due) : ', no due date'}${c.closed ? ' (done)' : ''}${c.latest ? ' — latest: ' + c.latest : ''}`).join('\n');
  }

  /* ---------- attendance ---------- */
  function renderAttendance() {
    const m = M();
    const list = people();
    const n = m.present.length;
    root.innerHTML = `<div class="center"><div class="card att">
      <div class="eyebrow">${esc(m.meta.title || 'Meeting')} · ${esc(A.fmtDate(m.meta.date))}</div>
      <div class="row" style="justify-content:space-between;align-items:baseline"><h1>Who’s here?</h1><span class="muted" id="cnt">${list.length ? `${n} of ${list.length}` : ''}</span></div>
      <div class="people">${list.map(p => `<button class="person" data-id="${p.id}" aria-pressed="${m.present.includes(p.id)}"><span class="avatar">${esc(A.initials(p.name))}</span><span class="nm">${esc(p.name)}</span><span class="ck">${I('check')}</span></button>`).join('')}
        <button class="person add-p" id="attAdd">${I('plus')}Add name</button></div>
      <div class="row" style="justify-content:space-between"><button class="btn ghost" id="back">${I('back')}Back</button><button class="btn primary" id="go">${m.startedAt ? 'Back to agenda' : 'Start agenda'}${I('next')}</button></div>
    </div></div>`;
    on('attAdd', addName);
    root.querySelectorAll('.person[data-id]').forEach(b => b.onclick = () => {
      const id = b.dataset.id, i = m.present.indexOf(id);
      if (i >= 0) m.present.splice(i, 1); else m.present.push(id);
      b.setAttribute('aria-pressed', i < 0); document.getElementById('cnt').textContent = `${m.present.length} of ${list.length}`; save();
    });
    on('back', () => { m.phase = m.startedAt ? 'meeting' : 'setup'; save(); render(); });
    on('go', () => {
      if (!m.startedAt) { m.startedAt = new Date().toISOString(); m.cur = 0; }
      m.phase = 'meeting'; save(); render(); startLive();
    });
  }

  /* a new name joins the group's list (same as People → Add name) and is marked present */
  function addName() {
    if (!online()) return A.toast('Adding a name needs a connection. Add them under People once you’re back online.');
    dlg.innerHTML = `<h2>Add a name</h2>
      <div class="field"><label class="label" for="anName">Name as it should appear</label><input class="input" id="anName" placeholder="e.g. Dana R." maxlength="80"></div>
      <p class="note-s">Joins the group’s list and is marked present. Add an email or remove names later under People.</p>
      <div class="dlg-actions"><button class="btn" id="anCancel">Cancel</button><button class="btn primary" id="anOk">Add</button></div>`;
    dlg.showModal();
    setTimeout(() => document.getElementById('anName').focus(), 30);
    on('anCancel', () => dlg.close());
    on('anOk', async () => {
      const name = document.getElementById('anName').value.trim().replace(/\s+/g, ' ');
      if (!name) return document.getElementById('anName').focus();
      const m = M(), same = (D.cache.people || []).find(p => p.name.toLowerCase() === name.toLowerCase());
      if (same) {
        if (!m.present.includes(same.id)) m.present.push(same.id);
        dlg.close(); save(); renderAttendance(); return A.toast(same.name + ' is already on the list. Marked present.');
      }
      const btn = document.getElementById('anOk'); btn.disabled = true;
      const { data, error } = await sb.from('people').insert({ group_id: C.me.group_id, name }).select('id,name').single();
      if (error) { btn.disabled = false; return A.toast('Not added: ' + error.message); }
      (D.cache.people = D.cache.people || []).push({ id: data.id, name: data.name });
      m.present.push(data.id);
      dlg.close(); save(); renderAttendance(); A.toast(data.name + ' added');
    });
  }

  /* ---------- live view for other admins (notes pass through, never stored) ---------- */
  function snapshot() {
    const m = M();
    return { title: m.meta.title || 'Meeting', items: m.items.map(it => ({ title: it.title, detail: it.detail, notes: it.notes, decision: it.decision,
      followUp: !!it.followUp, task: it.followUp ? (it.task || it.title) : '', who: it.followUp ? it.assignees.map(personName) : [], due: it.followUp ? it.due : '' })) };
  }
  function startLive() {
    if (!online()) return;
    Live.broadcast({ group_id: C.me.group_id, person_id: C.me.id, title: M().meta.title || 'Meeting', taker: C.me.name }, snapshot);
  }

  /* ---------- meeting ---------- */
  function elapsed() { const m = M(); if (!m.startedAt) return ''; return Math.max(0, Math.round((Date.now() - new Date(m.startedAt)) / 60000)) + ' min'; }
  function renderMeeting() {
    const m = M();
    if (!m.items.length) m.items.push(newItem('New item'));
    m.cur = Math.max(0, Math.min(m.cur, m.items.length - 1));
    const it = cur();
    if (!it.openedAt) it.openedAt = new Date().toISOString();
    it.visited = true; save();
    const last = m.cur === m.items.length - 1;
    const nextT = last ? '' : (m.items[m.cur + 1].title || 'next item');
    root.innerHTML = `<div class="mtg">
      <nav class="rail" aria-label="Agenda">
        <div><div class="t">${esc(m.meta.title || 'Meeting')}</div>
          <div class="meta">${esc(A.fmtDate(m.meta.date))} · <span id="elapsed">${elapsed()}</span> · <a href="#" id="toAtt">${m.present.length} present</a></div>
          ${m.meta.confidential ? `<span class="conf">${I('lock', 'i', 12)}Confidential</span>` : ''}</div>
        <div class="agenda" id="agenda">${m.items.map((x, i) => {
          const st = i === m.cur ? 'cur' : x.visited ? 'done' : '';
          return `<div class="ag ${st}" ${i === m.cur ? '' : `role="button" tabindex="0" data-go="${i}"`}>${i === m.cur ? R.current : x.visited ? R.done : R.todo}<span class="lbl">${esc(x.title || 'Untitled item')}</span>${i === m.cur ? `<span class="mv"><button data-mv="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move this item up">${I('up', 'i', 18)}</button><button data-mv="1" ${last ? 'disabled' : ''} aria-label="Move this item down">${I('down', 'i', 18)}</button></span>` : ''}</div>`;
        }).join('')}
          <button class="ag add-ag" id="addAfter">${I('plus')}Add item after this one</button></div>
        <button class="btn ghost danger" id="end" style="justify-content:flex-start">End meeting</button>
      </nav>
      <main class="main">
        <div class="scroll">
          <div><div class="eyebrow2">Item ${m.cur + 1} of ${m.items.length}</div>
            <label class="sr" for="fTitle">Item title</label><input class="ttl" id="fTitle" data-f="title" value="${esc(it.title)}" placeholder="Item title">
            ${it.kind === 'carryover' ? '' : `<label class="sr" for="fDetail">Item details</label><input class="det" id="fDetail" data-f="detail" value="${esc(it.detail)}" placeholder="Details (optional)">`}</div>
          ${it.kind === 'carryover' ? carryPanel(it) : ''}
          <label class="notes"><span class="label">Notes</span><textarea class="textarea" id="fNotes" data-f="notes" placeholder="What was discussed">${esc(it.notes)}</textarea></label>
          <section class="outcome${it.followUp ? ' on' : ''}" id="outcome" aria-label="Outcome">${outcomeInner(it)}</section>
        </div>
        <div class="foot">
          <button class="btn" id="prev" ${m.cur === 0 ? 'disabled' : ''}>Previous</button>
          <button class="btn ghost" id="remove" style="color:var(--muted)">Remove item</button>
          <span class="grow"></span>
          <button class="btn primary" id="next">${last ? 'Finish meeting' : 'Next: ' + esc(nextT)}${I('next')}</button>
        </div>
      </main></div>`;
    wireMeeting();
  }
  function outcomeInner(it) {
    return `<div><label class="label" for="fDecision">Decision</label><input class="input" id="fDecision" data-f="decision" value="${esc(it.decision)}" placeholder="What was decided? (optional)"></div>
      <div class="head"><button class="switch" role="switch" id="fuSw" aria-checked="${it.followUp}"><span class="track"></span>Needs follow-up</button>
        ${it.followUp ? `<span class="goes">${I('check', 'i', 14)}Goes to tracker</span>` : ''}</div>
      ${it.followUp ? `<div class="fu">
        <div class="full"><label class="label" for="fTask">Task</label><input class="input" id="fTask" data-f="task" value="${esc(it.task)}" placeholder="${esc(it.title ? 'e.g. ' + it.title : 'What needs to happen')}"></div>
        <div><span class="label" id="asgLbl">Assigned to</span><div class="people-field" aria-labelledby="asgLbl">${it.assignees.map(id => `<span class="person-chip">${esc(personName(id))}<button data-unassign="${id}" aria-label="Remove ${esc(personName(id))}">${I('x', 'i', 14)}</button></span>`).join('')}<button class="add-person" id="addPerson" aria-label="Add person">${I('plus', 'i', 18)}</button></div></div>
        <div><label class="label" for="fDue">Due date</label><input class="input" type="date" id="fDue" data-f="due" value="${esc(it.due)}"></div>
      </div>` : ''}`;
  }
  function carryPanel(it) {
    const items = it.carry || [];
    if (!items.length) return '<p class="muted">No open items.</p>';
    return `<div class="carry">${items.map((c, k) => {
      const late = c.due && A.daysFromToday(c.due) < 0 && !c.closed;
      return `<div class="ci${late ? ' late' : ''}${c.closed ? ' closed' : ''}" data-k="${k}">
        <div class="t">${esc(c.title)}${c.closed ? ' — done' : ''}</div>
        <div class="m">${esc(c.who.join(', ') || 'Unassigned')} · ${c.due ? (late ? `<span class="amber-text">Due ${esc(A.fmtDate(c.due))}</span>` : 'Due ' + esc(A.fmtDate(c.due))) : '<span class="amber-text">No due date</span>'}${c.latest ? ' · Latest: ' + esc(c.latest) : ''}</div>
        ${c.closed ? '' : `<div class="r"><label class="sr" for="cu${k}">Update for ${esc(c.title)}</label><input class="input" id="cu${k}" placeholder="Add an update"><button class="btn sm soft" data-cadd="${k}">Add</button><button class="btn sm" data-cdone="${k}">${I('check', 'i', 16)}Done</button></div>`}
      </div>`;
    }).join('')}</div>`;
  }
  function wireMeeting() {
    const m = M(), it = cur();
    const main = root.querySelector('.main');
    main.addEventListener('input', e => {
      const f = e.target.dataset.f; if (!f) return;
      it[f] = e.target.value; save();
      if (f === 'title') { const lbl = root.querySelector('.ag.cur .lbl'); if (lbl) lbl.textContent = it.title || 'Untitled item'; }
    });
    const wireOutcome = () => {
      on('fuSw', () => { it.followUp = !it.followUp; save(); const o = document.getElementById('outcome'); o.classList.toggle('on', it.followUp); o.innerHTML = outcomeInner(it); wireOutcome(); });
      on('addPerson', () => pickPeople(it.assignees, ids => { it.assignees = ids; save(); document.getElementById('outcome').innerHTML = outcomeInner(it); wireOutcome(); }));
      root.querySelectorAll('[data-unassign]').forEach(b => b.onclick = () => { it.assignees = it.assignees.filter(x => x !== b.dataset.unassign); save(); document.getElementById('outcome').innerHTML = outcomeInner(it); wireOutcome(); });
    };
    wireOutcome();
    const go = i => { m.cur = Math.max(0, Math.min(i, m.items.length - 1)); save(); renderMeeting(); };
    root.querySelectorAll('[data-go]').forEach(el => { el.onclick = () => go(+el.dataset.go); el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(+el.dataset.go); } }; });
    root.querySelectorAll('[data-mv]').forEach(b => b.onclick = e => {
      e.stopPropagation();
      const d = +b.dataset.mv, i = m.cur, j = i + d; if (j < 0 || j >= m.items.length) return;
      [m.items[i], m.items[j]] = [m.items[j], m.items[i]]; m.cur = j; save(); renderMeeting();
    });
    on('addAfter', () => { m.items.splice(m.cur + 1, 0, newItem('')); go(m.cur + 1); setTimeout(() => document.getElementById('fTitle').focus(), 30); });
    on('prev', () => go(m.cur - 1));
    on('next', () => m.cur === m.items.length - 1 ? endMeeting() : go(m.cur + 1));
    on('remove', () => {
      if (!confirm(`Remove “${it.title || 'this item'}” and its notes?`)) return;
      m.items.splice(m.cur, 1); if (!m.items.length) m.items.push(newItem('New item'));
      go(Math.min(m.cur, m.items.length - 1));
    });
    on('end', endMeeting);
    const ta = document.getElementById('toAtt'); if (ta) ta.onclick = e => { e.preventDefault(); m.phase = 'attendance'; save(); render(); };
    root.querySelectorAll('[data-cadd]').forEach(b => b.onclick = async () => {
      const k = +b.dataset.cadd, c = it.carry[k], inp = document.getElementById('cu' + k), body = inp.value.trim();
      if (!body) return inp.focus();
      if (!online()) return A.toast('You’re offline. Try again when connected.');
      const { error } = await sb.from('item_updates').insert({ item_id: c.id, author_id: C.me.id, kind: 'note', body });
      if (error) return A.toast('Not sent: ' + error.message);
      c.latest = body; it.detail = carryDetail(it.carry); save(); renderMeeting(); A.toast('Update added');
    });
    root.querySelectorAll('[data-cdone]').forEach(b => b.onclick = async () => {
      const k = +b.dataset.cdone, c = it.carry[k];
      if (!online()) return A.toast('You’re offline. Try again when connected.');
      const { error } = await sb.rpc('set_item_status', { p_item: c.id, p_done: true });
      if (error) return A.toast('Not changed: ' + error.message);
      c.closed = true; it.detail = carryDetail(it.carry); save(); renderMeeting(); A.toast('Marked done in the to-do list');
    });
  }
  function endMeeting() {
    if (!confirm('End the meeting now? The end time will be recorded.')) return;
    const m = M(); m.endedAt = new Date().toISOString(); m.phase = 'done'; save(); saveNow(); Live.end(); render(); syncTracker();
  }

  /* people picker: present first, then the rest of the group */
  function pickPeople(selected, onDone) {
    const m = M();
    const all = people();
    const rank = p => (m.present.includes(p.id) ? 0 : 1);
    all.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    if (!all.length) return A.toast('Add names under People on the home screen first.');
    dlg.innerHTML = `<h2>Assigned to</h2><div style="max-height:56vh;overflow:auto">${all.map(p => `<label class="check-row"><input type="checkbox" value="${p.id}" ${selected.includes(p.id) ? 'checked' : ''}><span style="flex:1">${esc(p.name)}</span><span class="sub">${rank(p) === 0 ? 'Present' : ''}</span></label>`).join('')}</div>
      <div class="dlg-actions"><button class="btn" id="pc">Cancel</button><button class="btn primary" id="po">Done</button></div>`;
    dlg.showModal();
    on('pc', () => dlg.close());
    on('po', () => { const ids = [...dlg.querySelectorAll('input:checked')].map(i => i.value); dlg.close(); onDone(ids); });
  }

  /* ---------- wrap-up: send follow-ups and decisions ---------- */
  const followUps = () => M().items.filter(i => i.followUp);
  const norm = v => (v === undefined || v === null || v === '') ? null : String(v);
  const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  async function syncTracker() {
    if ((!active && !background) || !D || syncing || M().phase !== 'done') return;
    if (!online()) { M().syncError = 'You’re offline'; renderDoneSafe(); return; }
    syncing = true; renderDoneSafe();
    const m = M(); let failed = null;
    try {
      // Follow-ups switched off (or left with nobody) since they were sent: remove them,
      // unless someone already posted an update — then keep the item and say so.
      for (const [itemId, s] of Object.entries(m.sync)) {
        const it = m.items.find(i => i.id === itemId);
        if (it && it.followUp && it.assignees.length) { delete s.kept; continue; }
        if (s.gone) { delete m.sync[itemId]; continue; }
        const ups = await q(sb.from('item_updates').select('id,kind').eq('item_id', s.trackerId));
        if (ups.some(u => u.kind !== 'created')) { s.kept = true; continue; }
        await q(sb.from('items').delete().eq('id', s.trackerId));
        delete m.sync[itemId];
      }
      for (const it of followUps().filter(i => i.assignees.length)) {
        const key = m.id + ':' + it.id;
        const want = { title: (it.task || it.title || 'Untitled').trim(), decision: it.decision.trim() || null, due_date: it.due || null, agenda_item: it.title || null };
        const wantA = it.assignees.slice().sort();
        const s = m.sync[it.id];
        const ex = await q(sb.from('items').select('*').eq('source_key', key).maybeSingle());
        if (!ex) {
          if (s && s.trackerId) { s.gone = true; continue; }   // deleted in the to-do list: leave it deleted
          const ins = await q(sb.from('items').insert({ ...want, group_id: C.me.group_id, meeting_title: m.meta.title || 'Meeting', meeting_date: m.meta.date || null,
            source_key: key, created_by: C.me.id }).select('id').single());
          await q(sb.from('item_updates').insert({ item_id: ins.id, author_id: C.me.id, kind: 'created', body: 'Created from ' + (m.meta.title || 'meeting') + (m.meta.date ? ', ' + A.fmtDate(m.meta.date) : '') }));
          await q(sb.from('item_assignees').insert(wantA.map(a => ({ item_id: ins.id, person_id: a }))));
          m.sync[it.id] = { trackerId: ins.id, sent: { ...want, assignees: wantA } };
          continue;
        }
        // Already in the to-do list: change only what nobody has edited there since it was sent.
        const sent = (s && s.sent) || {}, next = {}, patch = {}; let kept = false;
        for (const f of ['title', 'decision', 'due_date', 'agenda_item']) {
          if (!(f in sent) || norm(ex[f]) === norm(sent[f])) { if (norm(ex[f]) !== norm(want[f])) patch[f] = want[f]; next[f] = want[f]; }
          else { next[f] = sent[f]; kept = true; }
        }
        if (Object.keys(patch).length) await q(sb.from('items').update(patch).eq('id', ex.id));
        const curA = (await q(sb.from('item_assignees').select('person_id').eq('item_id', ex.id))).map(a => a.person_id).sort();
        if (!sent.assignees || sameSet(curA, sent.assignees)) {
          if (!sameSet(curA, wantA)) {
            await q(sb.from('item_assignees').delete().eq('item_id', ex.id));
            await q(sb.from('item_assignees').insert(wantA.map(a => ({ item_id: ex.id, person_id: a }))));
          }
          next.assignees = wantA;
        } else { next.assignees = sent.assignees; kept = true; }
        m.sync[it.id] = { trackerId: ex.id, sent: next, edited: kept };
      }
      // Decisions list: replaced by this meeting's decisions (a meeting with none leaves it alone).
      const entries = m.items.filter(i => (i.decision || '').trim()).map(i => ({ title: (i.title || 'Agenda item').trim(), decision: i.decision.trim() }));
      if (entries.length) {
        const { error } = await sb.rpc('publish_decisions', { p_key: m.id, p_title: m.meta.title || 'Meeting', p_date: m.meta.date || null, p_started: m.startedAt, p_entries: entries });
        if (error) throw error;
      }
      m.decisionsSent = entries.length;
    } catch (e) { failed = e.message || 'connection problem'; }
    syncing = false; if (D) { M().syncError = failed; save(); renderDoneSafe(); }
  }
  function renderDoneSafe() { if (active && D && M().phase === 'done') renderDone(); }

  function renderDone() {
    const m = M();
    const fus = followUps();
    const kept = Object.entries(m.sync).filter(([, s]) => s.kept).map(([id, s]) => ({ s, it: m.items.find(i => i.id === id) }));
    const rowFor = it => {
      const s = m.sync[it.id];
      const who = it.assignees.map(personName).join(', ');
      let right;
      if (!it.assignees.length) right = `<button class="btn sm" style="background:var(--amber-soft);color:var(--amber)" data-pick="${it.id}">${I('flag', 'i', 14)}Pick someone</button>`;
      else if (syncing) right = '<span class="state">Sending…</span>';
      else if (s && s.gone) right = '<span class="state warn">Deleted in the to-do list</span>';
      else if (s) right = '<span class="state">Sent</span>';
      else right = '<span class="state warn">Not sent</span>';
      return `<div class="sent"><span class="avatar">${esc(it.assignees.length ? A.initials(personName(it.assignees[0])) : '?')}</span>
        <span class="tx"><b>${esc(it.task || it.title || 'Untitled')}</b><span>${it.assignees.length ? esc(who) : '<span class="amber-text">Nobody assigned</span>'} · ${it.due ? 'due ' + esc(A.fmtDate(it.due)) : '<span class="amber-text">No due date</span>'}</span>
        ${s && s.edited ? '<span>Changes made in the to-do list were kept.</span>' : ''}</span>
        ${!it.due && it.assignees.length ? `<label class="sr" for="d_${it.id}">Due date</label><input type="date" id="d_${it.id}" data-due="${it.id}">` : ''}${right}</div>`;
    };
    const status = m.syncError ? `<p class="note-s" style="margin:6px 0 10px"><span class="amber-text">Couldn’t send: ${esc(m.syncError)}</span> <button class="btn sm" id="retry">Try again</button></p>` : '';
    root.innerHTML = `<div class="wrapup">
      <div class="backbar" style="padding-top:0"><a href="#" id="homeLink">${I('back')}Home</a></div>
      <div class="hd"><div><div class="eyebrow2">${esc(m.meta.title || 'Meeting')} · ${esc(A.fmtDate(m.meta.date))} · Start ${esc(m.meta.startTime ? A.fmtClock(m.meta.startTime) : A.fmtTime(m.startedAt))} · Closing prayer ${esc(A.fmtTime(m.endedAt))}</div><h1>Meeting ended</h1></div>
        <button class="btn white" id="backMtg">Back to meeting</button></div>
      <div class="cols">
        <section class="card"><div class="row" style="justify-content:space-between;margin-bottom:6px"><h2 style="margin:0;font-size:18px">Sent to tracker</h2><span class="muted" style="font-size:14px">${fus.length} follow-up${fus.length === 1 ? '' : 's'}</span></div>
          ${status}
          ${fus.length ? fus.map(rowFor).join('') : '<p class="muted">No items were marked as needing follow-up.</p>'}
          ${kept.map(({ it, s }) => `<p class="note-s"><span class="amber-text">Kept in the to-do list:</span> “${esc((it && (it.task || it.title)) || 'an item')}” no longer needs follow-up here, but it has updates, so it wasn’t deleted. Delete it from the to-do list if it’s done with.</p>`).join('')}
          ${!syncing && !m.syncError && m.decisionsSent ? `<p class="note-s">${m.decisionsSent} decision${m.decisionsSent === 1 ? '' : 's'} now on the group’s Decisions list.</p>` : ''}</section>
        <section class="card mins"><h2 style="margin:0 0 4px;font-size:18px">Minutes</h2>
          <button class="btn soft block" id="pdfPrev">Preview</button>
          <button class="btn primary block" id="pdf">${I('download')}Download PDF</button>
          ${smart() ? `<button class="btn soft block" id="pdfAI">${I('download')}Polished minutes PDF</button>` : ''}
          <button class="btn block" id="saveFile">${I('save')}Save a copy</button>
          <button class="btn ghost danger block" id="newMtg">Start a new meeting</button></section>
      </div></div>`;
    on('homeLink', e => { e.preventDefault(); C.goHome(); });
    on('backMtg', () => { m.phase = 'meeting'; m.endedAt = null; save(); render(); startLive(); });
    on('retry', syncTracker);
    on('pdf', () => exportPDF(false));
    on('pdfPrev', previewPDF);
    on('pdfAI', () => exportPDF(true));
    on('saveFile', saveMeetingFile);
    on('newMtg', async () => {
      if (!m.exported && !confirm('Start a new meeting? This clears the current one from this device. Download the PDF or save a copy first if you need it.')) return;
      D.meeting = freshMeeting(); D.agendaDraft = ''; pendingFile = null; await saveNow(); render(); window.scrollTo(0, 0);
    });
    root.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { const it = m.items.find(x => x.id === b.dataset.pick); pickPeople(it.assignees, ids => { it.assignees = ids; save(); syncTracker(); }); });
    root.querySelectorAll('[data-due]').forEach(inp => inp.onchange = () => { const it = m.items.find(x => x.id === inp.dataset.due); it.due = inp.value; save(); syncTracker(); });
  }

  /* ---------- PDF ---------- */
  const pdfStyle = () => D.settings.pdfStyle || 'modern';
  function pdfModel() {
    const m = M();
    return {
      meta: m.meta, startedAt: m.startedAt, endedAt: m.endedAt, summary: '',
      present: m.present.map(personName),
      items: m.items.map(it => ({ title: it.title, detail: it.detail, discussion: it.notes, decision: it.decision, followUp: it.followUp, task: it.task, assignees: it.assignees.map(personName), due: it.due, openedAt: it.openedAt }))
    };
  }
  async function exportPDF(ai) {
    try { await A.loadScript(JSPDF); } catch (e) { return A.toast('The PDF tool didn’t load. Connect to the internet and try again.'); }
    const m = M();
    const model = pdfModel();
    if (ai) {
      if (!smart()) return;
      busy('Polishing the minutes…');
      try {
        const payload = model.items.map(i => ({ title: i.title, detail: i.detail, notes: i.discussion, decision: i.decision }));
        const out = parseJSON(await callClaude([{ type: 'text', text: `Rewrite these meeting notes as easy-to-read minutes. Return JSON only, in this shape:
{"summary":"2-4 sentence overview of what the meeting covered and decided","items":[{"discussion":"clear, concise prose; empty if no notes","decision":"clear statement of the decision; empty if none"}]}
Keep exactly one entry per agenda item, in the same order (${payload.length} items). Fix spelling, grammar and shorthand, but never add facts, names, numbers or decisions that aren't in the notes. Third person, past tense.

${JSON.stringify({ meeting: m.meta.title, items: payload })}` }], 'You turn raw meeting notes into clear, concise, accurate minutes. Respond with JSON only.', 8000));
        model.summary = out.summary || '';
        model.items = model.items.map((it, i) => { const a = (out.items || [])[i] || {}; return { ...it, discussion: typeof a.discussion === 'string' ? a.discussion : it.discussion, decision: typeof a.decision === 'string' ? a.decision : it.decision }; });
        unbusy();
      } catch (e) { unbusy(); return A.toast(e.message); }
    }
    const name = ((m.meta.date || A.todayISO()) + ' ' + (m.meta.title || 'meeting')).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + (ai ? '-minutes.pdf' : '-notes.pdf');
    m.exported = true; save();
    A.shareOrDownload(window.buildMinutesPDF(model, pdfStyle()).output('blob'), name, 'application/pdf');
  }

  /* Preview: the real PDF pages, drawn with PDF.js (Chrome on Android can't show a PDF inside a page).
     The worker is fetched as text and started from a blob so it also works offline once cached. */
  let workerUrl = null;
  async function loadPdfJs() {
    await Promise.all([A.loadScript(JSPDF), A.loadScript(PDFJS)]);
    if (!workerUrl) {
      const res = await fetch(PDFJS_WORKER); if (!res.ok) throw new Error('needs an internet connection');
      workerUrl = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
    }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  async function previewPDF() {
    busy('Making the preview…');
    try { await loadPdfJs(); } catch (e) { unbusy(); return A.toast('The preview didn’t load. Connect to the internet and try again.'); }
    unbusy();
    dlg.classList.add('preview');
    dlg.innerHTML = `<div class="pv-h"><h2>Preview</h2><div class="seg" role="tablist" aria-label="Minutes style">${(window.PDF_STYLES || []).map(([v, l]) => `<button role="tab" data-style="${v}" aria-selected="${v === pdfStyle()}">${l}</button>`).join('')}</div></div>
      <div class="pv-pages" id="pvPages"></div>
      <div class="dlg-actions"><button class="btn" id="pvClose">Close</button><button class="btn primary" id="pvDl">${I('download')}Download PDF</button></div>`;
    const close = () => { dlg.close(); dlg.classList.remove('preview'); };
    dlg.onclose = () => dlg.classList.remove('preview');
    dlg.showModal();
    on('pvClose', close);
    on('pvDl', () => { close(); exportPDF(false); });
    dlg.querySelectorAll('[data-style]').forEach(b => b.onclick = () => {
      D.settings.pdfStyle = b.dataset.style; save();
      dlg.querySelectorAll('[data-style]').forEach(x => x.setAttribute('aria-selected', x === b));
      drawPreview();
    });
    drawPreview();
  }
  let drawSeq = 0;
  async function drawPreview() {
    const box = document.getElementById('pvPages'); if (!box) return;
    const seq = ++drawSeq;
    try {
      const data = window.buildMinutesPDF(pdfModel(), pdfStyle()).output('arraybuffer');
      const pdf = await window.pdfjsLib.getDocument({ data }).promise;
      const canvases = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const width = Math.max(320, box.clientWidth - 2);
        const vp = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width * (window.devicePixelRatio || 1) });
        const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        c.setAttribute('aria-label', 'Page ' + n + ' of ' + pdf.numPages);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        canvases.push(c);
      }
      if (seq !== drawSeq) return;
      box.replaceChildren(...canvases);
    } catch (e) { if (seq === drawSeq) box.innerHTML = '<p class="muted">Couldn’t draw the preview. Download the PDF instead.</p>'; }
  }

  /* ---------- meeting files ---------- */
  async function saveMeetingFile() {
    const m = M();
    const box = Vault.exportFile({ meeting: m, cache: D.cache });
    const name = ((m.meta.date || A.todayISO()) + ' ' + (m.meta.title || 'meeting')).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.minutes.json';
    m.exported = true; save();
    A.shareOrDownload(new Blob([JSON.stringify(box)], { type: 'application/json' }), name, 'application/json');
  }
  document.getElementById('openFile').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f || !D) return;
    try {
      const box = JSON.parse(await f.text());
      let data;
      try { data = await Vault.importFile(box); }
      catch (err) {
        if (err.message !== 'needpass') throw err;
        const pass = prompt('This copy was saved with a passphrase. Enter it:'); if (!pass) return;
        data = await Vault.importFile(box, pass);
      }
      if (!data || !data.meeting) throw new Error('That isn’t a meeting file');
      if (!confirm(`Open “${data.meeting.meta.title || 'meeting'}”? It replaces the meeting on screen.`)) return;
      D.meeting = data.meeting; D.meeting.exported = true;
      if (data.cache && data.cache.people) {
        const known = new Set((D.cache.people || []).map(p => p.id));
        data.cache.people.forEach(p => { if (!known.has(p.id)) (D.cache.people = D.cache.people || []).push(p); });
      }
      await saveNow(); render(); A.toast('Meeting opened');
      if (M().phase === 'done') syncTracker();
    } catch (err) { A.toast(err.message === 'needpass' ? 'Wrong passphrase' : err.message || 'Couldn’t open that file'); }
  };

  /* ---------- settings ---------- */
  function settingsDialog() {
    dlg.innerHTML = `<h2>Settings</h2>
      <div class="field"><label class="label" for="sKey">Anthropic key</label><input class="input" id="sKey" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(D.settings.apiKey)}">
        <p class="note-s">Saved on this device. Lets Read agenda handle PDFs and photos, and adds Polished minutes PDF. Optional.</p></div>
      <div class="field"><label class="label" for="sModel">Model</label><select class="select" id="sModel">${MODELS.map(([v, l]) => `<option value="${v}" ${v === D.settings.model ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label class="label" for="sStyle">Minutes style</label><select class="select" id="sStyle">${(window.PDF_STYLES || []).map(([v, l]) => `<option value="${v}" ${v === pdfStyle() ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <p class="note-s">How the minutes PDF looks. Preview it on the wrap-up.</p></div>
      <div class="dlg-actions" style="justify-content:space-between"><button class="btn ghost danger" id="sWipe">Erase meeting notes on this device</button><span class="row"><button class="btn" id="sCancel">Cancel</button><button class="btn primary" id="sSave">Save</button></span></div>`;
    dlg.showModal();
    on('sCancel', () => dlg.close());
    on('sSave', () => { D.settings.apiKey = document.getElementById('sKey').value.trim(); D.settings.model = document.getElementById('sModel').value; D.settings.pdfStyle = document.getElementById('sStyle').value; save(); dlg.close(); render(); A.toast('Saved'); });
    on('sWipe', () => {
      if (!confirm('Erase your meeting notes and settings from this device? Items already in the to-do list stay there.')) return;
      Vault.erase(); try { localStorage.removeItem(markerKey()); } catch (e) {}
      D = blank(); store(); dlg.close(); render();
    });
  }

  /* ---------- screen wake lock during meetings ---------- */
  let wl = null;
  async function keepAwake(onState) {
    try {
      if (onState && 'wakeLock' in navigator && !wl) { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); }
      else if (!onState && wl) { await wl.release(); wl = null; }
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && active && D) saveNow();   // the device may close the app in the background
    if (document.visibilityState === 'visible' && active && D && M().phase === 'meeting') keepAwake(true);
  });
  window.addEventListener('pagehide', () => { if (active && D) saveNow(); });
  window.addEventListener('online', () => { if (active && D && M().phase === 'done') syncTracker(); if (active && D && M().phase === 'meeting') startLive(); });

  /* A meeting ended without a connection: send its follow-ups and decisions as soon as the app is online again,
     without waiting for someone to reopen the wrap-up. Safe to repeat: sending never duplicates. */
  function unsent(m) {
    return !!m.syncError || m.decisionsSent == null
      || (m.items || []).some(i => i.followUp && (i.assignees || []).length && !(m.sync || {})[i.id]);
  }
  async function sendPending(ctx) {
    if (active || syncing || background || !navigator.onLine) return;
    const data = Vault.load();
    if (!data || !data.meeting || data.meeting.phase !== 'done' || !unsent(data.meeting)) return;
    C = ctx; D = data; background = true;
    try { await syncTracker(); }
    finally {
      background = false;
      if (!active && D) {
        clearTimeout(saveT); store();
        const ok = !D.meeting.syncError; D = null;
        if (ok) { A.toast('Follow-ups from the last meeting were sent'); if (ctx.reload) ctx.reload(); }
      }
    }
  }

  window.Meeting = { open, close, marker, sendPending, intent: x => { intent = x; } };
})();
