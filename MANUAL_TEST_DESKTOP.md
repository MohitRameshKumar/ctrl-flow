# Cadence Desktop — manual test script

Run in demo order. Each step: what to do, then **Expected:**. Tick as you go.
Where a label is paraphrased, match it by meaning, not exact text.

**Build:** `npm run build:desktop` then `npm run dist:win` (or `dist:mac`).
**Run without installing:** `npx electron .` after `npm run build:desktop`.

**Reset to a first run:** quit Cadence, then delete the storage file and the browser profile:
- Windows: `%APPDATA%\cadence-collector\storage-local.json` (packaged: `%APPDATA%\Cadence\…`)
- macOS: `~/Library/Application Support/cadence-collector/storage-local.json`

Automated gates that already cover most of this (`node desktop/<name>.mjs`): `smoke`, `p1-smoke`,
`p2-smoke`, `p3-smoke`, `p4-smoke`, `p5-smoke`. This script covers what they cannot: how it feels,
and the things only a human in front of a real OS can judge.

---

## 1. Install and first launch
1. [ ] Run the installer, then launch Cadence.
   **Expected:** a window opens with the Cadence icon in the taskbar/dock. On Windows an unsigned
   build shows SmartScreen first — *More info* → *Run anyway* is expected.
2. [ ] The first screen is onboarding, step 1 of 4.
   **Expected:** "Cadence watches for the things you do twice", three privacy facts, *Get started*.
3. [ ] Click **Get started** → step 2.
   **Expected:** it explains that Cadence drives its own Chrome profile and you will sign in once.
4. [ ] Click **Open my browser**.
   **Expected:** a real Chrome window opens. The status line becomes *Connected to Google Chrome*
   and **Next** enables. **No "Chrome is being controlled by automated software" infobar.**
5. [ ] Click **Next**, then press the leader key (`Ctrl+Shift+Y`, `⌘⇧Y` on macOS).
   **Expected:** the step detects the real key press and advances only then.
6. [ ] Finish or skip step 4.
   **Expected:** the main window appears: left sidebar (Rituals · Spaces · Macros · Standup ·
   Settings), *Watching Google Chrome* with a green dot, "0 events today", *Pause*.

## 2. The collector
1. [ ] In Cadence's Chrome window, browse 3–4 sites and click around.
   **Expected:** "events today" in the sidebar climbs.
2. [ ] Click **Pause**, browse more.
   **Expected:** the count stops rising. Unpause restores it.
3. [ ] Settings → Privacy → add `example.com`, then visit it and click around.
   **Expected:** no new events for that domain. Remove it afterwards.
4. [ ] Type into a password field on any login page (do not submit).
   **Expected:** no typed text is stored anywhere. (Settings → *Open debug page* → recent events.)

## 3. The leader key — the things the extension could not do
1. [ ] Press the leader key on a normal page.
   **Expected:** the overlay appears top-right listing letters; Esc closes it.
2. [ ] **Open a new tab (`chrome://newtab`) and press the leader key.**
   **Expected:** the overlay still appears. *(The extension could not do this — it had to fall back
   to opening the side panel.)*
3. [ ] **Click another app so Chrome is not focused, then press the leader key.**
   **Expected:** the overlay still appears and accepts a letter.
