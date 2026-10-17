# Cadence — manual test script

Run in demo order, in Chrome. Each step: what to do, then **Expected:**. Tick as you go.
Where a label is paraphrased below, match it by meaning, not exact text.

**Setup:** `npm run build` → `chrome://extensions` → Developer mode → Load unpacked → `.output/chrome-mv3`.
Open a normal `https://` page (not `chrome://`). Keep the side panel open (click the toolbar icon).
Debug page: `chrome-extension://<id>/debug.html` (id is on the extensions page).

Useful tools: service-worker console (extensions page → Cadence → *service worker*), and the debug page for event counts.

---

## 1. Reload and health
1. [ ] On `chrome://extensions`, click **Reload** on Cadence.
   **Expected:** no red *Errors* button on the card. No "Status code: 15" / service-worker registration failure.
2. [ ] Open the service-worker console.
   **Expected:** no uncaught errors; no `[cadence] ... failed` lines on startup.
3. [ ] Click the toolbar icon.
   **Expected:** side panel opens with tabs **Rituals · Spaces · Macros · Standup**, then sections Focus Flip, Leader keys, Privacy, Settings.
4. [ ] `chrome://extensions/shortcuts`.
   **Expected:** two Cadence commands listed: *open the leader-key menu* (Ctrl/⌘+Shift+Space) and *open the macro palette* (Ctrl/⌘+Shift+Y).
