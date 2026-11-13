# Handover: Minutes HQ (Meeting Minutes & Action Tracker)

Read this first in a new chat. It records what was built, why, and every decision Mark made, so work can continue without re-asking.

## Status (Nov 12, 2026)

- **Rebuild done (Nov 5).** Self-service groups, join with code + approval, one address with the Admin home, the meeting flow moved under it, Decisions list, Next agenda notes, live view, reminder emails with private links, and the design-review fixes are all built. **Live as of Nov 6** (see Deployed below). Not yet tested with real Realtime between two devices, Resend, or on an iPad (admins on iPad must run meetings from the Home Screen icon so Safari doesn't clear stored notes).
- **Tests:** SQL permission tests against Postgres 16 with a stubbed Supabase (`meeting-tracker-tests/sql/`, 62 checks) and headless-browser tests against the fake backend (6 files, 120 checks). All pass.
- **Hosting:** https://hq.mygroundwork.app (Cloudflare DNS for mygroundwork.app; CNAME `hq` → `USERNAME.github.io`, DNS only). Email sends from `notify.mygroundwork.app` (its own subdomain, so it doesn't clash with Groundwork's email records).
- **Nov 12:** passphrase removed (see Decisions); on-screen wording says "device", not "tablet". Pushed to GitHub directly from the chat (the session can push to `SwingTreeCactus/MinutesHQ`). Later the same day: opening-prayer brother, no prayer names on the wrap-up, Add name on Who's here. Evening: PDF styles (Modern, Classic, Plain), tighter layout, and Preview. Fixed: saving an existing person under People left the dialog open (the upsert also wrote person_id, which the column grants forbid); now update-or-insert, and the fake backend enforces that grant. Henry Hernandez made an admin so he can follow live meetings. Browser tests: 6 files, 146 checks, all pass (SQL unchanged; tests need `npm install pdfjs-dist@3.11.174` too). Supabase check: project healthy, `notify` not deployed yet.
- Source of truth for code: the `meeting-tracker/` files in this project.
- **Name (Mark, Nov 5): "Minutes HQ"** — page title, Home Screen label, install name, sign-in screen, share text and email sender. Address stays hq.mygroundwork.app. The to-do list keeps its "Action items" heading. Repository: `SwingTreeCactus/MinutesHQ` (public), app files at its root plus a `CNAME` file for hq.mygroundwork.app; first push Nov 5. The test suite stays in this project, not the repo.
- **Deployed (Nov 6): Mark reports everything working** at https://hq.mygroundwork.app: GitHub Pages + Cloudflare CNAME, Supabase project **Minutes HQ** (ref `sfchrfuahaqypxelefvg`, us-west-1, free, org MShahan) with `schema.sql` and helper tightening applied, `js/config.js` filled in, Google sign-in (OAuth app "Minutes HQ" published, redirect via Supabase), Auth URL configuration, Realtime on. Not yet done: email reminders (Resend, deploy `notify`, secrets, cron) — optional; confirm Realtime "Allow public access to channels" is off; first manual run of the keep-awake workflow; checks on a real iPad and of the live view between two admins.
- **Privacy and Terms pages (Nov 5):** `privacy.html` and `terms.html` added because Google's OAuth Branding page asks for them; linked from the sign-in screen (Google checks the home page links its privacy policy). Plain language; contact Mark Shahan, swingtreecactus@gmail.com. Google Branding: app name Minutes HQ, home page https://hq.mygroundwork.app, authorized domains mygroundwork.app and sfchrfuahaqypxelefvg.supabase.co; a logo (minutes-hq-logo-120.png) triggers Google's brand verification.
- **Keep-awake job (Mark, Nov 5):** free GitHub Actions workflow `.github/workflows/keep-awake.yml` pings the database Mon/Wed/Fri (calls `link_items` with a dummy token using the public anon key read from `js/config.js`) so the free Supabase project isn't paused after a quiet week. Failures email Mark via GitHub. Chosen over Supabase Pro.
- Removed in the rebuild (delete from the repo too): `minutes.html`, `js/tracker.js`, `js/minutes.js`, `manifest-tracker.webmanifest`, `manifest-minutes.webmanifest`, old `icons/tracker-*` and `icons/minutes-*`.

### Choices made while building (not decided by Mark; easy to change)

- Admin home appears on screens 700 px wide or more; on a phone, admins get the phone layout (Live now card + To-do | Decisions | Next agenda) plus People under Settings.
- Wrap-up rows say "Sent" (the mockup showed New/Updated). Changes kept from the to-do list and items kept because they have updates are explained in a line on the wrap-up.
- When a followed meeting ends, the viewer gets a "The meeting ended." toast and returns home (see open ideas).
- Built in the approved look without a separate mockup: Start a group form, person edit dialog (name, email for reminders, reminder switch, admin, reset private link, remove/delete), setup item edit dialog (tap a row), private link page (`my.html`), unsubscribe confirmation.
- Only admins see the group code. Codes look like `BRD-7Q4K` (letters from the group name + 4 random characters); "New code" replaces it.
- A group's reminder time zone comes from the device of whoever started it.
- Join-request emails to admins are vague (group name only, no requester name) and respect each admin's reminder switch.
- Deleting a name-only person also removes their name from items they were assigned (the dialog says so). "Remove from app" keeps the name.

## Related artifacts

- Mockup canvas (approved look): https://claude.ai/artifact/HAYLxg7ibTXhFY55zMVyP1
- Setup guide doc: https://claude.ai/artifact/3rVcbs1HksBDKMgH8reVHZ (written for the old two-app setup; README.md is current and supersedes it until the guide is rewritten)

## What it is

- **index.html** — the one app for everyone (phones and the Galaxy Tab). Google sign-in via Supabase. Not in a group yet → Join (code + full name) or Start a group; waiting → "Waiting for approval". Members: To-do | Decisions. Admins: To-do | Decisions | Next agenda, People and join requests, and on the tablet the Admin home with Start/Continue a meeting and Live now.
- **Meeting flow** (`js/meeting.js`) — setup → attendance → meeting → wrap-up, admins only. Notes saved in localStorage per signed-in admin (`mm_notes_v1:<user id>`, `js/vault.js`), **no passphrase and no app lock**: the device screen lock and Google sign-in protect them. Notes left in the old encrypted format (`mm_vault_v2:<user id>`) are brought over once with the old passphrase, or erased with "Start fresh instead". "Save a copy" writes a plain meeting file; copies saved before Nov 12 are encrypted and still open when their passphrase is entered. Saves at every change, at End meeting and when the app goes to the background.
- **Live view** (`js/live.js`) — note-taker broadcasts agenda + notes on a private Supabase Realtime channel `live:<id>`; `live_meetings` stores only meeting name + note-taker name + timestamps; heartbeat every 60 s; cards older than 10 min hidden.
- **Backend** — Supabase. `supabase/schema.sql`: groups (code, time zone), people (app users and name-only), person_private (email, reminders, unsubscribe token; admins + self only), join_requests, items, item_assignees, item_updates, decision_lists, agenda_notes, live_meetings, link_tokens (hashed), reminder_sends; RPCs whoami, start_group, request_join (email/fuzzy name match), cancel_request, approve_join, remove_member, leave_group, delete_group, new_group_code, set_item_status, publish_decisions, reset_link, link_items (anon), unsubscribe (anon); Realtime policies. No admin seeded.
- **Email** — `supabase/functions/notify/index.ts` (Edge Function, JWT verification off): hourly cron with a secret → 7 AM local reminders + join emails; app call after a join request; one-click unsubscribe POST. Resend free tier.
- **my.html** — private read-only page of one person's open items (title, due, meeting, latest update) from `#t=TOKEN`; `#u=TOKEN` unsubscribes. Token after `#` so it never reaches server logs.
- **Keep-awake** — `.github/workflows/keep-awake.yml` (see Status).
- **Hosting** — static files on GitHub Pages, no build step. `sw.js` caches the app shell; jsPDF is loaded on first meeting and cached. `noindex` everywhere.
- **Anthropic API** — called from the tablet with the admin's own key (in their vault). Only for Read agenda (PDF/photo/messy text) and Polished minutes PDF. Default `claude-sonnet-5-5`.

## Decisions Mark made (keep these)

Fields and flow
- Per agenda item: Notes, Decision, and a **Needs follow-up** switch (off by default). On → Task, Assigned to, Due date. Decision-only items just use Decision.
- **Assigned to** is a pick list (not free text), allows **multiple people**; present people listed first.
- **Due date** must be an actual calendar date. No relative quick picks ("1 week", "next meeting") — he rejected that.
- No due date → **flagged, not required**. Follow-up with nobody assigned → held back on wrap-up with "Pick someone".
- All follow-ups with someone assigned are **sent to the tracker automatically** at End meeting (no review step, no Send button). Re-ending doesn't duplicate (`source_key` = meetingId:itemId).
- Re-ending never overwrites fields changed in the to-do list, and never deletes an item that has updates when its follow-up is switched off — it warns instead.
- Agenda editable mid-meeting: jump to any item, reorder (up/down arrows), add after current, remove, edit title/details.
- "Open action items" can be added as agenda item 2, live: post updates and mark done from the meeting.
- **Agenda creation:** only by uploading/pasting it (Read agenda) or adding items by hand on setup. Topics that come up in the meeting are added there ("Add item after this one"). No other way.

Groups and people
- Anyone can sign in with Google and **start a group** (becomes its admin). A person belongs to **exactly one group**; a group can have several admins.
- Joining: admin shares the **group code** → member signs in, enters the code and **full name** → fuzzy match to existing names → **join request** with the suggested match → admin **approves** (can change the match: existing name or "New person") or declines. "Waiting for approval" until then. No safeguard beyond admin approval (group ≤ ~20, trusted).
- Admins add **name-only people** (attend, can be assigned, don't use the app); they can have an optional email for reminders, and a later sign-up with that email matches exactly (admin still approves).
- **Only admins** run meetings. Members use the phone app only. **No meeting recaps on phones** — the PDF is the recap — except the Decisions list.
- Everything scoped to the group in the database.
- The approval reasoning Mark accepted: code + approval is about as secure as admin-typed emails, with less admin work.

Attendance
- Tap who's **present** only. Not tapped = absent, and absence is **not recorded**. No "Late". **No guests.** No quorum.
- **Add name on Who's here** (Mark, Nov 12): adds the person to the group's list (same as People → Add name) and marks them present; an existing name (any capitalization) is just marked present. Needs a connection. Removing people stays under People only (not on the attendance screen).

Tracker permissions
- Everyone in the group sees all its items. Anyone can add updates to any item.
- Only an assignee can mark done; **any one assignee** closes it; admins can close anything. Only admins create/edit/delete items.
- Real sign-in: **Google login**.

Decisions list
- Static, read-only list of the decisions from the **most recent meeting that had decisions**, visible to **everyone in the group**. Sent at End meeting; **ending the next meeting replaces it**; re-ending updates, never duplicates. **A meeting with no decisions leaves the old list in place.** Items without a decision left out. Each entry: agenda item title + decision; header names the meeting and date. No check-off, updates, people or dates. **Confidential meetings included.** Phone tabs: members To-do | Decisions; admins To-do | Decisions | Next agenda (same three on the Admin home).

Next agenda notes
- Admins-only scratchpad of topics for the next meeting. **Personal: each admin sees only their own** (enforced in the database). Not tasks: no people, no due dates, not in the to-do list. One-line quick add, shows the date added. Round **check-off** once raised or not needed; checked notes go to "Checked off" with **Clear**; untick to bring back. **Checked-off notes stay until Clear** (no automatic removal). **Notes never feed the agenda** — Mark rejected the tablet "Saved topics" panel / add-from-saved.

Live view
- Other admins can follow a meeting in progress. **Viewers: admins only** (members may be revisited later). Only the admin who started it takes notes; viewers are **read-only** and **navigate freely** (not pulled along). **Never show where the note-taker is** (no "on item 4", no status rings — Mark rejected it). Realtime broadcast; notes **never stored**; fine for confidential meetings too (confidential only means no outside processing). **No connection/waiting messages**; if updates pause, show the last notes. **Always name people** ("Luis M. taking notes"), never "the tablet". Shared editing by several admins was discussed and not chosen.
- "Live now" stores only meeting name + note-taker name while live, deleted at end.

One address and the Admin home
- One address for everything; no separate minutes.html. Admins land on the **Admin home**: group name, People (+ request count), account; **Start a meeting** as the single primary action ("Continue … meeting" when one is underway on this device); **Live now** card → Follow along; right side To-do | Next agenda (+ Decisions). Members never see meeting controls.
- **Meeting setup screen**: reached from Start a meeting (back returns home). Left: Agenda card (paste / Load file or photo with removable chip / Read agenda) above the Meeting card (name, date, start time, location, closing prayer, Confidential). Right: Items list (reorder, remove, Add item, tap to edit; Open action items as live item 2). One primary action: Next: who's here. No group picker. Open-file and Settings icons in the header.

Reminders and private links
- **Email** reminders (Mark's choice): 7 AM when something of yours is due tomorrow or today, plus a Monday note of overdue items; each member can switch it off. Emails stay **vague** (no titles). Every email has one-click unsubscribe.
- **Email the admins** when a join request arrives.
- Name-only people with an email get vague reminders that say where they're from, with "Join to see them" pre-filling the group code.
- **Expiring private link** (Mark likes it): each reminder carries a fresh long random link to a no-login, **read-only** page of only that person's open items (title, due date, source meeting, latest update). No notes, nothing about others. Check-off and updates need the app. Expires 30 days after sending; admin can reset from People.

PDF
- No PDF password. Header: **Start** time from the agenda (falls back to when Start agenda was tapped). End time = tablet clock at End meeting, labeled **"Closing prayer"**, followed by the **closing-prayer brother's name** from the agenda. **Opening-prayer brother** (Mark, Nov 12) also pulled from the agenda ("Opening prayer …" or "Invocation …"), printed after the start time; no time recorded for it. Both names are edited on setup only: **the wrap-up shows no prayer names** (Mark, Nov 12). **No per-item times.** Present list in header; follow-ups table at the end; footer with page numbers.
- **PDF styles** (Mark, Nov 12): Modern (Helvetica, teal accent; the default), Classic (Times, centered heading, double rule, italic labels), Plain (black and gray only). Styles change only type, color and heading treatment, never the sections or their order ("just stylistic"; a structural template library was offered and not wanted). Chosen in Settings → Minutes style or on the Preview; remembered per admin on the device; used for both Download PDF and Polished minutes PDF. Fonts are jsPDF's built-ins.
- **Fit on as few pages as possible** (Mark, Nov 12): compact header (date and location on one line, start/opening/closing prayer on one line, Present), labels run in on the same line as their text ("DISCUSSION  …"), tight spacing. The follow-ups table is kept together and moves to the next page when it won't fit (Mark: fine if follow-ups are on a separate page).
- **Preview** on the wrap-up (Mark, Nov 12): shows the real PDF pages, drawn with PDF.js 3.11.174 from cdnjs (Chrome on Android can't show PDFs inline); style switch at the top; Download from there. Cached for offline after first use. Previews the regular PDF, not the Polished one (that would call the service on every preview).

Meeting notes on the device
- **No passphrase** (Mark, Nov 12): rely on the device's screen lock and Google sign-in. Chosen over a fingerprint/face/PIN passkey (WebAuthn PRF), which was offered and turned down. Accepted cost: anyone holding the unlocked device while an admin is signed in can open that admin's notes. Notes stay separate per signed-in admin.

Wording
- **Say "device", never "tablet"** in the UI (Mark, Nov 12): the app shouldn't assume what the admin is using.
- **Never mention "AI"** anywhere in the UI. Buttons: "Read agenda" (smart when key set + not confidential + online; otherwise line-by-line, silently falls back) and "Polished minutes PDF" (shown only when available). Settings label: "Anthropic key".
- **Confidential** switch: keeps that meeting's agenda and notes on the device only (no outside processing). Follow-ups and decisions still go to the group.

Look (approved)
- Light: background #EEF1F5, white cards with soft shadows, one accent teal #0F766E (soft #E6F2F0), amber #9A4A0B for needs-attention, Plus Jakarta Sans. Rings: done = filled teal check, current = teal ring+dot, upcoming = gray ring.
- Mark rejected: clinical default look, "filler to fill negative space", the dark black/gold theme, and a restyle that only changed colors. He wants real UX reasoning, one primary action per screen, no decorative stats.

Hosting and security posture
- Subdomain of mygroundwork.app, **no cross-links** with the Groundwork site. No extra site password; rely on sign-in + noindex. Cloudflare Access is a later option.
- The group discusses these matters on WhatsApp anyway: the goal is never showing sensitive text where an onlooker or an inbox preview would see it, not maximum security. Don't over-engineer.

## Open ideas (offered, not decided)

- Let admins run a meeting when the database can't be reached (paused or down), not only when the tablet is offline; follow-ups would send once it's back. Offered Nov 5; Mark chose only the keep-awake job for now.
- What a viewer sees when the meeting ends (built for now as a "The meeting ended." toast and back to home; proposed: a short "Meeting ended" screen; the notes disappear with it since they're never stored).
- Let members follow a live meeting too.
- PDF extras: organization name/logo, "Absent" line (note: absence isn't recorded), signature/approval block, A4.
- Making the closing-prayer time editable.
- Rewrite the setup guide doc to match the new README.

## Known limitations

- Supabase free plan pauses after a quiet week; the keep-awake workflow prevents it. GitHub disables scheduled workflows after 60 days without commits in a public repo (emails first; re-enable in Actions). If paused anyway: Resume in the dashboard; while paused the app shows "Couldn't load".
- Meeting notes have no app-level lock; keep a screen lock on any device used for meetings. Saved copies are plain files now.
- iPhone: members must sign in from the home-screen app, not Safari.
- Signing in leaves the page (Google); the app returns signed in.
- The meeting flow uses the people list saved in the admin's vault when offline; it refreshes whenever the app opens online.
- Realtime private channels, the Edge Function and Resend are written to their documented APIs but untested against the live services.

## Testing

`meeting-tracker-tests/` (in this project):
- **SQL:** `sql/run-sql-tests.sh` loads `sql/supabase-stub.sql` (roles, `auth.uid()`, `auth.jwt()`), then `supabase/schema.sql`, then `sql/test-schema.sql` into a scratch Postgres 16 (`PGHOST`/`PGPORT` env; creates and drops `mt_test`).
- **Browser:** `fake-supabase.js` is an in-memory stand-in for supabase-js (database in localStorage shared by tabs, sign-in per tab in sessionStorage, Realtime via BroadcastChannel, offline when `navigator.onLine` is false). `harness.js` routes the CDN scripts to it and to local jspdf/mammoth (`npm install jspdf@2.5.1 mammoth@1.6.0` in the tests folder) and opens one tab per person. Serve the app with `python3 -m http.server 8765` from `meeting-tracker/`, then run `node test-groups.js`, `test-tracker.js`, `test-minutes.js`, `test-live.js`, `test-smart.js`, `test-offline.js` (Playwright).

## Working with Mark

Direct, technically grounded answers; concise prose over bullet lists; he pushes back on hedging and filler. Prefers seeing a mockup before big UI changes.
