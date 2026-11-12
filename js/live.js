/* Live view: other admins follow a meeting while it runs. The note-taker's device broadcasts the agenda
   and notes over a private Realtime channel; nothing is stored except the "Live now" line (meeting name
   and note-taker), which is deleted when the meeting ends. Viewers are read-only and browse freely;
   they are never shown which item the note-taker is on. */
(function () {
  const A = window.App, sb = A.sb, esc = A.esc, I = window.ICON;
  const root = document.getElementById('app');

  async function setAuth() {
    const s = await A.getSession();
    if (s && sb.realtime && sb.realtime.setAuth) { try { await sb.realtime.setAuth(s.access_token); } catch (e) {} }
  }
  const channel = id => sb.channel('live:' + id, { config: { private: true, broadcast: { self: false } } });

  /* ================= note-taker ================= */
  let B = null;   // { info, row, ch, snapFn, timer, hb }
  async function broadcast(info, snapFn) {
    if (!sb) return;
    if (B) { B.snapFn = snapFn; push(snapFn()); return; }
    B = { info, snapFn, row: null, ch: null, timer: null, hb: null, starting: true };
    try {
      await setAuth();
      const now = new Date().toISOString();
      const { data, error } = await sb.from('live_meetings').upsert({ group_id: info.group_id, person_id: info.person_id,
        meeting_title: info.title, taker_name: info.taker, last_seen_at: now }, { onConflict: 'person_id' }).select('*').single();
      if (error || !B) { B = null; return; }
      B.row = data;
      B.ch = channel(data.id);
      B.ch.on('broadcast', { event: 'hello' }, () => { if (B) send('snap', B.snapFn()); });
      B.ch.subscribe(st => { if (st === 'SUBSCRIBED' && B) send('snap', B.snapFn()); });
      B.hb = setInterval(heartbeat, 60000);
      B.starting = false;
    } catch (e) { B = null; }
  }
  function send(event, payload) {
    if (!B || !B.ch) return;
    try { B.ch.send({ type: 'broadcast', event, payload }); } catch (e) {}
  }
  function push(snap) {
    if (!B) return;
    clearTimeout(B.timer);
    B.timer = setTimeout(() => {
      if (!B || !B.row) return;
      send('snap', snap);
      if (snap.title && snap.title !== B.row.meeting_title) {
        B.row.meeting_title = snap.title;
        sb.from('live_meetings').update({ meeting_title: snap.title, last_seen_at: new Date().toISOString() }).eq('id', B.row.id).then(() => {});
      }
    }, 1200);
  }
  function heartbeat() {
    if (!B || !B.row || !navigator.onLine) return;
    sb.from('live_meetings').update({ last_seen_at: new Date().toISOString() }).eq('id', B.row.id).then(() => {});
  }
  function stopB() {
    if (!B) return null;
    const b = B; B = null;
    clearTimeout(b.timer); clearInterval(b.hb);
    return b;
  }
  /* Leaving the meeting screen without ending: the card goes stale on its own after ~10 minutes. */
  function pause() { const b = stopB(); if (b && b.ch) sb.removeChannel(b.ch); }
  /* End meeting: tell viewers, remove the Live now line. */
  async function end() {
    const b = stopB(); if (!b) return;
    if (b.ch) { try { await b.ch.send({ type: 'broadcast', event: 'ended', payload: {} }); } catch (e) {} sb.removeChannel(b.ch); }
    if (b.row) await sb.from('live_meetings').delete().eq('id', b.row.id);
    else if (b.info) await sb.from('live_meetings').delete().eq('person_id', b.info.person_id);
  }

  /* ================= viewer ================= */
  let V = null;   // { id, row, ch, snap, sel, mode }
  const wide = () => window.matchMedia('(min-width: 700px)').matches;
  async function view(id, ctx) {
    if (V && V.id === id) return renderView();
    leave();
    V = { id, row: null, ch: null, snap: null, sel: 0, mode: 'list' };
    renderView();
    const { data } = await sb.from('live_meetings').select('*').eq('id', id).maybeSingle();
    if (!V || V.id !== id) return;
    if (!data) { leave(); A.toast('That meeting has ended.'); ctx.goHome(); return; }
    V.row = data;
    await setAuth();
    if (!V || V.id !== id) return;
    V.ch = channel(id);
    V.ch.on('broadcast', { event: 'snap' }, ({ payload }) => { if (!V) return; V.snap = payload; renderView(); })
      .on('broadcast', { event: 'ended' }, () => { if (!V) return; leave(); A.toast('The meeting ended.'); ctx.goHome(); })
      .subscribe(st => { if (st === 'SUBSCRIBED' && V && V.ch) V.ch.send({ type: 'broadcast', event: 'hello', payload: {} }); });
    renderView();
  }
  function leave() { if (!V) return; const v = V; V = null; if (v.ch) sb.removeChannel(v.ch); }

  const items = () => (V.snap && V.snap.items) || [];
  function itemBody(x) {
    if (!x) return `<p class="muted" style="margin:0">No notes yet.</p>`;
    const any = (x.notes || '').trim() || (x.decision || '').trim() || x.followUp;
    return `${(x.notes || '').trim() ? `<div class="ro-box"><div class="ro-k">Notes</div><div class="ro-v">${esc(x.notes.trim())}</div></div>` : ''}
      ${(x.decision || '').trim() ? `<div class="ro-box teal"><div class="ro-k">Decision</div><div class="ro-v" style="font-weight:600">${esc(x.decision.trim())}</div></div>` : ''}
      ${x.followUp ? `<div class="ro-box teal"><div class="ro-k">Follow-up</div><div class="ro-v" style="font-weight:600">${esc(x.task || x.title)}</div>
        <div class="muted" style="font-size:14px;margin-top:4px">${esc((x.who || []).join(', ') || 'Nobody assigned yet')} · ${x.due ? 'due ' + esc(A.fmtDate(x.due)) : 'no due date'}</div></div>` : ''}
      ${any ? '' : `<p class="muted" style="margin:0">No notes yet.</p>`}`;
  }
  function renderView() {
    if (!V) return;
    const key = V.mode + ':' + V.sel, sc = root.querySelector('.main .scroll');
    const keepScroll = V.lastKey === key ? { inner: sc ? sc.scrollTop : 0, page: window.scrollY } : null;
    V.lastKey = key;
    draw();
    if (keepScroll) { const s2 = root.querySelector('.main .scroll'); if (s2) s2.scrollTop = keepScroll.inner; window.scrollTo(0, keepScroll.page); }
  }
  function draw() {
    const list = items(), n = list.length;
    V.sel = Math.max(0, Math.min(V.sel, Math.max(0, n - 1)));
    const x = list[V.sel];
    const title = (V.snap && V.snap.title) || (V.row && V.row.meeting_title) || '';
    const taker = V.row ? V.row.taker_name + ' taking notes' : '';
    const nav = `<button class="btn" id="lvPrev" ${V.sel === 0 ? 'disabled' : ''}>Previous</button><span class="grow" style="flex:1"></span><button class="btn" id="lvNext" ${V.sel >= n - 1 ? 'disabled' : ''}>Next</button>`;
    const head = n ? `<div><div class="eyebrow2">Item ${V.sel + 1} of ${n}</div><div class="ttl2" style="font-size:28px;font-weight:700;line-height:1.25;overflow-wrap:anywhere">${esc(x.title || 'Untitled item')}</div>${x.detail ? `<div class="muted" style="margin-top:4px;white-space:pre-line">${esc(x.detail)}</div>` : ''}</div>` : '';
    if (wide()) {
      root.innerHTML = `<div class="mtg">
        <nav class="rail" aria-label="Agenda">
          <div class="live-h"><span class="live-dot">Live now</span><span class="nm">${esc(title)}</span><span class="by">${esc(taker)}</span></div>
          <div class="agenda">${list.map((it, i) => `<button class="ag" data-sel="${i}" aria-current="${i === V.sel}"><span class="no">${i + 1}</span><span class="lbl">${esc(it.title || 'Untitled item')}</span></button>`).join('')}</div>
          <a class="btn ghost" href="#" style="justify-content:flex-start">Leave</a>
        </nav>
        <main class="main"><div class="scroll">${head}${n ? itemBody(x) : ''}</div>${n ? `<div class="foot">${nav}</div>` : ''}</main></div>`;
    } else if (V.mode === 'item' && n) {
      root.innerHTML = `<div class="lv-phone">
        <div class="lv-head"><div class="tx"><span class="live-dot">Live now</span><span class="nm">${esc(title)}</span><span class="by">${esc(taker)}</span></div><a class="btn sm white" href="#">Leave</a></div>
        <button class="btn link" id="lvBack" style="align-self:flex-start;padding:0">${I('back', 'i', 18)}Agenda</button>
        <div class="lv-item">${head.replace('font-size:28px', 'font-size:22px')}${itemBody(x)}</div>
        <div class="lv-nav">${nav}</div></div>`;
    } else {
      root.innerHTML = `<div class="lv-phone">
        <div class="lv-head"><div class="tx"><span class="live-dot">Live now</span><span class="nm">${esc(title)}</span><span class="by">${esc(taker)}</span></div><a class="btn sm white" href="#">Leave</a></div>
        ${n ? `<div class="sec" style="padding:4px 4px 0">Agenda</div><div class="lv-list">${list.map((it, i) => `<button data-sel="${i}"><span class="no">${i + 1}</span><span class="lbl">${esc(it.title || 'Untitled item')}</span>${I('right', 'i', 18)}</button>`).join('')}</div>` : ''}
      </div>`;
    }
    root.querySelectorAll('[data-sel]').forEach(b => b.onclick = () => { V.sel = +b.dataset.sel; V.mode = 'item'; renderView(); });
    const p = document.getElementById('lvPrev'); if (p) p.onclick = () => { V.sel--; renderView(); };
    const nx = document.getElementById('lvNext'); if (nx) nx.onclick = () => { V.sel++; renderView(); };
    const bk = document.getElementById('lvBack'); if (bk) bk.onclick = () => { V.mode = 'list'; renderView(); };
  }

  window.Live = { broadcast, push, pause, end, view, leave };
})();
