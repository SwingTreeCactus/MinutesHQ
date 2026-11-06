/* Shared helpers: Supabase client, who's signed in, dates, small UI utilities. */
(function () {
  const C = window.APP_CONFIG || {};
  const configured = !!(C.SUPABASE_URL && C.SUPABASE_ANON_KEY && !/YOUR-/.test(C.SUPABASE_URL + C.SUPABASE_ANON_KEY));
  const sb = configured && window.supabase
    ? window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      })
    : null;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(msg, ms = 3500) {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('on');
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), ms);
  }

  /* ----- dates (due dates are plain YYYY-MM-DD, compared in local time) ----- */
  const pad = n => String(n).padStart(2, '0');
  function todayISO(d = new Date()) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseISO(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function daysFromToday(s) { const d = parseISO(s); if (!d) return null; const t = parseISO(todayISO()); return Math.round((d - t) / 86400000); }
  function fmtDate(s, opts) {
    const d = parseISO(s); if (!d) return s || '';
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, opts || (sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }));
  }
  function fmtLong(s) { return fmtDate(s, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); }
  function fmtTime(iso) { return iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''; }
  function fmtClock(hhmm) { const m = /^(\d{2}):(\d{2})$/.exec(hhmm || ''); if (!m) return hhmm || ''; const d = new Date(); d.setHours(+m[1], +m[2], 0, 0); return fmtTime(d.toISOString()); }
  function fmtStamp(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + fmtTime(iso);
  }
  function initials(name) { return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join(''); }

  /* ----- sign-in ----- */
  async function signIn() {
    if (!sb) return toast('The app isn’t connected to the database yet. See the README.');
    const redirectTo = location.origin + location.pathname;
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo, queryParams: { prompt: 'select_account' } } });
    if (error) toast(error.message);
  }
  async function signOut() { if (sb) await sb.auth.signOut(); try { localStorage.removeItem(ME_KEY); } catch (e) {} }
  async function getSession() { if (!sb) return null; const { data } = await sb.auth.getSession(); return data.session || null; }

  /* Who is signed in: their person row and group, or a pending join request.
     The last answer is kept so the app can start without a connection (e.g. a meeting room with no wifi). */
  const ME_KEY = 'mt_me';
  function cachedMe() { try { return JSON.parse(localStorage.getItem(ME_KEY)); } catch (e) { return null; } }
  async function whoami() {
    const session = await getSession();
    if (!session) return { session: null };
    let { data, error } = await sb.rpc('whoami');
    if (error) {
      const c = cachedMe();
      if (c && c.uid === session.user.id && !navigator.onLine) return { session, offline: true, ...c };
      throw error;
    }
    const r = { session, uid: session.user.id, email: data.email || session.user.email || '', person: data.person, group: data.group, request: data.request };
    try { localStorage.setItem(ME_KEY, JSON.stringify({ uid: r.uid, email: r.email, person: r.person, group: r.group, request: r.request })); } catch (e) {}
    return r;
  }

  /* ----- calendar reminder file (.ics) with a deliberately vague title ----- */
  function icsFor(item, appUrl) {
    const d = (item.due_date || '').replace(/-/g, '');
    const next = parseISO(item.due_date); next.setDate(next.getDate() + 1);
    const d2 = todayISO(next).replace(/-/g, '');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Meeting Tracker//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT', 'UID:' + item.id + '@meeting-tracker', 'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + d, 'DTEND;VALUE=DATE:' + d2,
      'SUMMARY:Action item due — open tracker', 'DESCRIPTION:' + appUrl,
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Action item due', 'TRIGGER:PT9H', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR'
    ];
    return new Blob([lines.join('\r\n')], { type: 'text/calendar' });
  }

  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  async function shareOrDownload(blob, name, type) {
    const file = new File([blob], name, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    download(blob, name);
  }
  const scripts = {};
  function loadScript(src) {
    if (!scripts[src]) scripts[src] = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.onload = res;
      s.onerror = () => { delete scripts[src]; s.remove(); rej(new Error('needs an internet connection')); };
      document.head.appendChild(s);
    });
    return scripts[src];
  }

  function registerSW() {
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  /* Run fn(rows) on a Supabase query result, throwing on error. */
  const q = p => p.then(r => { if (r.error) throw r.error; return r.data; });

  window.App = { sb, configured, esc, toast, todayISO, parseISO, daysFromToday, fmtDate, fmtLong, fmtTime, fmtClock, fmtStamp, initials,
    signIn, signOut, getSession, whoami, cachedMe, icsFor, download, shareOrDownload, loadScript, registerSW, q };
})();
