// Edge Function "notify": reminder emails, join-request emails, one-click unsubscribe.
// Deploy with JWT verification OFF (it checks its own callers). Secrets it reads:
//   RESEND_API_KEY  – from resend.com
//   MAIL_FROM       – e.g. "Minutes HQ <reminders@notify.mygroundwork.app>"
//   APP_URL         – e.g. "https://hq.mygroundwork.app/"
//   CRON_SECRET     – any long random string; the hourly schedule sends it
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
//
// Callers:
//   hourly schedule  POST {"type":"cron"} with header x-cron-secret → reminders at 7 AM local time + join emails
//   the app          POST {"type":"join"} with the user's sign-in → emails the group's admins about new requests
//   mail apps        POST ?unsub=TOKEN (List-Unsubscribe-Post) → turns that person's emails off
import { createClient } from 'npm:@supabase/supabase-js@2';

const env = (k: string) => Deno.env.get(k) ?? '';
const SUPABASE_URL = env('SUPABASE_URL');
const db = createClient(SUPABASE_URL, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const APP_URL = env('APP_URL').replace(/\/?$/, '/');
const FN_URL = SUPABASE_URL + '/functions/v1/notify';
const LINK_DAYS = 30;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const url = new URL(req.url);

  const unsub = url.searchParams.get('unsub');
  if (unsub) { await db.rpc('unsubscribe', { p_token: unsub }); return new Response('Unsubscribed', { headers: CORS }); }

  let body: { type?: string; force?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body */ }

  const secret = env('CRON_SECRET');
  if (secret && req.headers.get('x-cron-secret') === secret) {
    const reminders = await runReminders(body.force === true);
    const joins = await notifyJoins();
    return json({ reminders, joins });
  }

  if (body.type === 'join') {
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data } = await db.auth.getUser(token);
    if (!data?.user) return json({ error: 'Sign in first' }, 401);
    return json({ joins: await notifyJoins() });
  }
  return json({ error: 'Not allowed' }, 403);
});

/* ---------------- reminders ---------------- */