4. [ ] Press leader → **/**, type part of a macro or space name, ↑/↓, Enter.
   **Expected:** filtered list; Enter opens it.
5. [ ] Press leader → **P**.
   **Expected:** recording toggles; the sidebar *Pause* state and tray tooltip follow.

## 4. Macros
1. [ ] Open three tabs you would normally open together, wait ~5 s, then leader → **R**.
   **Expected:** a preview like "Repeat 3 steps: Open … → Open … → Open …. Enter run & save ·
   Esc cancel".
2. [ ] Press **Enter**.
   **Expected:** the macro is saved and runs: three new tabs open. The Macros tab lists it.
3. [ ] Press **Esc** on a later preview.
   **Expected:** nothing is saved and nothing runs.
4. [ ] In the Macros tab, **Set letter** on that macro, then leader → that letter.
   **Expected:** the same pages open.
5. [ ] Press **Run** on a macro and watch the run panel.
   **Expected:** per-step progress; Pause/Stop work; Stop takes effect within about a second.
6. [ ] After a run, check the events count and the Macros tab.
   **Expected:** the replay produced **no** new events and did not raise the macro's seen count.
7. [ ] Set *If a page is already open* to **Switch to it** and run again with those tabs open.
   **Expected:** it focuses the open tabs and opens only what is missing.

## 5. Spaces, Standup, Rituals
1. [ ] Work on two sets of related tabs for a few minutes, then open **Spaces**
       (Settings → *Demo mode* on lowers the thresholds).
   **Expected:** spaces appear with names and tab lists.
2. [ ] **Standup** → choose a range → **Generate**.
   **Expected:** a draft with Yesterday / Today / Blockers reflecting what you actually did.
   Without a configured proxy this is the local fallback, which is still a pass.
3. [ ] Settings → **Show last AI request**.
   **Expected:** exactly what was sent; no blocklisted domains.
4. [ ] **Rituals** tab.
   **Expected:** upcoming demo-calendar entries listed.

## 6. Window and process behaviour
1. [ ] Close the Cadence window with the X, then browse and click in Chrome.
   **Expected:** the app keeps running (tray icon), and the events count has risen when you reopen
   it from the tray. **Collection must not stop when the window is closed.**
2. [ ] With the window closed, press the leader key.
   **Expected:** the overlay still appears.
3. [ ] Start a macro, close the Cadence window mid-run.
   **Expected:** the run continues to completion.
4. [ ] Quit Chrome but leave Cadence running.
   **Expected:** the sidebar shows *Browser closed* with a **Reopen** link; clicking it opens a new
   browser window and the status returns to green.
5. [ ] Quit Cadence from the tray, relaunch it.
   **Expected:** settings and macros survive. Onboarding does **not** reappear.
6. [ ] Relaunch and immediately check the Macros tab after a crash-style quit (Task Manager → End
       task) during a run.
   **Expected:** no macro is stuck "running"; the collector works normally. *(A stale
   `macroReplayInProgress` would silently stop all recording — this is the check for it.)*

## 7. Install-time edge cases
1. [ ] Rename or temporarily move Chrome, then launch Cadence fresh.
   **Expected:** onboarding step 2 says no Chrome-based browser was found, with an install link —
   not a crash or a blank window.
2. [ ] On a machine with Edge but not Chrome.
   **Expected:** Cadence uses Edge and the status line names it.
3. [ ] macOS only: download the `.dmg` through a browser and open it.
   **Expected:** Gatekeeper blocks it; right-click → **Open** works. If macOS says the app "is
   damaged", `xattr -dr com.apple.quarantine /Applications/Cadence.app` then open it.
   **Verify the app launches at all on Apple Silicon before relying on this in a demo.**

## 8. The download page
1. [ ] Open `site/index.html` on Windows and on macOS.
   **Expected:** the main button names the right OS, the other builds are listed underneath, and
   the warning section shows the instructions for that OS.

---

## Known gaps, by design

- **Tab groups.** CDP has no tab-groups API, so Cadence tracks grouping itself instead of asking
  Chrome to draw a group strip. Runs and space restores still open their tabs together and are
  labelled inside Cadence; you will not see Chrome's own coloured group header.
- **A separate browser profile.** Chrome 136+ refuses a remote-debugging port on the default
  profile, so Cadence drives a profile of its own and you sign in to sites once. The profile
  persists across runs.
- **Google Calendar.** Still the bundled demo calendar: the OAuth client id is a placeholder in the
  extension too, so this is unchanged rather than lost.
