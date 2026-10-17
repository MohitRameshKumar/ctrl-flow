/**
 * Shared thresholds for macro detection.
 *
 * This module is deliberately free of `chrome.*`, Dexie, and `import.meta` so that the pure
 * detectors in `macro-detection.ts` stay importable from a plain Node test runner. Follow the
 * same discipline as `switch-detection.ts` when adding to it.
 */

/** Matches RETENTION_MS in the background worker: there is no older data to mine. */
export const MACRO_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/** A gap longer than this ends a session. */
export const SESSION_GAP_MS = 3 * 60 * 1000;
export const SESSION_GAP_MS_DEMO = 90 * 1000;

/** Hard cap on actions kept per session: bounds the n-gram enumeration cost. */
export const MACRO_MAX_SESSION_ACTIONS = 40;

/** How many separate runs of a routine before we suggest it. */
export const MACRO_MIN_RUNS = 3;
export const MACRO_MIN_RUNS_DEMO = 2;

/** A sequence must also span this many distinct days, so one busy afternoon proves nothing. */
export const MACRO_SEQ_MIN_DAYS = 2;
export const MACRO_SEQ_MIN_DAYS_DEMO = 1;

export const MACRO_NGRAM_MIN = 2;
export const MACRO_NGRAM_MAX = 6;

/** Jaccard threshold for "these two URL sets are the same routine". */
export const MACRO_SIMILARITY = 0.6;

/** Sessions may start this many hours apart and still count as the same time-of-day routine. */
export const MACRO_HOUR_TOLERANCE = 1;

/** A step must appear in at least this fraction of a group's sessions to survive. */
export const MACRO_URL_FLOOR = 0.6;

/**
 * A longer n-gram has to retain this much of a shorter one's support before it swallows it.
 * Keeps A-B-C over A-B when they are nearly as frequent, but keeps a much more frequent A-B.
 */
export const MACRO_MAXIMALITY_RATIO = 0.8;

/** A click must appear in this fraction of a candidate's sessions to be worth offering. */
export const MACRO_CLICK_SUPPORT = 0.6;
export const MACRO_MAX_CLICKS_PER_URL = 2;

export const MACRO_MAX_SEQUENCE_CANDIDATES = 5;
export const MACRO_MAX_CANDIDATES = 8;

/** Don't re-offer the same macro more often than this. */
export const MACRO_OFFER_THROTTLE_MS = 10 * 60 * 1000;

/** How far back "Record last 30s" reaches. */
export const MACRO_RECORD_WINDOW_MS = 30 * 1000;

/* ---------------------------------------------------------------- *
 * Execution
 * ---------------------------------------------------------------- */

/**
 * Guided pacing, clamped around whatever gap was actually recorded between two actions.
 *
 * The floor is what you see when a macro carries no recorded rhythm — a hand-authored or
 * freshly seeded one. At the original 250ms the tabs went past faster than anyone could follow,
 * which defeats the purpose of a mode whose whole promise is that you can watch it work.
 */
export const MACRO_PACE_MAX_MS = 3000;

/** How long guided mode dwells on each step before moving on. */
export const MACRO_PACE_FLOOR_MS = {
  /** Demo speed: slow enough to narrate. */
  slow: 1800,
  normal: 900,
  /** Barely paced — for a macro you already trust and just want finished. */
  fast: 250,
} as const satisfies Record<string, number>;

export const MACRO_PACE_MIN_MS = MACRO_PACE_FLOOR_MS.normal;
/** Silent mode does not perform the flow for an audience, so it only yields briefly. */
export const MACRO_PACE_SILENT_MS = 120;

/**
 * Longest the executor goes without touching a `chrome.*` API.
 *
 * Every wait is chunked to this, and each chunk ends with a progress write. That write is what
 * keeps the MV3 service worker from being killed at 30s idle during a long pause — the heartbeat
 * and the progress report are deliberately the same mechanism.
 */
export const MACRO_HEARTBEAT_MS = 15 * 1000;

/** A run whose heartbeat is older than this had its worker killed; it is finalized, not resumed. */
export const MACRO_RUN_STALE_MS = 60 * 1000;

/** `wait` steps are capped so a bad recording cannot hang a run. */
export const MACRO_WAIT_MAX_MS = 30 * 1000;
/** Silent mode shortens fixed waits hard and leans on `wait_for` for real readiness instead. */
export const MACRO_WAIT_SILENT_CAP_MS = 2 * 1000;
/** How long `wait_for` polls for its selector. */
export const MACRO_WAIT_FOR_TIMEOUT_MS = 10 * 1000;

/** Whole-run budget, excluding time spent paused. Guided is longer because it is paced. */
export const MACRO_BUDGET_SILENT_MS = 60 * 1000;
export const MACRO_BUDGET_GUIDED_MS = 5 * 60 * 1000;

/**
 * Longest a run may sit paused before it is abandoned.
 *
 * Holding a service worker alive indefinitely because someone walked away is worse than ending
 * the run honestly, so a pause past this is finalized as `interrupted`.
 */
export const MACRO_PAUSE_MAX_MS = 10 * 60 * 1000;

/**
 * Hard ceiling on a single injected call.
 *
 * `chrome.scripting.executeScript` against a tab Chrome has frozen neither resolves nor rejects
 * (w3c/webextensions#527), so every injection must be raced against a timer or one frozen tab
 * hangs the entire run past any budget.
 */
export const MACRO_INJECT_TIMEOUT_MS = 5 * 1000;

/**
 * Retry cadence for finding an element.
 *
 * The retry loop lives in the executor rather than inside the injected function: a hidden page
 * clamps `setTimeout` to ~1s, and to roughly once a minute after five minutes hidden, so an
 * in-page poll in silent mode barely runs. Retrying from the worker also lets Pause and Stop be
 * honored between attempts.
 */
export const MACRO_RETRY_INTERVAL_MS = 400;
export const MACRO_RETRY_ATTEMPTS = 12;

/* ---------------------------------------------------------------- *
 * Learning and auto-run
 * ---------------------------------------------------------------- */

/** Consecutive clean runs before `accepted` is offered promotion to `auto`. */
export const MACRO_AUTORUN_PROMOTE_RUNS = 5;
/** How long the Undo countdown runs before an auto-run fires. */
export const MACRO_AUTORUN_GRACE_MS = 10 * 1000;

/** Steps of a macro that must already match before offering to finish the rest. */
export const MACRO_INPROGRESS_MIN_MATCH = 2;

/** Dismissals before the offer throttle doubles, and before we stop offering entirely. */
export const MACRO_DISMISS_BACKOFF = 3;
export const MACRO_DISMISS_STOP = 5;

export interface MacroThresholds {
  sessionGapMs: number;
  minRuns: number;
  minSequenceDays: number;
}

export function macroThresholds(demoMode: boolean): MacroThresholds {
  return {
    sessionGapMs: demoMode ? SESSION_GAP_MS_DEMO : SESSION_GAP_MS,
    minRuns: demoMode ? MACRO_MIN_RUNS_DEMO : MACRO_MIN_RUNS,
    minSequenceDays: demoMode ? MACRO_SEQ_MIN_DAYS_DEMO : MACRO_SEQ_MIN_DAYS,
  };
}
