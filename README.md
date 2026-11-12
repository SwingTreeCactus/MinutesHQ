# Minutes HQ

Meeting minutes and follow-ups for small groups.

One web app at one address (for example `https://hq.mygroundwork.app`), used two ways:

- **Everyone** signs in with Google on their phone and sees their group's to-do list, the Decisions from the last meeting, and can post updates and check off their own items.
- **Admins** also run meetings from a tablet (the Admin home): agenda, attendance, notes, wrap-up, PDF. Meeting notes stay on the admin's device, protected by its screen lock and the admin's sign-in (no passphrase). Only follow-ups, decisions and updates go to the shared database.

Anyone can start a group and becomes its admin. Others join with the group's code and an admin approves them. Each person belongs to one group, and the database keeps every group's data apart.

Setup takes about an hour, once. You need a GitHub account, a Supabase account (free), and a Google account. Email reminders (optional, step 6) also need a free Resend account and access to your domain's DNS (Cloudflare).

---

## 1. Put the files on GitHub Pages

1. Create a repository (public is fine; no data lives in the code).
2. Upload everything in this folder, keeping the folder structure. If the repository has files from the earlier version, delete `minutes.html`, `js/tracker.js`, `js/minutes.js`, `manifest-tracker.webmanifest`, `manifest-minutes.webmanifest` and the old `icons/tracker-*` / `icons/minutes-*` images.
3. **Settings → Pages**: **Deploy from a branch**, branch `main`, folder `/ (root)`, save.

### Your own address (Cloudflare)

1. Cloudflare → your domain → **DNS → Records → Add record**: type **CNAME**, name `hq`, target `YOUR-USERNAME.github.io`, proxy status **DNS only** (gray cloud).
2. GitHub → **Settings → Pages → Custom domain**: `hq.mygroundwork.app`, save. When the check passes, tick **Enforce HTTPS**.
3. Your **app address** is now `https://hq.mygroundwork.app/`.

The app is separate from the rest of the domain: the main site can't see its sign-ins or stored data, and nothing links between them. Pages tell search engines not to list them.

## 2. Create the database

