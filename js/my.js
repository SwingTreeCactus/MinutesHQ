/* The private link from a reminder email: one person's open items, read-only, no sign-in.
   my.html#t=TOKEN shows the items; my.html#u=TOKEN turns reminder emails off.
   The token sits after "#", so it never reaches the web server's logs. */
(function () {
  const A = window.App, sb = A.sb, esc = A.esc, I = window.ICON;
  const root = document.getElementById('app');
  const h = new URLSearchParams(location.hash.slice(1));
  const appUrl = location.pathname.replace(/my\.html$/, '');

  function gate(icon, title, text, extra = '') {
    root.innerHTML = `<div class="gate"><div class="card"><div class="badge">${I(icon, 'i', 28)}</div><h1>${esc(title)}</h1><p>${text}</p>${extra}</div></div>`;
  }
  async function unsubscribe(tok) {
    const { data, error } = await sb.rpc('unsubscribe', { p_token: tok });
    if (error || !data) return gate('x', 'Link not recognized', 'This link doesn’t match any reminder emails. They may already be off.');
    gate('check', 'Reminder emails are off', 'You won’t get any more of them. You can turn them back on in the app under Settings.');
  }
  async function items(tok) {
    const { data, error } = await sb.rpc('link_items', { p_token: tok });
    if (error) return gate('x', 'Couldn’t load', esc(error.message || 'Check your connection and try again.'));
    if (!data) return gate('clock', 'This link has expired', 'Private links work for 30 days after the email that carried them. Your next reminder email brings a new one.',
      `<a class="btn soft block" href="${esc(appUrl)}">Open the app</a>`);
    const list = data.items || [];
    const due = it => {
      if (!it.due_date) return '<span class="amber-text">No due date</span>';
      const d = A.daysFromToday(it.due_date);
      if (d < 0) return `<span class="amber-text">Due ${esc(A.fmtDate(it.due_date))}</span>`;
      return d === 0 ? 'Due today' : d === 1 ? 'Due tomorrow' : 'Due ' + esc(A.fmtDate(it.due_date));
    };
    root.innerHTML = `<div class="wrap" style="padding-bottom:40px">
      <div class="page-h" style="padding-top:calc(28px + env(safe-area-inset-top))"><h1>Your open items</h1><div class="sub">${esc(data.name)} · ${esc(data.group)}</div></div>
      ${list.length ? list.map(it => `<article class="item${it.due_date && A.daysFromToday(it.due_date) < 0 ? ' late' : ''}" style="padding-left:16px"><div class="body" style="padding-top:0">
          <span class="t">${esc(it.title)}</span>
          <span class="m">${due(it)}${it.meeting_title ? ' · ' + esc(it.meeting_title) + (it.meeting_date ? ', ' + esc(A.fmtDate(it.meeting_date)) : '') : ''}</span>
          ${it.latest ? `<span class="u">${esc(it.latest)}</span>` : ''}</div></article>`).join('')
        : '<div class="empty">Nothing open right now.</div>'}
      <p class="foot-note" style="text-align:center;line-height:1.5">Read-only. To post an update or mark something done, use the app.<br>This link stops working 30 days after the email was sent.</p>
    </div>`;
  }
  if (!sb) return gate('x', 'Not set up', 'This page isn’t connected yet.');
  if (h.get('u')) unsubscribe(h.get('u'));
  else if (h.get('t')) items(h.get('t'));
  else gate('lock', 'Nothing to show', 'Open this page from the link in a reminder email.');
})();