function localParts(tz: string, d = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, weekday: p.weekday };
}
function addDays(iso: string, n: number) {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
function one<T>(x: T | T[] | null | undefined): T | null { return Array.isArray(x) ? (x[0] ?? null) : (x ?? null); }

async function runReminders(force: boolean) {
  let sent = 0;
  const { data: groups, error } = await db.from('groups').select('id,name,code,time_zone');
  if (error) throw error;
  for (const g of groups ?? []) {
    let local;
    try { local = localParts(g.time_zone || 'America/Los_Angeles'); } catch { local = localParts('America/Los_Angeles'); }
    if (!force && local.hour !== 7) continue;
    const tomorrow = addDays(local.date, 1);
    const monday = local.weekday === 'Mon';
    const [{ data: people }, { data: items }] = await Promise.all([
      db.from('people').select('id,name,user_id,person_private(email,reminders,unsub_token)').eq('group_id', g.id),
      db.from('items').select('id,due_date,item_assignees(person_id)').eq('group_id', g.id).eq('status', 'open').not('due_date', 'is', null),
    ]);
    for (const p of people ?? []) {
      const pp = one(p.person_private as unknown as { email: string | null; reminders: boolean; unsub_token: string });
      if (!pp?.email || pp.reminders === false) continue;
      const mine = (items ?? []).filter((i) => (i.item_assignees as { person_id: string }[]).some((a) => a.person_id === p.id));
      const today = mine.filter((i) => i.due_date === local.date).length;
      const tom = mine.filter((i) => i.due_date === tomorrow).length;
      const over = monday ? mine.filter((i) => i.due_date < local.date).length : 0;
      if (!today && !tom && !over) continue;
      // one email per person per day, even if the job runs twice
      const { error: dup } = await db.from('reminder_sends').insert({ person_id: p.id, sent_on: local.date });
      if (dup) continue;
      const link = await mintLink(p.id);
      await sendMail(pp.email, pp.unsub_token, reminderEmail({ name: p.name, group: g.name, code: g.code, onApp: !!p.user_id, today, tom, over, link }));
      sent++;
    }
  }
  await db.from('link_tokens').delete().lt('expires_at', new Date().toISOString());
  await db.from('reminder_sends').delete().lt('sent_on', addDays(new Date().toISOString().slice(0, 10), -40));
  return sent;
}

async function mintLink(personId: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  await db.from('link_tokens').insert({ token_hash: hash, person_id: personId, expires_at: new Date(Date.now() + LINK_DAYS * 864e5).toISOString() });
  return APP_URL + 'my.html#t=' + token;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
function reminderEmail(o: { name: string; group: string; code: string; onApp: boolean; today: number; tom: number; over: number; link: string }) {
  // Deliberately vague: counts only, never item titles.
  const bits: string[] = [];
  if (o.today) bits.push(`${plural(o.today, 'item')} due today`);
  if (o.tom) bits.push(`${o.today ? o.tom : plural(o.tom, 'item')} due tomorrow`);
  if (o.over) bits.push(`${bits.length ? o.over : plural(o.over, 'item')} overdue`);
  const what = bits.length > 1 ? bits.slice(0, -1).join(', ') + ' and ' + bits[bits.length - 1] : bits[0];
  const first = o.name.split(/\s+/)[0];
  const lead = `You have ${what} from your ${o.group} meetings.`;
  const next = o.onApp
    ? { label: 'Open the app', url: APP_URL, line: 'To post an update or mark something done, open the app.' }
    : { label: 'Join to see them', url: APP_URL + '#join=' + encodeURIComponent(o.code), line: 'Want to post updates or check items off yourself? Join the app with your Google account.' };
  return {
    subject: `Reminder: ${what}`,
    text: `Hi ${first},\n\n${lead}\n\nSee your items (private link, read-only, works for ${LINK_DAYS} days):\n${o.link}\n\n${next.line}\n${next.url}\n\nPlease don't forward this email: the link shows your items to whoever has it.`,
    html: page(`<p>Hi ${esc(first)},</p><p>${esc(lead)}</p>
      <p><a href="${esc(o.link)}" style="display:inline-block;background:#0F766E;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:12px">See your items</a></p>
      <p style="color:#5B6675;font-size:14px">Private, read-only link. It works for ${LINK_DAYS} days. Please don't forward this email.</p>
      <p>${esc(next.line)} <a href="${esc(next.url)}" style="color:#0F766E">${esc(next.label)}</a></p>`),
  };
}

/* ---------------- join requests ---------------- */

async function notifyJoins() {
  let sent = 0;
  const { data: reqs } = await db.from('join_requests').select('id,group_id').is('notified_at', null);
  for (const r of reqs ?? []) {
    // claim it first so two runs never email twice
    const { data: claimed } = await db.from('join_requests').update({ notified_at: new Date().toISOString() })
      .eq('id', r.id).is('notified_at', null).select('id');
    if (!claimed?.length) continue;
    const [{ data: g }, { data: admins }] = await Promise.all([
      db.from('groups').select('name').eq('id', r.group_id).single(),
      db.from('people').select('id,person_private(email,reminders,unsub_token)').eq('group_id', r.group_id).eq('is_admin', true),
    ]);
    for (const a of admins ?? []) {
      const pp = one(a.person_private as unknown as { email: string | null; reminders: boolean; unsub_token: string });
      if (!pp?.email || pp.reminders === false) continue;
      await sendMail(pp.email, pp.unsub_token, {
        subject: `Someone asked to join ${g?.name ?? 'your group'}`,
        text: `Someone asked to join ${g?.name ?? 'your group'}. Open the app to approve or decline:\n${APP_URL}#people`,
        html: page(`<p>Someone asked to join ${esc(g?.name ?? 'your group')}.</p>
          <p><a href="${esc(APP_URL + '#people')}" style="display:inline-block;background:#0F766E;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:12px">Approve or decline</a></p>`),
      });
      sent++;
    }
  }
  return sent;
}

/* ---------------- sending ---------------- */

function esc(s: string) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }
function page(inner: string) {
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#1C2430;max-width:520px">${inner}</div>`;
}
async function sendMail(to: string, unsubToken: string, m: { subject: string; text: string; html: string }) {
  const off = APP_URL + 'my.html#u=' + unsubToken;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env('MAIL_FROM'), to: [to], subject: m.subject,
      text: m.text + `\n\nTurn off these emails: ${off}`,
      html: m.html + `<p style="color:#5B6675;font-size:13px;margin-top:28px"><a href="${esc(off)}" style="color:#5B6675">Turn off these emails</a></p>`,
      headers: { 'List-Unsubscribe': `<${FN_URL}?unsub=${unsubToken}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    }),
  });
  if (!res.ok) console.error('Resend error', res.status, await res.text());
}