1. At [supabase.com](https://supabase.com), create a **New project** (free plan). Save the database password somewhere safe.
2. **SQL Editor → New query**, paste all of `supabase/schema.sql`, click **Run**. Nothing to edit. You should see "Success".
3. **Project Settings → Realtime**: turn off **Allow public access**. The live view uses private channels that only the group's admins can join (the rules come from `schema.sql`).

## 3. Connect the app to the database

1. **Project Settings → API** (or **Data API**): copy the **Project URL** and the **anon public** key.
2. Put them in `js/config.js` in your repository and commit. The anon key is meant to be public; the database rules decide who sees what.

### Keep the database awake

A free Supabase project is paused after a quiet week and stays paused until someone clicks **Resume** in the dashboard. The file `.github/workflows/keep-awake.yml` prevents that: three times a week GitHub asks the database a harmless question, using the address and key from `js/config.js`.

1. Check the file is in the repository. Folders starting with a dot are often hidden on a Mac and skipped by drag-and-drop; if it's missing, use **Add file → Create new file**, type `.github/workflows/keep-awake.yml` as the name, and paste the file's contents.
2. Open the repository's **Actions** tab. If asked, enable workflows. Click **Keep database awake → Run workflow** once; a green check means it reached the database.

If a run fails (for example, the project was already paused), GitHub emails you. GitHub turns off scheduled workflows in a public repository after 60 days without any commits and emails you first; re-enable it from the **Actions** tab with one click.

## 4. Turn on "Sign in with Google"

**Google Cloud** ([console.cloud.google.com](https://console.cloud.google.com)):

1. Create a project (any name).
2. **APIs & Services → OAuth consent screen** (or **Google Auth Platform → Branding**): **External**, app name, your email as support and developer contact. No scopes needed.
3. **Audience → Publish app**. It only asks for name and email, so no review is needed.
4. **Credentials → Create credentials → OAuth client ID**, type **Web application**. Under **Authorized redirect URIs** add `https://YOUR-PROJECT.supabase.co/auth/v1/callback`.
5. Copy the **Client ID** and **Client secret**.

**Supabase:**

1. **Authentication → Sign In / Providers → Google**: turn on, paste the ID and secret, save.
2. **Authentication → URL Configuration**: **Site URL** = your app address; under **Redirect URLs** add your app address followed by `**` (e.g. `https://hq.mygroundwork.app/**`).

## 5. Start your group

1. On the tablet, open your app address in Chrome and sign in with Google.
2. Tap **Start a group**, name it (e.g. "Board") and enter your name as the group knows you. You're its admin.
3. Tap **People → Add name** for everyone who comes to meetings. Add an email for anyone who won't use the app but should get reminders.
4. Tap **Share** next to the group code and send it to members. When they ask to join, you'll see them under **People**: check the suggested name, then **Approve**.
5. Chrome menu (⋮) → **Add to Home screen** (or **Install app**). Open it from the home screen from now on.
   On an iPad: Safari → **Share → Add to Home Screen**, and always run meetings from that icon. Safari can clear a website's stored data after a week without use, which would erase unfinished meeting notes; Home Screen apps keep theirs.
6. Optional: in **Start a meeting**, tap the gear and paste an Anthropic key so **Read agenda** handles PDFs and photos and the wrap-up offers **Polished minutes PDF**. Get one at [console.anthropic.com](https://console.anthropic.com) and set a monthly spend limit there.

Other admins: open a member's row under **People** and tick **Admin**. A group can have several. The last admin can't step down or leave until someone else is an admin.

## 6. Email reminders (optional)

Reminders go out at 7 AM in the group's time zone when something of yours is due today or tomorrow, plus a Monday note of overdue items. Emails never contain item titles. Each carries a private read-only link (good for 30 days) and a one-click unsubscribe. Admins are also emailed when someone asks to join.

**Resend (sending service):**

1. Sign up at [resend.com](https://resend.com) (free tier: 3,000 emails a month).
2. **Domains → Add domain**: `notify.mygroundwork.app`. Using its own subdomain keeps it clear of Groundwork's email records.
3. Resend lists DNS records (MX and TXT for sending, a TXT for DKIM). Add each in Cloudflare **DNS → Records** exactly as shown, proxy off. Click **Verify** in Resend.
4. **API Keys → Create API key** (sending access). Copy it.

**Supabase:**

1. **Edge Functions → Deploy a new function → Via editor**. Name it `notify`, paste all of `supabase/functions/notify/index.ts`, deploy. In the function's settings, turn **off "Verify JWT"** (the function checks its own callers; mail apps need to reach it for one-click unsubscribe).
2. **Edge Functions → Secrets**, add:
   - `RESEND_API_KEY` = the key from Resend
   - `MAIL_FROM` = `Minutes HQ <reminders@notify.mygroundwork.app>`
   - `APP_URL` = `https://hq.mygroundwork.app/`
   - `CRON_SECRET` = any long random string (e.g. from a password generator)
3. **Database → Extensions**: turn on `pg_cron` and `pg_net`.
4. **SQL Editor → New query**, fill in your project address and the same secret, run:

```sql
select cron.schedule('meeting-reminders', '5 * * * *', $$
  select net.http_post(
    url     := 'https://YOUR-PROJECT.supabase.co/functions/v1/notify',
    headers := '{"Content-Type": "application/json", "x-cron-secret": "YOUR-CRON-SECRET"}'::jsonb,
    body    := '{"type": "cron"}'::jsonb);
$$);
```

It runs every hour and sends only during the 7 o'clock hour in each group's time zone (set from the device of whoever started the group). To test straight away, run the `net.http_post(...)` part once with body `'{"type": "cron", "force": true}'`; anyone with items due today or tomorrow gets their email (still at most one a day).

## 7. Members

Send members the app address (or use **Share** on the People screen, which includes the code). Tell them:

- **Android:** open it in Chrome, ⋮ → **Add to Home screen** or **Install app**, open it from the home screen, sign in with Google, enter the code and their full name.
- **iPhone / iPad:** open it in Safari, **Share → Add to Home Screen**, then open it **from the home screen** and sign in there. (iPhone keeps home-screen apps separate from Safari.)

They'll see "Waiting for approval" until an admin approves them.

---

## Using it

**Admin home (tablet):** the group name, **People** (with any join requests), and your account. **Start a meeting** is the one main button; it reads **Continue … meeting** while one is underway on this tablet. When another admin is running a meeting, a **Live now** card lets you **Follow along**. On the right: **To-do | Decisions | Next agenda**.

**Before the meeting:** paste or load the agenda and tap **Read agenda**, or add items by hand. The start time and the closing-prayer brother are picked up when the agenda lists them. **Add open action items** puts everything still open into the agenda as item 2. **Confidential** keeps that meeting's agenda and notes on the tablet (nothing is sent out for reading or polishing). Then **Next: who's here**.

**During the meeting:** tap who's present, then work through the agenda. Each item has Notes, a Decision, and **Needs follow-up** (task, people, due date). You can jump around, reorder, add and remove items. Other admins can follow along read-only; they browse on their own and never see which item you're on. Notes reach them directly and are never stored on the server.

**After the meeting:** follow-ups go to the to-do list automatically (anything without a person waits for **Pick someone**). The meeting's decisions replace the group's **Decisions** list (a meeting with no decisions leaves the old list). Ending again after changes never duplicates items, keeps any edits made in the to-do list since, and won't delete an item that already has updates (it tells you instead). Download the PDF or save a copy.

**Next agenda (admins):** your own private scratchpad of topics for the next meeting. Check a note off once it's been raised; **Clear** removes checked-off notes.

**Rules everyone lives by:** members see only their own group. Everyone sees every item in it and can add updates; only the people assigned (or an admin) can mark an item done; only admins create, edit or delete items, run meetings, and approve people. These are enforced by the database, not just the app.

## Good to know

- **Offline:** once opened online, the app opens without a connection using the last sign-in, so meetings work in a room with no wifi. Follow-ups wait and go out when the tablet is back online.
- **Shared device:** each admin's notes are kept apart by their Google sign-in. Nothing in the app locks them: anyone holding the unlocked device while you're signed in can open them, so keep a screen lock on the device. Notes saved under the old passphrase are brought over once with that passphrase (or erased with **Start fresh instead**); copies saved back then still ask for it.
- **Removing someone:** under **People**, **Remove from app** keeps them as a name so past items keep it. A name-only person's items are closed by admins.
- **Leaving:** **Settings → Leave group**. If you're the only one using the app in the group, you get **Delete group** instead.
- **Calendar:** **Add to calendar** on an item creates an event titled "Action item due — open tracker", so nothing confidential shows on lock screens.
- **Supabase free plan:** projects pause after a quiet week; the keep-awake workflow (step 3) prevents it. If it happens anyway, open the dashboard and click **Resume**; nothing is lost. The paid plan never pauses.
- **Updating:** edit the files on GitHub; devices pick up the new version the next time they open the app online.

## Files

```
index.html                 The app (one address for everyone)
my.html                    Private read-only link from reminder emails, and unsubscribe
privacy.html, terms.html   Privacy policy and terms (linked from sign-in; Google's consent screen asks for them)
css/app.css                Styles
js/config.js               Your Supabase address and key (edit this)
js/common.js               Sign-in, dates, shared helpers
js/app.js                  Sign-in gates, joining, to-do list, Decisions, Next agenda, settings, people, Admin home
js/meeting.js              Running a meeting on the tablet
js/live.js                 Live view for other admins
js/vault.js                Meeting notes saved on the device (and the one-time move from the old passphrase format)
js/pdf.js                  PDF layout
js/my.js                   Private link page
js/icons.js                Icons
sw.js                      Offline support
manifest.webmanifest       Home-screen install settings
icons/                     App icons
supabase/schema.sql        Database tables and permissions (run once)
supabase/functions/notify/ Email reminders (optional)
.github/workflows/keep-awake.yml  Keeps the free database from pausing
```
