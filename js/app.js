/* The app at the one address: sign-in, joining or starting a group, the to-do list, Decisions,
   Next agenda notes, settings, people and join requests, and the Admin home.
   The meeting screens live in meeting.js and the read-only live view in live.js. */
(function () {
  const A = window.App, sb = A.sb, esc = A.esc, I = window.ICON, q = A.q;
  const root = document.getElementById('app');
  const dlg = document.getElementById('dlg');
  const STALE_MS = 10 * 60 * 1000;   // a Live now card disappears after 10 minutes without updates

  const S = {
    me: null, people: [], items: [], assignees: {}, updates: {}, decisions: null, notes: [], live: [], requests: [], contacts: {},
    tab: 'todo', filter: 'open', person: '', loadedAt: null, loaded: false
  };
  window.Store = S;
  try { const p = JSON.parse(localStorage.getItem('mt_prefs') || '{}'); S.tab = p.tab || 'todo'; S.filter = p.filter || 'open'; S.person = p.person || ''; } catch (e) {}
  const savePrefs = () => { try { localStorage.setItem('mt_prefs', JSON.stringify({ tab: S.tab, filter: S.filter, person: S.person })); } catch (e) {} };

  const isAdmin = () => !!(S.me && S.me.person && S.me.person.is_admin);
  const myId = () => S.me && S.me.person && S.me.person.id;
  const wide = () => window.matchMedia('(min-width: 700px)').matches;
  const personOf = id => S.people.find(p => p.id === id);
  const nameOf = id => (personOf(id) || {}).name || 'Former member';
  const assigneesOf = it => S.assignees[it.id] || [];
  const canClose = it => isAdmin() || assigneesOf(it).includes(myId());
  const latestNote = it => (S.updates[it.id] || []).find(u => u.kind === 'note');
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  const liveNow = () => S.live.filter(l => l.person_id !== myId() && Date.now() - new Date(l.last_seen_at) < STALE_MS);
  const nav = h => { if (location.hash.slice(1) === h) render(); else location.hash = h; };

  /* ================= gates ================= */
  function gate(icon, body) {
    root.innerHTML = `<div class="gate"><div class="card"><div class="badge">${I(icon, 'i', 28)}</div>${body}</div></div>`;
  }
  function googleMark() {
    return '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#fff" d="M44.5 20H24v8.5h11.8C34.7 33.9 30.1 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 11.8 2 2 11.8 2 24s9.8 22 22 22c11 0 21-8 21-22 0-1.3-.2-2.7-.5-4z"/></svg>';
  }
  function gateSignIn() {
    gate('check', `<h1>Minutes HQ</h1><p>Follow-ups from your group’s meetings, in one list.</p>
      <button class="btn primary block" id="gSignIn">${googleMark()}Sign in with Google</button>`);
    root.querySelector('.gate').insertAdjacentHTML('beforeend', `<div class="legal-links"><a href="privacy.html">Privacy</a> · <a href="terms.html">Terms</a></div>`);
    on('gSignIn', A.signIn);
  }
  function gateMsg(title, text) {
    gate('people', `<h1>${esc(title)}</h1><p>${text}</p><button class="btn primary block" id="gRetry">Try again</button>`);
    on('gRetry', () => start());
  }
  const accountFoot = () => `<div class="bottom">Signed in as ${esc(S.me.email)}<button class="btn link" id="gOut">Use a different account</button></div>`;
  async function signOutNow() { Live.leave(); Meeting.close(); await A.signOut(); S.me = null; location.hash = ''; start(); }

  function renderJoin(err) {
    stopTimers();
    const pre = /join=([A-Za-z0-9 -]+)/.exec(decodeURIComponent(location.hash)) || [];
    root.innerHTML = `<div class="form-page">
      <div><h1>Join your group</h1><p class="lead">Ask your group’s admin for the code.</p></div>
      <form class="card" id="joinForm">
        <div><label class="label" for="jCode">Group code</label><input class="input code-input" id="jCode" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc((pre[1] || '').toUpperCase())}" required></div>
        <div><label class="label" for="jName">Your full name</label><input class="input" id="jName" autocomplete="name" value="${esc(sessionName())}" required><span class="hint">As the group knows you. Your admin confirms it.</span></div>
        ${err ? `<div class="amber-text" role="alert">${esc(err)}</div>` : ''}
        <button class="btn primary block" type="submit">Request to join</button>
      </form>
      <div class="bottom"><span>Running meetings for a new group?</span><button class="btn link" id="toStart">Start a group</button></div>
      ${accountFoot()}
    </div>`;
    document.getElementById('joinForm').onsubmit = async e => {
      e.preventDefault();
      const code = document.getElementById('jCode').value.trim(), name = document.getElementById('jName').value.trim();
      const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
      const { error } = await sb.rpc('request_join', { p_code: code, p_full_name: name });
      if (error) return renderJoin(error.message);
      sb.functions.invoke('notify', { body: { type: 'join' } }).catch(() => {});
      if (/join=/.test(location.hash)) history.replaceState(null, '', location.pathname);
      start();
    };
    on('toStart', renderStartGroup);
    on('gOut', signOutNow);
  }
  function sessionName() {
    const u = S.me && S.me.session && S.me.session.user; const m = (u && u.user_metadata) || {};
    return m.full_name || m.name || '';
  }
  function renderStartGroup(err) {
    root.innerHTML = `<div class="form-page">
      <div><h1>Start a group</h1><p class="lead">You’ll be its admin. Others join with a code you share, and you approve them.</p></div>
      <form class="card" id="startForm">
        <div><label class="label" for="sgName">Group name</label><input class="input" id="sgName" placeholder="e.g. Board" required maxlength="80"></div>
        <div><label class="label" for="sgMe">Your name as the group knows you</label><input class="input" id="sgMe" value="${esc(sessionName())}" required maxlength="80"></div>
        ${typeof err === 'string' ? `<div class="amber-text" role="alert">${esc(err)}</div>` : ''}
        <button class="btn primary block" type="submit">Start group</button>
      </form>
      <div class="bottom"><button class="btn link" id="toJoin">${I('back', 'i', 18)}Join a group instead</button></div>
    </div>`;
    document.getElementById('startForm').onsubmit = async e => {
      e.preventDefault();
      const tz = (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || '';
      const { error } = await sb.rpc('start_group', { p_name: document.getElementById('sgName').value.trim(), p_full_name: document.getElementById('sgMe').value.trim(), p_time_zone: tz });
      if (error) return renderStartGroup(error.message);
      location.hash = ''; start();
    };
    on('toJoin', () => renderJoin());
  }
  function renderPending() {
    const r = S.me.request;
    gate('clock', `<h1>Waiting for approval</h1>
      <p>Your request to join <b style="color:var(--ink)">${esc(r.group_name)}</b> went to the group’s admin. You’ll see your items as soon as it’s approved.</p>
      <div class="kv"><span class="k">Requested as</span><span class="v">${esc(r.full_name)}</span></div>
      <button class="btn soft block" id="pCheck">Check again</button>
      <button class="btn ghost block" id="pCancel" style="color:var(--muted)">Cancel request</button>`);
    root.querySelector('.gate').insertAdjacentHTML('beforeend', `<div class="gate-foot">${esc(S.me.email)}<button class="btn link" id="gOut">Use a different account</button></div>`);
    on('pCheck', () => start());
    on('pCancel', async () => { const { error } = await sb.rpc('cancel_request'); if (error) return A.toast(error.message); start(); });
    on('gOut', signOutNow);
    stopTimers(); timers.pending = setInterval(() => { if (document.visibilityState === 'visible') start(); }, 30000);
  }

  /* ================= data ================= */
  async function load() {
    const [items, asg, ups, people, dec, priv] = await Promise.all([
      q(sb.from('items').select('*')),
      q(sb.from('item_assignees').select('*')),
      q(sb.from('item_updates').select('*').order('created_at', { ascending: false })),
      q(sb.from('people').select('id,name,user_id,is_admin')),
      q(sb.from('decision_lists').select('*').maybeSingle()),
      q(sb.from('person_private').select('person_id,email,reminders'))
    ]);
    S.items = items; S.people = people.sort((a, b) => a.name.localeCompare(b.name)); S.decisions = dec;
    S.assignees = {}; asg.forEach(a => (S.assignees[a.item_id] = S.assignees[a.item_id] || []).push(a.person_id));
    S.updates = {}; ups.forEach(u => (S.updates[u.item_id] = S.updates[u.item_id] || []).push(u));
    S.contacts = {}; priv.forEach(c => { S.contacts[c.person_id] = c; });
    if (isAdmin()) {
      const [notes, live, reqs] = await Promise.all([
        q(sb.from('agenda_notes').select('*').order('created_at', { ascending: false })),
        q(sb.from('live_meetings').select('*')),
        q(sb.from('join_requests').select('*').order('created_at'))
      ]);
      S.notes = notes; S.live = live; S.requests = reqs;
    } else { S.notes = []; S.live = []; S.requests = []; }
    S.loadedAt = new Date(); S.loaded = true;
  }

  let starting = null;
  function start() {
    if (starting) return starting;
    starting = (async () => {
      if (!A.configured) return gateMsg('Almost ready', 'This app isn’t connected to its database yet. Fill in <b>js/config.js</b> as described in the README.');
      let r;
      try { r = await A.whoami(); } catch (e) { return gateMsg('Couldn’t load', esc(e.message || 'Check your connection and try again.')); }
      if (!r.session) { S.me = null; stopTimers(); return gateSignIn(); }
      S.me = r;
      if (!r.person) return r.request ? renderPending() : renderJoin();
      Vault.use(r.uid);
      if (!r.offline) { try { await load(); } catch (e) { S.loaded = false; } }
      render(); startTimers();
    })().finally(() => { starting = null; });
    return starting;
  }
  async function refresh(quiet) {
    if (!S.me || !S.me.person) return;
    try {
      const r = await A.whoami();
      if (!r.person || r.person.is_admin !== S.me.person.is_admin) return start();
      S.me = r; await load();
      if (!busyTyping()) render();
      if (!quiet) A.toast('Up to date');
    } catch (e) { if (!quiet) A.toast('Couldn’t refresh: ' + e.message); }
  }
  const busyTyping = () => dlg.open || (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && document.activeElement.value);

  const timers = {};
  function stopTimers() { Object.keys(timers).forEach(k => { clearInterval(timers[k]); delete timers[k]; }); }
  function startTimers() {
    stopTimers();
    timers.poll = setInterval(() => {
      const v = route().v;
      if (document.visibilityState === 'visible' && (v === '' || v === 'people') && navigator.onLine) refresh(true);
    }, 60000);
  }

  /* ================= routing ================= */
  function route() { const h = location.hash.slice(1); const [v, id] = h.split('/'); return { v: v || '', id }; }
  window.addEventListener('hashchange', () => { if (S.me && S.me.person) render(); else if (S.me && /join=/.test(location.hash)) renderJoin(); });

  function ctx() {
    return { uid: S.me.uid, me: S.me.person, group: S.me.group, people: S.people, offline: !!S.me.offline || !S.loaded,
      goHome: () => { location.hash = ''; refresh(true); }, reload: () => refresh(true) };
  }
  function render() {
    if (!S.me || !S.me.person) return;
    const r = route();
    if (r.v !== 'meeting') Meeting.close();
    if (r.v !== 'live') Live.leave();
    if (r.v === 'meeting' && isAdmin()) return Meeting.open(ctx());
    if (r.v === 'live' && isAdmin()) return Live.view(r.id, ctx());
    if (r.v === 'item' && S.items.find(i => i.id === r.id)) return renderDetail(r.id);
    if (r.v === 'new' && isAdmin()) return renderNew();
    if (r.v === 'settings') return renderSettings();
    if (r.v === 'people' && isAdmin()) return renderPeople();
    return isAdmin() && wide() ? renderAdminHome() : renderPhoneHome();
  }
  let lastWide = wide();
  window.addEventListener('resize', () => { if (wide() !== lastWide) { lastWide = wide(); if (S.me && S.me.person && route().v === '') render(); } });

  /* ================= homes ================= */
  function tabs() { return isAdmin() ? [['todo', 'To-do'], ['decisions', 'Decisions'], ['agenda', 'Next agenda']] : [['todo', 'To-do'], ['decisions', 'Decisions']]; }
  function curTab() { return tabs().some(t => t[0] === S.tab) ? S.tab : 'todo'; }
  function segHTML() {
    const t = curTab();
    return `<div class="seg" role="tablist">${tabs().map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${t === k}">${l}</button>`).join('')}</div>`;
  }
  function wireSeg() { root.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; savePrefs(); render(); }); }
  function liveCardSmall(l) {
    return `<a class="live-card" href="#live/${l.id}"><span class="tx"><span class="live-dot">Live now</span><span class="nm">${esc(l.meeting_title)}</span><span class="by">${esc(l.taker_name)} taking notes</span></span><span class="go">Follow along</span></a>`;
  }

  function renderPhoneHome() {
    const t = curTab();
    root.innerHTML = `<div class="wrap"><div class="tabs-bar">${segHTML()}</div>
      ${t === 'todo' && isAdmin() ? liveNow().map(liveCardSmall).join('') : ''}
      <div id="pane"></div></div>`;
    wireSeg();
    renderPane(document.getElementById('pane'), t, false);
  }

  function renderAdminHome() {
    const g = S.me.group || {}, p = S.me.person;
    const mk = Meeting.marker(S.me.uid);
    const going = mk && mk.phase && mk.phase !== 'done' && mk.phase !== 'empty';
    const label = going ? `Continue ${mk.title ? esc(mk.title) : 'meeting'}` : `${I('plus')}Start a meeting`;
    const lv = liveNow();
    root.innerHTML = `<div class="home">
      <div class="home-h"><h1>${esc(g.name || 'Your group')}</h1>
        <a class="hbtn" href="#people">People${S.requests.length ? `<span class="pill amber">${S.requests.length} request${S.requests.length === 1 ? '' : 's'}</span>` : ''}</a>
        <a class="hbtn" href="#settings" aria-label="Settings"><span class="avatar">${esc(A.initials(p.name))}</span>${esc(p.name)}</a></div>
      <div class="home-g">
        <div class="home-l">
          <section class="card meet-card"><h2>Meetings</h2>
            <button class="btn primary lg" id="startMtg">${label}</button>
            ${mk && mk.phase === 'done' ? `<button class="btn link" id="lastWrap" style="align-self:flex-start;padding:0">Last meeting’s wrap-up</button>` : ''}</section>
          ${lv.map(l => `<section class="live-big"><span class="live-dot" style="font-size:13px">Live now</span>
            <div><div class="nm">${esc(l.meeting_title)}</div><div class="by">${esc(l.taker_name)} taking notes · started ${esc(A.fmtTime(l.started_at))}</div></div>
            <a class="btn" href="#live/${l.id}">Follow along</a></section>`).join('')}
        </div>
        <div class="home-r panel">${segHTML()}<div id="pane"></div></div>
      </div></div>`;
    wireSeg();
    on('startMtg', () => { Meeting.intent(going ? 'continue' : 'new'); nav('meeting'); });
    on('lastWrap', () => { Meeting.intent('continue'); nav('meeting'); });
    renderPane(document.getElementById('pane'), curTab(), true);
  }

  function renderPane(el, t, inPanel) {
    if (!S.loaded) { el.innerHTML = `<div class="empty">You’re offline. Your list shows up when you’re back online.</div>`; return; }
    if (t === 'decisions') return renderDecisions(el, inPanel);
    if (t === 'agenda' && isAdmin()) return renderNotes(el, inPanel);
    return renderTodo(el, inPanel);
  }

  /* ================= to-do ================= */
  function dueLabel(it) {
    if (!it.due_date) return '<span class="amber-text">No due date</span>';
    const d = A.daysFromToday(it.due_date);
    if (it.status === 'open' && d < 0) return `<span class="amber-text">Due ${esc(A.fmtDate(it.due_date))}</span>`;
    if (d === 0) return 'Due today';
    if (d === 1) return 'Due tomorrow';
    return 'Due ' + esc(A.fmtDate(it.due_date));
  }
  function whoLabel(it) {
    const ids = assigneesOf(it);
    if (!ids.length) return 'Unassigned';
    return ids.map(id => id === myId() ? 'You' : nameOf(id)).join(', ');
  }
  function card(it) {
    const late = it.status === 'open' && it.due_date && A.daysFromToday(it.due_date) < 0;
    const done = it.status === 'done';
    const note = latestNote(it);
    const can = canClose(it);
    const meeting = it.meeting_title ? ` · ${esc(it.meeting_title)}${it.meeting_date ? ', ' + esc(A.fmtDate(it.meeting_date)) : ''}` : '';
    return `<article class="item${late ? ' late' : ''}${done ? ' is-done' : ''}">
      <button class="tick${done ? ' done' : ''}" data-tick="${it.id}" ${can ? '' : 'disabled'} aria-label="${done ? 'Reopen' : 'Mark done'}: ${esc(it.title)}${can ? '' : ' (only the people assigned can change this)'}"><span></span></button>
      <a class="body" href="#item/${it.id}">
        <span class="t">${esc(it.title)}</span>
        <span class="m">${esc(whoLabel(it))} · ${done ? 'Done ' + esc(A.fmtDate((it.done_at || '').slice(0, 10))) : dueLabel(it)}${meeting}</span>
        ${note && !done ? `<span class="u">${esc(note.body)}</span>` : ''}
      </a></article>`;
  }
  function filtered() {
    let list = S.items.filter(i => S.filter === 'done' ? i.status === 'done' : i.status === 'open');
    if (S.filter === 'mine') list = list.filter(i => assigneesOf(i).includes(myId()));
    else if (S.person) list = list.filter(i => assigneesOf(i).includes(S.person));
    return list;
  }
  function renderTodo(el, inPanel) {
    const list = filtered();
    let body;
    if (S.filter === 'done') {
      list.sort((a, b) => (b.done_at || '').localeCompare(a.done_at || ''));
      body = list.length ? list.slice(0, 100).map(card).join('') : `<div class="empty">Nothing marked done yet.</div>`;
    } else {
      const byDue = (a, b) => (a.due_date || '').localeCompare(b.due_date || '') || a.title.localeCompare(b.title);
      const sec = { overdue: [], week: [], later: [], none: [] };
      list.forEach(i => {
        if (!i.due_date) return sec.none.push(i);
        const d = A.daysFromToday(i.due_date);
        (d < 0 ? sec.overdue : d <= 7 ? sec.week : sec.later).push(i);
      });
      const block = (title, arr, amber) => arr.length ? `<div class="sec${amber ? ' amber' : ''}">${title}</div>${arr.sort(byDue).map(card).join('')}` : '';
      body = block('Overdue', sec.overdue, true) + block('Next 7 days', sec.week) + block('No due date', sec.none, true) + block('Later', sec.later);
      if (!list.length) body = `<div class="empty">${S.filter === 'mine' ? 'Nothing assigned to you right now.' : 'No open items.'}</div>`;
    }
    const chip = (v, label) => `<button class="chip" data-filter="${v}" aria-pressed="${S.filter === v}">${label}</button>`;
    el.innerHTML = `
      ${inPanel ? '' : `<div class="top"><div><h1>Action items</h1><div class="sub">Hi, ${esc(S.me.person.name.split(' ')[0])} · updated ${esc(A.fmtTime(S.loadedAt.toISOString()))}</div></div>
        <div class="acts"><button class="icon-btn" id="refresh" aria-label="Refresh">${I('refresh')}</button><a class="icon-btn" href="#settings" aria-label="Settings">${I('gear')}</a></div></div>`}
      <div class="filters">
        ${chip('open', 'Open')}${chip('mine', 'Mine')}${chip('done', 'Done')}
        ${S.filter !== 'mine' ? `<label class="sr" for="personSel">Show items assigned to</label><select id="personSel"><option value="">Everyone</option>${S.people.map(m => `<option value="${m.id}" ${S.person === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>` : ''}
      </div>
      ${body}
      ${isAdmin() ? `<button class="fab" id="newItem">${I('plus')}New item</button>` : ''}`;
    el.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { S.filter = b.dataset.filter; savePrefs(); renderTodo(el, inPanel); });
    const ps = el.querySelector('#personSel'); if (ps) ps.onchange = () => { S.person = ps.value; savePrefs(); renderTodo(el, inPanel); };
    on('refresh', () => refresh());
    on('newItem', () => nav('new'));
    el.querySelectorAll('[data-tick]').forEach(b => b.onclick = () => toggleDone(b.dataset.tick, true));
  }
  async function toggleDone(id, fromList) {
    const it = S.items.find(i => i.id === id); if (!it || !canClose(it)) return;
    const done = it.status !== 'done';
    const { error } = await sb.rpc('set_item_status', { p_item: id, p_done: done });
    if (error) return A.toast(error.message);
    await refresh(true);
    A.toast(done ? 'Marked done' : 'Reopened');
    if (fromList && done) offerUndo(id);
  }
  function offerUndo(id) {
    const t = document.getElementById('toast'); if (!t) return;
    const b = document.createElement('button'); b.textContent = 'Undo';
    b.style.cssText = 'margin-left:14px;border:0;background:none;color:#7FD6CB;font-weight:700';
    b.onclick = async () => { t.classList.remove('on'); const { error } = await sb.rpc('set_item_status', { p_item: id, p_done: false }); if (error) A.toast(error.message); else refresh(true); };
    t.appendChild(b);
  }

  /* ================= item detail ================= */
  function statusPill(it) {
    if (it.status === 'done') return `<span class="pill teal">${I('check', 'i', 13)}Done ${esc(A.fmtDate((it.done_at || '').slice(0, 10)))}${it.done_by ? ' by ' + esc(nameOf(it.done_by)) : ''}</span>`;
    if (!it.due_date) return '<span class="pill amber">No due date</span>';
    const d = A.daysFromToday(it.due_date);
    if (d < 0) return `<span class="pill amber">Overdue ${-d} day${d === -1 ? '' : 's'}</span>`;
    if (d === 0) return '<span class="pill teal">Due today</span>';
    return `<span class="pill gray">Due in ${d} day${d === 1 ? '' : 's'}</span>`;
  }
  function entryText(u, it) {
    switch (u.kind) {
      case 'created': return { sys: true, t: u.body || (it.meeting_title ? 'Created from ' + it.meeting_title : 'Created') };
      case 'done': return { sys: true, t: 'Marked done' };
      case 'reopened': return { sys: true, t: 'Reopened' };
      default: return { sys: false, t: u.body };
    }
  }
  function renderDetail(id) {
    const it = S.items.find(i => i.id === id);
    const admin = isAdmin();
    const ups = S.updates[id] || [];
    const asg = assigneesOf(it);
    root.innerHTML = `<div class="wrap">
      <div class="backbar"><a href="#">${I('back')}Action items</a></div>
      <div style="padding:0 4px">${statusPill(it)}</div>
      ${admin ? `<label class="sr" for="dTitle">Title</label><textarea id="dTitle" class="textarea dtitle-input" rows="2">${esc(it.title)}</textarea>` : `<h1 class="dtitle">${esc(it.title)}</h1>`}
      <div class="rows">
        <div class="drow"><span class="k">Assigned to</span><span class="v">${asg.length ? esc(asg.map(nameOf).join(', ')) : '<span class="amber-text">Nobody yet</span>'}${admin ? ` <button class="btn sm soft" id="dAsg">Change</button>` : ''}</span></div>
        <div class="drow"><label class="k" for="dDue">Due date</label>${admin
          ? `<input type="date" id="dDue" value="${esc(it.due_date || '')}">`
          : `<span class="v">${it.due_date ? esc(A.fmtDate(it.due_date, { month: 'short', day: 'numeric', year: 'numeric' })) : '<span class="amber-text">Not set</span>'}</span>`}</div>
        ${it.due_date && it.status === 'open' ? `<div class="drow"><span class="k">Reminder</span><button class="btn sm soft" id="dIcs">${I('cal', 'i', 16)}Add to calendar</button></div>` : ''}
      </div>
      ${it.decision || it.meeting_title ? `<div class="decision"><div class="k">${it.meeting_title ? 'From ' + esc(it.meeting_title) + (it.meeting_date ? ' · ' + esc(A.fmtDate(it.meeting_date)) : '') : 'Background'}${it.agenda_item && it.agenda_item !== it.title ? ' · ' + esc(it.agenda_item) : ''}</div>${it.decision ? `<div>${esc(it.decision)}</div>` : ''}</div>` : ''}
      <div class="h2">Updates</div>
      <div class="composer"><label class="sr" for="dNote">Add an update</label><textarea id="dNote" class="textarea" placeholder="What’s the latest?" rows="1"></textarea><button class="btn soft" id="dAdd" style="height:48px">Add</button></div>
      <div class="log">${ups.length ? ups.map(u => { const e = entryText(u, it); return `<div class="entry"><span class="dot"></span><div><div class="who">${esc(u.author_id ? nameOf(u.author_id) : 'System')} · ${esc(A.fmtStamp(u.created_at))}</div><div class="txt${e.sys ? ' sys' : ''}">${esc(e.t)}</div></div></div>`; }).join('') : '<p class="muted" style="font-size:14px">No updates yet.</p>'}</div>
      <div class="bottom-actions">
        ${canClose(it) ? `<button class="btn ${it.status === 'done' ? '' : 'primary'} block" id="dDone">${it.status === 'done' ? 'Reopen' : I('check') + 'Mark done'}</button>` : `<p class="muted" style="font-size:13px;text-align:center;margin:0">Only the people assigned can mark this done.</p>`}
        ${admin ? `<button class="btn ghost danger block" id="dDel">${I('trash', 'i', 18)}Delete item</button>` : ''}
      </div></div>`;
    window.scrollTo(0, 0);
    const note = document.getElementById('dNote');
    note.oninput = () => { note.style.height = 'auto'; note.style.height = Math.min(160, note.scrollHeight) + 'px'; };
    on('dAdd', async () => {
      const body = note.value.trim(); if (!body) return note.focus();
      const btn = document.getElementById('dAdd'); btn.disabled = true;
      const { error } = await sb.from('item_updates').insert({ item_id: id, author_id: myId(), kind: 'note', body });
      btn.disabled = false;
      if (error) return A.toast(error.message);
      note.value = ''; await refresh(true);
    });
    on('dDone', () => toggleDone(id));
    on('dIcs', () => A.download(A.icsFor(it, location.origin + location.pathname + '#item/' + id), 'action-item-reminder.ics'));
    if (admin) {
      const t = document.getElementById('dTitle');
      t.onchange = () => saveItem(id, { title: t.value.trim() || it.title });
      document.getElementById('dDue').onchange = e => saveItem(id, { due_date: e.target.value || null });
      on('dAsg', () => pickPeople(asg, async ids => {
        const del = await sb.from('item_assignees').delete().eq('item_id', id);
        if (del.error) return A.toast(del.error.message);
        if (ids.length) { const ins = await sb.from('item_assignees').insert(ids.map(m => ({ item_id: id, person_id: m }))); if (ins.error) return A.toast(ins.error.message); }
        await refresh(true);
      }));
      on('dDel', async () => {
        if (!confirm('Delete this item and its updates for everyone?')) return;
        const { error } = await sb.from('items').delete().eq('id', id);
        if (error) return A.toast(error.message);
        location.hash = ''; await refresh(true);
      });
    }
  }
  async function saveItem(id, patch) {
    const { error } = await sb.from('items').update(patch).eq('id', id);
    if (error) return A.toast(error.message);
    await refresh(true); A.toast('Saved');
  }
  function pickPeople(selected, onDone) {
    dlg.innerHTML = `<h2>Assigned to</h2><div style="max-height:55vh;overflow:auto">${S.people.map(m => `<label class="check-row"><input type="checkbox" value="${m.id}" ${selected.includes(m.id) ? 'checked' : ''}><span>${esc(m.name)}</span></label>`).join('')}</div>
      <div class="dlg-actions"><button class="btn" id="pCancel">Cancel</button><button class="btn primary" id="pOk">Done</button></div>`;
    dlg.showModal();
    on('pCancel', () => dlg.close());
    on('pOk', () => { const ids = [...dlg.querySelectorAll('input:checked')].map(i => i.value); dlg.close(); onDone(ids); });
  }

  /* ================= new item (admin) ================= */
  function renderNew() {
    root.innerHTML = `<div class="wrap">
      <div class="backbar"><a href="#">${I('back')}Action items</a></div>
      <h1 class="dtitle">New item</h1>
      <div class="form">
        <div class="field"><label class="label" for="nTitle">What needs to happen</label><input id="nTitle" class="input"></div>
        <div class="field"><span class="label">Assigned to</span><div class="checklist">${S.people.map(m => `<label class="check-row"><input type="checkbox" value="${m.id}"><span>${esc(m.name)}</span></label>`).join('')}</div></div>
        <div class="field"><label class="label" for="nDue">Due date</label><input id="nDue" type="date" class="input"></div>
        <div class="field"><label class="label" for="nDec">Background (optional)</label><textarea id="nDec" class="textarea" rows="3"></textarea></div>
        <button class="btn primary block" id="nSave">Add item</button>
      </div></div>`;
    on('nSave', async () => {
      const title = document.getElementById('nTitle').value.trim();
      if (!title) return A.toast('Describe what needs to happen.');
      const ids = [...root.querySelectorAll('.checklist input:checked')].map(i => i.value);
      if (!ids.length) return A.toast('Pick at least one person.');
      const { data, error } = await sb.from('items').insert({
        title, group_id: S.me.person.group_id, due_date: document.getElementById('nDue').value || null,
        decision: document.getElementById('nDec').value.trim() || null, created_by: myId()
      }).select('id').single();
      if (error) return A.toast(error.message);
      const a = await sb.from('item_assignees').insert(ids.map(m => ({ item_id: data.id, person_id: m })));
      if (a.error) A.toast(a.error.message);
      await sb.from('item_updates').insert({ item_id: data.id, author_id: myId(), kind: 'created', body: 'Added in the to-do list' });
      await refresh(true); location.hash = 'item/' + data.id;
    });
  }

  /* ================= Decisions ================= */
  function renderDecisions(el, inPanel) {
    const d = S.decisions, list = d && Array.isArray(d.entries) ? d.entries : [];
    const head = list.length ? `${esc(d.meeting_title || 'Meeting')}${d.meeting_date ? ' · ' + esc(A.fmtDate(d.meeting_date)) : ''}` : '';
    el.innerHTML = `<div class="page-h">${inPanel ? '' : '<h1>Decisions</h1>'}${head ? `<div class="sub">${head}</div>` : ''}</div>
      ${list.length ? list.map(x => `<div class="dec"><span class="k">${esc(x.title || 'Agenda item')}</span><span class="v">${esc(x.decision)}</span></div>`).join('')
        + `<div class="foot-note">Replaced by the next meeting’s decisions when it ends.</div>`
        : `<div class="empty">No decisions yet. The decisions from your group’s latest meeting show here once it ends.</div>`}`;
  }

  /* ================= Next agenda notes (admins, private) ================= */
  function renderNotes(el, inPanel) {
    const open = S.notes.filter(n => !n.checked_at), done = S.notes.filter(n => n.checked_at);
    const row = n => `<div class="note${n.checked_at ? ' checked' : ''}">
      <button class="tick${n.checked_at ? ' done' : ''}" data-note="${n.id}" aria-label="${n.checked_at ? 'Uncheck' : 'Check off'}: ${esc(n.body)}"><span></span></button>
      <div class="tx"><span class="b">${esc(n.body)}</span>${n.checked_at ? '' : `<span class="d">${esc(A.fmtDate(n.created_at.slice(0, 10)))}</span>`}</div></div>`;
    el.innerHTML = `<div class="page-h">${inPanel ? '' : '<h1>Next agenda</h1>'}<div class="sub">Your notes for the next ${esc((S.me.group || {}).name || '')} meeting · only you see these</div></div>
      <form class="quick" id="noteForm"><label class="sr" for="noteIn">New note</label><input class="input" id="noteIn" placeholder="Something to bring up…" maxlength="500" autocomplete="off"><button class="btn soft" type="submit">Add</button></form>
      ${open.map(row).join('')}
      ${!open.length && !done.length ? '<div class="empty">Nothing noted yet. Jot down topics as they come up so they’re not forgotten.</div>' : ''}
      ${done.length ? `<div class="checked-head"><span>Checked off · ${done.length}</span><button class="btn sm ghost" id="noteClear" style="color:var(--teal)">Clear</button></div>${done.map(row).join('')}` : ''}`;
    el.querySelector('#noteForm').onsubmit = async e => {
      e.preventDefault();
      const inp = el.querySelector('#noteIn'), body = inp.value.trim(); if (!body) return;
      inp.value = '';
      const { data, error } = await sb.from('agenda_notes').insert({ person_id: myId(), body }).select('*').single();
      if (error) { inp.value = body; return A.toast(error.message); }
      S.notes.unshift(data); renderNotes(el, inPanel); el.querySelector('#noteIn').focus();
    };
    el.querySelectorAll('[data-note]').forEach(b => b.onclick = async () => {
      const n = S.notes.find(x => x.id === b.dataset.note); const val = n.checked_at ? null : new Date().toISOString();
      const { error } = await sb.from('agenda_notes').update({ checked_at: val }).eq('id', n.id);
      if (error) return A.toast(error.message);
      n.checked_at = val; renderNotes(el, inPanel);
    });
    const c = el.querySelector('#noteClear');
    if (c) c.onclick = async () => {
      const ids = S.notes.filter(n => n.checked_at).map(n => n.id);
      const { error } = await sb.from('agenda_notes').delete().in('id', ids);
      if (error) return A.toast(error.message);
      S.notes = S.notes.filter(n => !n.checked_at); renderNotes(el, inPanel);
    };
  }

  /* ================= settings ================= */
  function renderSettings() {
    const p = S.me.person, g = S.me.group || {}, mine = S.contacts[p.id] || {};
    const onApp = S.people.filter(x => x.user_id);
    const sole = onApp.length <= 1;
    const rem = mine.reminders !== false;
    root.innerHTML = `<div class="wrap">
      <div class="backbar"><a href="#">${I('back')}${isAdmin() && wide() ? 'Home' : 'Action items'}</a></div>
      <div class="settings">
        <h1 style="margin:4px 4px 0;font-size:26px">Settings</h1>
        <div class="rows">
          <div class="drow"><span class="k">Name</span><span class="v">${esc(p.name)}</span></div>
          <div class="drow"><span class="k">Group</span><span class="v">${esc(g.name || '')}${isAdmin() ? ' <span class="pill teal">Admin</span>' : ''}</span></div>
        </div>
        ${isAdmin() ? `<div class="rows"><a class="drow" href="#people"><span class="k" style="color:var(--ink);font-weight:600">People and join requests</span><span class="v">${S.requests.length ? `<span class="pill amber">${S.requests.length}</span>` : ''}${I('right', 'i', 18)}</span></a></div>` : ''}
        <div class="card">
          <button class="switch wide" role="switch" id="remSw" aria-checked="${rem}" ${S.loaded ? '' : 'disabled'}>Email reminders<span class="track"></span></button>
          <p>One email at 7 AM when something of yours is due tomorrow or today, and a Monday note listing anything overdue. ${mine.email ? 'Sent to ' + esc(mine.email) + '.' : 'No email address on file.'}</p>
        </div>
        <div class="bottom-actions" style="margin-top:8px">
          ${isAdmin() && sole ? `<button class="btn white danger block" id="delGroup">Delete group</button>` : `<button class="btn white block" id="leave">Leave group</button>`}
          <button class="btn white danger block" id="signOut">${I('signout')}Sign out</button>
        </div>
      </div></div>`;
    on('remSw', async () => {
      const b = document.getElementById('remSw'), v = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', v);
      const { error } = await sb.from('person_private').update({ reminders: v }).eq('person_id', p.id);
      if (error) { b.setAttribute('aria-checked', !v); return A.toast(error.message); }
      (S.contacts[p.id] = S.contacts[p.id] || {}).reminders = v;
      A.toast(v ? 'Reminders on' : 'Reminders off');
    });
    on('leave', async () => {
      if (!confirm(`Leave ${g.name}? You’ll stay on its list as a name, so past items keep your name.`)) return;
      const { error } = await sb.rpc('leave_group'); if (error) return A.toast(error.message);
      Meeting.close(); location.hash = ''; start();
    });
    on('delGroup', async () => {
      if (!confirm(`Delete ${g.name} for good? This removes its items, names, decisions and notes. It can’t be undone.`)) return;
      const { error } = await sb.rpc('delete_group'); if (error) return A.toast(error.message);
      Meeting.close(); location.hash = ''; start();
    });
    on('signOut', signOutNow);
  }

  /* ================= people and join requests (admins) ================= */
  function renderPeople() {
    const g = S.me.group || {};
    const unlinked = S.people.filter(p => !p.user_id);
    const sorted = S.people.slice().sort((a, b) => (b.is_admin - a.is_admin) || a.name.localeCompare(b.name));
    const ago = iso => { const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : m < 2880 ? 'yesterday' : A.fmtDate(iso.slice(0, 10)); };
    const reqCard = r => {
      const sug = r.suggested_person_id && unlinked.find(p => p.id === r.suggested_person_id);
      const opts = sug
        ? [[sug.id, sug.name + ' (suggested)'], ['', 'New person'], ...unlinked.filter(p => p.id !== sug.id).map(p => [p.id, p.name])]
        : [['', 'New person (no close match)'], ...unlinked.map(p => [p.id, p.name])];
      return `<div class="req" data-req="${r.id}">
        <div class="who"><span class="avatar">${esc(A.initials(r.full_name))}</span><span style="flex:1;min-width:0"><b>${esc(r.full_name)}</b><span>${esc(r.email || '')} · ${esc(ago(r.created_at))}</span></span></div>
        <label>Link to<select class="${sug ? 'suggested' : ''}" aria-label="Link ${esc(r.full_name)} to">${opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>
        <div class="acts"><button class="btn" data-decline="${r.id}">Decline</button><button class="btn primary" data-approve="${r.id}">Approve</button></div></div>`;
    };
    root.innerHTML = `<div class="ppl">
      <div class="backbar" style="padding:0"><a href="#">${I('back')}${wide() ? 'Home' : 'Action items'}</a></div>
      <div class="ppl-h"><div><div class="eyebrow">${esc(g.name || '')}</div><h1>People</h1></div>
        <div class="codebox"><span class="k">Group code</span><span class="c" id="codeTxt">${esc(g.code || '')}</span>
          <button class="btn sm soft" id="shareCode">Share</button><button class="btn sm ghost" id="newCode" style="color:var(--muted)">New code</button></div></div>
      <div class="ppl-g">
        <div class="ppl-l"><span class="sect-t">Waiting for approval</span>
          ${S.requests.length ? S.requests.map(reqCard).join('') : '<p class="muted" style="margin:0">No requests right now. Share the group code; people who use it show up here.</p>'}</div>
        <div class="ppl-r">
          <div class="row" style="justify-content:space-between;margin-bottom:6px"><span class="sect-t">Members · ${S.people.length}</span><button class="btn sm soft" id="addName">${I('plus', 'i', 16)}Add name</button></div>
          ${sorted.map(p => `<button class="mrow" data-person="${p.id}"><span class="n">${esc(p.name)}${p.id === myId() ? ' (you)' : ''}</span>${p.is_admin ? '<span class="pill teal">Admin</span>' : `<span class="s">${p.user_id ? 'On the app' : 'Name only'}</span>`}</button>`).join('')}
        </div></div></div>`;
    root.querySelectorAll('.req select').forEach(s => s.onchange = () => s.classList.toggle('suggested', !!s.value && /\(suggested\)$/.test(s.selectedOptions[0].text)));
    root.querySelectorAll('[data-approve]').forEach(b => b.onclick = async () => {
      const card = b.closest('.req'), val = card.querySelector('select').value || null;
      b.disabled = true;
      const { error } = await sb.rpc('approve_join', { p_request: b.dataset.approve, p_person: val });
      if (error) { b.disabled = false; return A.toast(error.message); }
      A.toast('Approved'); await refresh(true);
    });
    root.querySelectorAll('[data-decline]').forEach(b => b.onclick = async () => {
      if (!confirm('Decline this request?')) return;
      const { error } = await sb.from('join_requests').delete().eq('id', b.dataset.decline);
      if (error) return A.toast(error.message);
      await refresh(true);
    });
    on('shareCode', async () => {
      const url = location.origin + location.pathname + '#join=' + encodeURIComponent(g.code);
      const text = `Join ${g.name} on Minutes HQ: open ${url} and sign in with Google. Group code: ${g.code}`;
      if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
      try { await navigator.clipboard.writeText(text); A.toast('Copied. Paste it into a message.'); } catch (e) { A.toast('Group code: ' + g.code); }
    });
    on('newCode', async () => {
      if (!confirm('Make a new code? The old one stops working; pending requests stay.')) return;
      const { data, error } = await sb.rpc('new_group_code'); if (error) return A.toast(error.message);
      S.me.group.code = data; renderPeople(); A.toast('New code ready');
    });
    on('addName', () => editPerson(null));
    root.querySelectorAll('[data-person]').forEach(b => b.onclick = () => editPerson(b.dataset.person));
  }

  function editPerson(id) {
    const p = id ? personOf(id) : { name: '', user_id: null, is_admin: false };
    const c = (id && S.contacts[id]) || { email: '', reminders: true };
    const self = id === myId();
    dlg.innerHTML = `<h2>${id ? esc(p.name) : 'Add a name'}</h2>
      <div class="field"><label class="label" for="eName">Name as it should appear</label><input class="input" id="eName" value="${esc(p.name)}" placeholder="e.g. Dana R." maxlength="80"></div>
      <div class="field"><label class="label" for="eEmail">Email for reminders (optional)</label><input class="input" id="eEmail" type="email" value="${esc(c.email || '')}" placeholder="name@gmail.com" autocapitalize="off">
        <span class="hint">${p.user_id ? 'Where their reminder emails go.' : 'They get vague reminders with a private link, and signing up with this address matches them to this name.'}</span></div>
      ${id ? `<button class="switch wide" role="switch" id="eRem" aria-checked="${c.reminders !== false}">Reminder emails<span class="track"></span></button>` : ''}
      ${id && p.user_id ? `<label class="check-row"><input type="checkbox" id="eAdmin" ${p.is_admin ? 'checked' : ''}>Admin (runs meetings, approves people)</label>` : ''}
      <div class="dlg-actions" style="justify-content:space-between">
        <span class="row">${id && !self ? (p.user_id ? `<button class="btn ghost danger" id="eRemove">Remove from app</button>` : `<button class="btn ghost danger" id="eDelete">Delete</button>`) : ''}
          ${id && c.email ? `<button class="btn ghost" id="eReset" style="color:var(--muted)">Reset private link</button>` : ''}</span>
        <span class="row"><button class="btn" id="eCancel">Cancel</button><button class="btn primary" id="eSave">Save</button></span></div>`;
    if (!dlg.open) dlg.showModal();
    on('eCancel', () => dlg.close());
    on('eRem', () => { const b = document.getElementById('eRem'); b.setAttribute('aria-checked', b.getAttribute('aria-checked') !== 'true'); });
    on('eSave', async () => {
      const name = document.getElementById('eName').value.trim(), email = document.getElementById('eEmail').value.trim().toLowerCase();
      if (!name) return A.toast('Enter a name.');
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return A.toast('That email doesn’t look right.');
      let pid = id;
      if (id) {
        const patch = { name }; const ad = document.getElementById('eAdmin'); if (ad && ad.checked !== p.is_admin) patch.is_admin = ad.checked;
        const { error } = await sb.from('people').update(patch).eq('id', id); if (error) return A.toast(error.message);
      } else {
        const { data, error } = await sb.from('people').insert({ group_id: S.me.person.group_id, name }).select('id').single(); if (error) return A.toast(error.message);
        pid = data.id;
      }
      const rem = document.getElementById('eRem');
      if (email || S.contacts[pid]) {
        // Update the existing contact row, or insert one. (An upsert would also rewrite person_id, which the database doesn't allow.)
        const fields = { email: email || null, reminders: rem ? rem.getAttribute('aria-checked') === 'true' : true };
        const { error } = S.contacts[pid]
          ? await sb.from('person_private').update(fields).eq('person_id', pid)
          : await sb.from('person_private').insert({ person_id: pid, ...fields });
        if (error) return A.toast(error.message);
      }
      dlg.close(); A.toast('Saved'); await refresh(true);
    });
    on('eRemove', async () => {
      if (!confirm(`Remove ${p.name} from the app? They stay on the list as a name, so past items keep it. They can ask to join again with the code.`)) return;
      const { error } = await sb.rpc('remove_member', { p_person: id }); if (error) return A.toast(error.message);
      dlg.close(); await refresh(true);
    });
    on('eDelete', async () => {
      if (!confirm(`Delete ${p.name}? Their name also comes off any items they’re assigned to.`)) return;
      const { error } = await sb.from('people').delete().eq('id', id); if (error) return A.toast(error.message);
      dlg.close(); await refresh(true);
    });
    on('eReset', async () => {
      const { error } = await sb.rpc('reset_link', { p_person: id }); if (error) return A.toast(error.message);
      A.toast('Old private links no longer work. The next reminder carries a new one.');
    });
  }

  /* ================= go ================= */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.me && S.me.person && ['', 'people', 'item', 'settings'].includes(route().v)) refresh(true);
  });
  if (sb) sb.auth.onAuthStateChange(evt => {
    if (evt === 'SIGNED_IN' && !S.me) start();
    if (evt === 'SIGNED_OUT' && S.me) { S.me = null; start(); }
  });
  window.addEventListener('online', () => { if (S.me && S.me.offline) start(); });
  window.AppShell = { start, refresh, nav, isAdmin, myId, nameOf, wide };
  A.registerSW();
  start();
})();