5. [ ] DevTools → Application → IndexedDB → `cadence`.
   **Expected:** database version 60 (IndexedDB shows Dexie's version ×10, i.e. Dexie v6); stores: `events, rituals, spaces, spaceUrls, shelves, flipPairs, macros, macroRuns`.

## 2. Collector and privacy
1. [ ] Browse 3–4 different sites, click around, type in a search box. Open the debug page → **Refresh**.
   **Expected:** event counts rise (tab_activated, navigated, click, typing_burst…). The header "events today" count in the panel rises too.
2. [ ] Header → pause button.
   **Expected:** shows paused; badge on the toolbar icon changes. Browse and click: debug counts do **not** rise. Resume restores counting.
3. [ ] Privacy → add `example.com` under *Never record these sites*; visit `https://example.com`, click around.
   **Expected:** no new events for that domain (debug page → recent events has none). Remove it afterwards.
4. [ ] Type in a password field on any login page (don't submit).
   **Expected:** no `field_changed` event for it; no typed text appears anywhere in events.
5. [ ] `chrome://extensions` → Cadence → Details.
   **Expected:** *Allow in Incognito* is unavailable (manifest says `not_allowed`), so nothing from Incognito can be recorded.
6. [ ] Settings → **Show last AI request** (after a Standup/Coverage run later).
   **Expected:** shows exactly what was sent; no blocklisted domains, no password-manager sites.

## 3. Rituals (incl. debug simulate / wipe)
1. [ ] Debug page → **Simulate 2 past Team syncs**.
   **Expected:** status text confirms. After a moment, Rituals tab shows a **Team sync** ritual with doc links.
2. [ ] Rituals tab → open the ritual's docs (if a button is offered).
   **Expected:** docs open as one **named tab group**; first tab focused. Nothing is treated as your own behaviour afterwards (no switch offer, no Focus Flip learning).
3. [ ] Mark a ritual *Never*.
   **Expected:** it stops being offered and disappears from the active list.
4. [ ] Debug page → **Wipe simulated data**.
   **Expected:** simulated events, occurrences and the Team sync ritual are removed; real events untouched.

## 4. Spaces, switch offer, shelve / restore, space letters
1. [ ] Work on two sets of related tabs (e.g. 3 docs for project A, 3 for project B) for a few minutes; Spaces tab.
   **Expected:** after recompute (demo mode lowers thresholds; Settings → *Demo mode*), spaces appear with a name and tab list.
2. [ ] On a space: **Shelve** (close & save).
   **Expected:** its tabs close, a shelf is kept. **Restore** reopens them as one tab group, no duplicates of tabs you already reopened.
3. [ ] Stay on project B tabs, then switch to a project A tab for a while.
   **Expected:** a "Switch to …?" offer (notification or panel card). Accepting focuses the space.
4. [ ] On a space, assign a leader letter (e.g. type a free letter → **Assign**).
   **Expected:** letter shown as a key cap; **Clear** removes it. Trying R, K or M is rejected as reserved; a taken letter is rejected as already used.
5. [ ] Press the leader key, then the space's letter.
   **Expected:** that space's group is restored/focused. The activation is **not** learned as your own switch.

## 5. Focus Flip
1. [ ] Focus Flip section → enable it.
   **Expected:** toggle on; it was off by default.
2. [ ] Repeat several times: type in a "writing" tab, flip to a "reference" tab, return and keep typing (needs 2–3 round trips; demo mode needs fewer).
   **Expected:** a learned pair appears in the pairs list.
3. [ ] Type in the writing tab, then stop typing for the learned pause.
   **Expected:** Cadence flips to the reference tab, then returns to the writing tab.
4. [ ] While flipped, scroll or click in the reference tab.
   **Expected:** the flip is cancelled and you stay put.
5. [ ] Press Leader **S** during a flip.
   **Expected:** the flip stops immediately.
6. [ ] **During a macro replay** (see §6.7): type in the writing tab.
   **Expected:** Focus Flip never starts while the macro runs.

## 6. Macros (Repeat-to-Macro)
**Prep:** Settings → turn **Demo mode** on (lower thresholds: 2 runs, 1 day). Macro playback → *Guided — watch it work*.

1. [ ] Open the same 3 sites in the same order, in 3 separate bursts (close them in between, wait ~2 min between bursts, or use the debug page test harness to seed).
   **Expected:** within ~20 min (or after the Macros tab refresh) a **suggestion card** appears in the Macros tab; a notification also appears if the panel is closed. Notification IDs start with `cadence-macro:`.
2. [ ] On the card, accept it (**Save and run** / accept).
   **Expected:** the macro is saved with an editable name, an ordered step list with checkboxes, ↑/↓ reorder, and any click steps marked *experimental*.
3. [ ] Press **Run** on the macro.
   **Expected:** a run panel shows progress per step (✓ / ✗ / skipped); tabs open as one named group; the first tab is focused.
4. [ ] After the run, check the Rituals/Spaces tabs and the debug event list.
   **Expected:** the replay produced **no** new events and no new suggestion; running it did not raise the macro's "seen N times".
5. [ ] **Leader K** (keep last action as a macro): do a quick 2–3 tab routine, then press the leader key, then **K**.
   **Expected:** a notification "Macro saved" with a name; it appears in the Macros tab. With nothing recent: "Nothing to keep".
6. [ ] **Leader M** (mark start/end): leader → **M** ("Macro recording started"); do a routine; leader → **M** again.
   **Expected:** second press saves a macro from everything between the two marks. A forgotten first mark expires after 10 min.
7. [ ] **Leader R** (repeat last action, with preview): open Wikipedia → a news site → GitHub in three new tabs, wait ~5 s, leader → **R**.
   **Expected:** the overlay stays up and shows exactly "Repeat 3 steps: Wikipedia → <News> → GitHub. Enter to run, Esc to cancel." — no earlier browsing, no redirect hops, no steps for tabs you merely switched to. **Enter** replays exactly those 3; **Esc** cancels and runs nothing. Press leader → R again right after a replay: no new segment, so it offers "No recent action. Repeat last macro …" (never a doubled-up macro). With no macros and no recent action: "Nothing to repeat yet". More than 10 steps shows "→ +N more".
8. [ ] On a saved macro, assign a leader letter (not R/K/M).
   **Expected:** leader overlay now lists *Macro: <name>* under that letter; pressing it runs the macro. Deleting/rejecting the macro drops the letter.
9. [ ] **Leader S mid-replay:** start a macro with a *Wait* step (Add step → *Wait a moment*, 10 s) in Guided/Slow mode; press leader → **S**.
   **Expected:** the run stops within about a second (not at the end of the wait); remaining steps show *skipped*; status says stopped. The run panel's **Stop** button behaves the same, including while paused.
10. [ ] Add step → *Type text* with `hello`; then try `4242 4242 4242 4242` and `password: hunter2`.
    **Expected:** `hello` saves. The card number and password text are **refused** with a message; nothing is stored.
11. [ ] Palette shortcut (Ctrl/⌘+Shift+Y).
    **Expected:** panel opens on the Macros tab with the palette input focused.
12. [ ] Pause recording, repeat a routine 3×, unpause.
    **Expected:** no macro is suggested from paused activity.

## 7. Leader overlay (E, P, /)
1. [ ] Press Ctrl/⌘+Shift+Space on a normal page.
   **Expected:** an overlay lists letters: **E** open panel, **S** stop, **P** pause, **/** search, **R / K / M** macro actions, then space letters, then macro letters. **No "coming soon" entries.**
2. [ ] Press **E**. **Expected:** side panel opens; overlay closes.
3. [ ] Leader → **P**. **Expected:** recording toggles paused/resumed (badge + header update). Press again to restore.
4. [ ] Leader → **/**, type part of a space or ritual name, ↑/↓, Enter.
   **Expected:** filtered list; Enter switches to that space / opens that ritual's docs. Esc closes.
5. [ ] Open the overlay on `chrome://extensions` (no content script there).
   **Expected:** the side panel opens with the Leader keys section highlighted; clicking or typing a letter works.
6. [ ] In Leader keys settings, change **P** to another letter; try changing it to **R**.
   **Expected:** change accepted for a free letter; **R** rejected (already used/reserved).

## 8. Standup and read aloud
1. [ ] Standup tab → choose a range (**Today** / **Yesterday**) → **Generate**.
   **Expected:** a draft with *Yesterday / Today / Blockers* from local activity; blockers never invented.
2. [ ] Use the read-aloud control.
   **Expected:** the text is spoken; stop works.
3. [ ] Copy / download.
   **Expected:** works. Text states nothing is sent anywhere automatically.
4. [ ] Settings → **Show last AI request**.
   **Expected:** the request contents match what you generated; no blocklisted sites.

## 9. Coverage Doc
1. [ ] Standup tab → **Coverage doc** → pick a date range → generate.
   **Expected:** sections for recurring meetings, weekly duties (3+ distinct days), spaces with top tabs, plus a fallback markdown version.
2. [ ] Add a site to the exclusions list, regenerate.
   **Expected:** that site is absent from the doc and from the "last AI request" view.

## 10. Retention and exclusions
1. [ ] Privacy → **Keep activity history for** → *10 minutes*. Wait ~2 min.
   **Expected:** events older than 10 min are purged (debug counts drop). **Rituals, spaces, shelves, flip pairs and saved macros remain.**
2. [ ] Open the Macros tab after the purge.
   **Expected:** every saved macro is still there with its steps and letter.
3. [ ] Add `example.org` under *Never record these sites*; trigger Macros recompute (reload extension).
   **Expected:** no macro is suggested that involves `example.org`, even from events recorded before you added it.
4. [ ] Set retention back to a longer value (24 hours / 7 days).
   **Expected:** setting persists after reload.

## 11. Offline fallback
1. [ ] Turn Wi-Fi off (or `proxy` unreachable). Generate a Standup and a Coverage doc, and open Spaces so naming runs.
   **Expected:** no crash or spinner stuck; Standup/Coverage show the **local fallback** markdown; spaces get local names; macros still suggest, name and run (they never use the network).
2. [ ] Restore network and regenerate.
   **Expected:** the normal AI-written version returns.

## 12. Privacy hardening (macros)
1. [ ] Payment fields: Add step → *Type text* with a selector like `#card-number`; on a checkout page with `autocomplete="cc-number"` / a "Card number" label, run a macro that types into it.
   **Expected:** save is refused for payment-looking selectors; at replay the step fails with "refused: payment or credential field" and nothing is typed. Clicking inside such a field records no click event.
2. [ ] Blocklist at replay: save a macro that opens `example.org`, then add `example.org` to *Never record these sites*, run the macro.
   **Expected:** the run stops at that step: "Stopped at step N (…): example.org is on your excluded sites"; later steps show skipped; the site is not opened.
3. [ ] Param redaction: a macro with a `{var}` URL segment, visited with ids like an email, UUID or long doc id.
   **Expected:** Run form asks for the value (nothing remembered for tokens/emails); stored examples are at most 3 and contain only short ids/slugs.
4. [ ] Standup/Coverage: exclude a domain that appears in a space and a ritual's links, regenerate both, open *Show last AI request*.
   **Expected:** that domain appears nowhere in the request or the output.
5. [ ] Typed values: Add step → Type text: `hello` saves; `password: x`, a card number, or text on an excluded page is refused with a reason. Check the debug event list.
   **Expected:** no typed text in any event (only key counts / field names).
