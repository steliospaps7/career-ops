/**
 * providers/_fit-gate.mjs — the fit judgement's gate, ticket D2b.
 *
 * One model call per genuinely new row, before the row reaches the queue. The
 * prompt and the answer parser are `_fit-prompt.mjs`'s, never a second copy;
 * this module holds what the scan needs around them: the settings, the call
 * through the user's own `claude` command, one limiter shared by the whole
 * sweep, the per-call timeout, the per-run ceilings and the tally the summary
 * prints.
 *
 * Off unless `config/profile.yml` says `fit_gate: enabled: true`. An absent key
 * means no call is ever made, so no user of this fork shells out to `claude`
 * unasked.
 *
 * Every failure is REVIEW, never PASS: an advert nobody read, rules that could
 * not be loaded, a call that throws or times out, an answer that is not the
 * one line of JSON, an excerpt the advert does not contain, and a row past
 * either ceiling.
 *
 * A call that fails is asked once more before the row is left REVIEW: a
 * timeout, an answer that is not the one line of JSON, and an excerpt the
 * advert does not contain. The retry spends what is left of the same run
 * budget, so it can never push a run past it, and a row that fails twice
 * still reaches a person. The first failure is never swallowed: it counts
 * as `retried` on the summary line and prints a `FIT RETRY` line naming the
 * row, the failure and what the judge said.
 *
 * Under `providers/` with an underscore prefix, like `_fit-prompt.mjs`, so the
 * provider registry never discovers it as a board.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import * as yaml from 'js-yaml';
import { buildFitPrompt, parseFitAnswer, loadFitRules, formatFitValue, FIT_SYSTEM_PROMPT } from './_fit-prompt.mjs';

/** At most this many calls in the air across the whole sweep. Not configurable. */
export const FIT_GATE_CONCURRENCY = 3;

/** D2a's choice (log entry of 14 September 2026), used when the profile names none. */
export const FIT_GATE_DEFAULTS = Object.freeze({
  model: 'claude-opus-5',
  effort: 'medium',
  maxRows: 100,
  budgetMinutes: 30,
  callTimeoutSeconds: 180,
  briefPath: 'modes/_brief.md',
});

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The `fit_gate` block of the profile, read once per run.
 *
 * A missing file, a profile that does not parse and a block without
 * `enabled: true` all come back disabled: the gate never spends a call on a
 * guess about what the user meant.
 */
export function readFitGateSettings(profilePath, { root = process.cwd() } = {}) {
  const disabled = { enabled: false };
  if (!profilePath || !existsSync(profilePath)) return disabled;
  let raw;
  try {
    raw = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
  } catch {
    return disabled;
  }
  const block = raw && typeof raw === 'object' ? raw.fit_gate : null;
  if (!block || typeof block !== 'object' || block.enabled !== true) return disabled;

  const resolvePath = (p) => (p ? path.resolve(root, String(p)) : '');
  const command = Array.isArray(block.command) && block.command.length > 0 && block.command.every((c) => typeof c === 'string' && c)
    ? block.command
    : ['claude'];
  return {
    enabled: true,
    skip: block.skip === true,
    model: typeof block.model === 'string' && block.model.trim() ? block.model.trim() : FIT_GATE_DEFAULTS.model,
    effort: typeof block.effort === 'string' && block.effort.trim() ? block.effort.trim() : FIT_GATE_DEFAULTS.effort,
    briefPath: resolvePath(block.brief_path || FIT_GATE_DEFAULTS.briefPath),
    criteriaPath: resolvePath(block.criteria_path),
    maxRows: Math.floor(positiveNumber(block.max_rows, FIT_GATE_DEFAULTS.maxRows)),
    budgetMs: positiveNumber(block.budget_minutes, FIT_GATE_DEFAULTS.budgetMinutes) * 60_000,
    callTimeoutMs: positiveNumber(block.call_timeout_seconds, FIT_GATE_DEFAULTS.callTimeoutSeconds) * 1000,
    alwaysAllow: (Array.isArray(block.always_allow) ? block.always_allow : [])
      .filter((c) => typeof c === 'string' && c.trim()),
    rulesChanged: rulesChangedDate(block.rules_changed),
    command,
  };
}

/**
 * `fit_gate.rules_changed`, the day the brief or the criteria last changed, as
 * YYYY-MM-DD. YAML reads an unquoted date as a Date and a quoted one as a
 * string; both are taken. Absent, or anything that is not a real calendar day
 * ("2026-02-30", "23 Sep"), means no cutoff: every cut in the window stands,
 * as before the key existed, rather than the run failing over a typo.
 */
function rulesChangedDate(value) {
  let iso = '';
  if (value instanceof Date && Number.isFinite(value.getTime())) iso = value.toISOString().slice(0, 10);
  else if (typeof value === 'string') iso = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === iso ? iso : null;
}

/** The arguments D2a proved for the judge. The prompt goes on stdin. */
export function claudeJudgeArgs({ model, effort }) {
  return [
    '-p', '--model', model, '--effort', effort,
    '--tools', '', '--safe-mode', '--no-session-persistence',
    '--system-prompt', FIT_SYSTEM_PROMPT, '--output-format', 'json',
  ];
}

/**
 * The call through the user's subscription: `claude -p` with the prompt on
 * stdin and cwd a temp folder. Resolves `{text, models}`, where `models` is
 * every key of the envelope's `modelUsage` (the model that answered, and any
 * side call the CLI made). Rejects on a non-zero exit, an envelope that is not
 * JSON, an envelope marked `is_error`, and on `signal` aborting, which sends
 * the child SIGTERM and, if it is still running `killGraceMs` later, SIGKILL,
 * so a child that ignores SIGTERM cannot hold the scan open.
 */
export function claudeJudge({ command = ['claude'], model, effort, killGraceMs = 2000 }) {
  const [bin, ...lead] = command;
  const args = [...lead, ...claudeJudgeArgs({ model, effort })];
  return (prompt, { signal } = {}) => new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer = null;
    child.on('close', () => { if (killTimer) clearTimeout(killTimer); });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, killGraceMs);
      finish(reject, new Error('aborted'));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort);
    }
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish(reject, err));
    child.on('close', (code) => {
      if (code !== 0) {
        return finish(reject, new Error(`claude exited ${code}: ${String(stderr || stdout).replace(/\s+/g, ' ').trim().slice(0, 200)}`));
      }
      let envelope;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        return finish(reject, new Error('claude envelope was not JSON'));
      }
      if (envelope?.is_error) {
        return finish(reject, new Error(`claude reported an error: ${String(envelope.result ?? '').slice(0, 200)}`));
      }
      finish(resolve, { text: String(envelope?.result ?? ''), models: Object.keys(envelope?.modelUsage || {}) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

/** One line of text: no newlines, no runs of spaces. */
function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

// ── Repeats: a seat the gate already cut is not judged again ────────
//
// On 23 September 2026 the 09:00 run paid for a judge call on Collectiv Food's
// Commercial Associate, which the 17:00 run the day before had already cut on
// the same advert. The company+title dedup missed it because the queue line
// writes the board's "Collectiv Food | Certified B Corp" as "Collectiv Food /
// Certified B Corp". A new row whose company (after company_aliases) and whole
// title match a line the gate moved to Processed within the window is filed
// again as a SKIP without a call. Only the gate's own cuts count: a PASS, a
// REVIEW, a SKIP held in the Inbox, a Planner's tick and a reopened row are
// all judged again.

/** How far back a gate cut still stands in for a new judgement, in days. */
export const FIT_REPEAT_WINDOW_DAYS = 14;

/** A queue cell as the scan would write it: escapes undone, `|` as `/`, one line. */
function cutCell(value) {
  return oneLine(String(value ?? '').replace(/\\([\\[\]])/g, '$1').replace(/\|/g, '/'));
}

/**
 * The key a repeat is matched on: the canonical company and the whole title,
 * case-insensitive. Never a prefix: "Chief of Staff to the President,
 * International" and the same title with "- Fanatics Collectibles" after it
 * are two keys.
 */
export function fitCutKey(company, title, canonicalize = (n) => String(n ?? '').trim().toLowerCase()) {
  return `${canonicalize(cutCell(company))}::${cutCell(title).toLowerCase()}`;
}

const FIT_CUT_TAIL_RE = /\|\s*skipped \(fit: (.*), (\d{4}-\d{2}-\d{2})\)\s*$/;
const FIT_REPEAT_REASON_RE = /^SKIP \(repeat of (\d{4}-\d{2}-\d{2})\)$/;

function dayNumber(isoDate) {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null;
}

/**
 * The gate's cuts still inside the window, read from `data/pipeline.md`:
 * ticked lines whose last cell is `skipped (fit: <reason>, <date>)`, the shape
 * the scan writes for a SKIP it moves to Processed. A repeat line carries the
 * date of the judgement it repeated, so the window runs from the last real
 * judgement and a seat re-listed every day is judged afresh after it.
 *
 * With `rulesChanged` set, a cut dated before that day is not read: it was made
 * under rules that no longer stand, so the seat is judged again. A cut dated
 * on the day itself counts as made under the new rules, since the rules are
 * changed before that day's next run. For a repeat line the date compared is
 * the judgement it repeated, the same date the window uses.
 *
 * @returns {Map<string, string>} fitCutKey → the latest cut date, YYYY-MM-DD
 */
export function collectFitCuts(pipelineText, { canonicalize, today, windowDays = FIT_REPEAT_WINDOW_DAYS, rulesChanged = null } = {}) {
  const cuts = new Map();
  const todayN = dayNumber(today);
  if (todayN == null) return cuts;
  const changedN = rulesChanged ? dayNumber(rulesChanged) : null;
  for (const line of String(pipelineText ?? '').split('\n')) {
    if (!/^- \[x\]\s+/.test(line)) continue;
    const tail = line.match(FIT_CUT_TAIL_RE);
    if (!tail) continue;
    const cells = line.replace(/^- \[x\]\s+/, '').split('|').map((c) => c.trim());
    const urlIndex = cells.findIndex((c) => /^https?:\/\//.test(c));
    if (urlIndex === -1) continue;
    const company = cells[urlIndex + 1] || '';
    const title = cells[urlIndex + 2] || '';
    if (!company || !title) continue;
    const cutOn = tail[1].match(FIT_REPEAT_REASON_RE)?.[1] || tail[2];
    const cutN = dayNumber(cutOn);
    if (cutN == null || todayN - cutN < 0 || todayN - cutN > windowDays) continue;
    if (changedN != null && cutN < changedN) continue;
    const key = fitCutKey(company, title, canonicalize);
    if (!cuts.has(key) || cuts.get(key) < cutOn) cuts.set(key, cutOn);
  }
  return cuts;
}

/**
 * The gate for one run.
 *
 * @param {object} options
 * @param {object} options.settings - from readFitGateSettings, enabled
 * @param {{brief: string, criteria: string}|null} options.rules - the two rule files' text
 * @param {string} [options.rulesError] - why the rules could not be loaded
 * @param {(prompt: string, opts: {signal: AbortSignal}) => Promise<{text: string, models?: string[]}>} options.judge
 * @param {(name: string) => string} [options.canonicalize] - the scan's company canonicaliser
 * @param {Map<string, string>} [options.priorCuts] - from collectFitCuts, built with the same canonicaliser
 * @param {() => number} [options.now]
 */
export function createFitGate({ settings, rules, rulesError = '', judge, canonicalize = (n) => String(n ?? '').trim().toLowerCase(), priorCuts = new Map(), now = Date.now }) {
  const allow = new Set((settings.alwaysAllow || []).map((c) => canonicalize(c)));
  const tally = { assessed: 0, pass: 0, skip: 0, review: 0, failed: 0, ceilingHits: 0, calls: 0, retried: 0, models: new Map(), rows: [], retries: [], repeats: [] };
  let firstCallAt = null;
  let reserved = 0;
  let active = 0;
  const waiters = [];

  const acquire = () => new Promise((resolve) => {
    if (active < FIT_GATE_CONCURRENCY) {
      active++;
      resolve();
    } else {
      waiters.push(resolve);
    }
  });
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else active--;
  };

  function record(row, outcome) {
    tally.assessed++;
    if (outcome.verdict === 'PASS') tally.pass++;
    else if (outcome.verdict === 'SKIP') tally.skip++;
    else tally.review++;
    if (outcome.failed) tally.failed++;
    if (outcome.ceiling) tally.ceilingHits++;
    if (outcome.verdict !== 'PASS') {
      tally.rows.push({ company: row.company || '', title: row.title || '', ...outcome });
    }
    return outcome;
  }

  const review = (reason, extra = {}) => ({ verdict: 'REVIEW', reason, excerpt: '', failed: false, ceiling: false, allowed: false, held: false, ...extra });

  /**
   * One row. Never throws: every failure comes back as REVIEW.
   *
   * @param {{company: string, title: string, advert: string, readStatus?: string|null}} row
   */
  async function assess(row) {
    // A repeat of the gate's own cut, before anything that could spend a call.
    // Only where a fresh SKIP would leave the Inbox too: with the switch off or
    // the company under always_allow the row is judged as it always was.
    if (settings.skip && !allow.has(canonicalize(row.company))) {
      const cutOn = priorCuts.get(fitCutKey(row.company, row.title, canonicalize));
      if (cutOn) {
        tally.repeats.push({ company: row.company || '', title: row.title || '', cutOn });
        return { verdict: 'SKIP', reason: `SKIP (repeat of ${cutOn})`, excerpt: '', failed: false, ceiling: false, allowed: false, held: false, repeatOf: cutOn };
      }
    }
    const advert = String(row.advert ?? '');
    if ((row.readStatus != null && row.readStatus !== 'read') || !advert.trim()) {
      return record(row, review('advert not read, nothing to judge'));
    }
    if (!rules) {
      return record(row, review(`rules not loaded: ${oneLine(rulesError) || 'unknown'}`, { failed: true }));
    }
    const budgetSpent = () => review(`time budget spent (${Math.round(settings.budgetMs / 60_000)} min per run)`, { ceiling: true });
    if (firstCallAt != null && now() - firstCallAt >= settings.budgetMs) {
      return record(row, budgetSpent());
    }
    // A slot under the row ceiling is taken before waiting for the limiter, so
    // rows waiting in parallel cannot overshoot it, and given back if the row is
    // refused on the budget, so a budget refusal never reads as the row ceiling.
    if (reserved >= settings.maxRows) {
      return record(row, review(`row ceiling reached (${settings.maxRows} per run)`, { ceiling: true }));
    }
    reserved++;
    await acquire();
    try {
      if (firstCallAt == null) firstCallAt = now();
      // Built once, so the retry visibly asks the same question as the first call.
      const prompt = buildFitPrompt({ ...rules, advert, company: row.company, title: row.title, location: row.location });

      /**
       * One call: the judge, the parse and the excerpt check.
       *
       * `null` when the time budget has nothing left for a call. Otherwise
       * `{outcome, retry, models, sample}`, where `retry` marks the three
       * failure kinds worth asking a second time: the call itself failed or
       * timed out, the answer was not the one line of JSON, or the excerpt was
       * not in the advert. A verdict the model actually reached is never
       * retried. `models` is folded into the tally only for the attempt that
       * stands, so a retried row is never counted twice under "answered by".
       * `sample` is what the judge actually said, for the failure line.
       */
      const attempt = async () => {
        const remaining = settings.budgetMs - (now() - firstCallAt);
        if (remaining <= 0) return null;
        tally.calls++;
        const timeoutMs = Math.min(settings.callTimeoutMs, remaining);
        const controller = new AbortController();
        let timer = null;
        try {
          let answer;
          try {
            answer = await Promise.race([
              judge(prompt, { signal: controller.signal }),
              new Promise((_, reject) => {
                timer = setTimeout(() => {
                  // Reject before aborting: the real judge rejects synchronously on
                  // abort, and the race must settle on the timeout's reason.
                  reject(Object.assign(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`), { timedOut: true }));
                  controller.abort();
                }, timeoutMs);
              }),
            ]);
          } catch (err) {
            return { outcome: review(`fit call failed: ${oneLine(err?.message) || 'unknown error'}`, { failed: true }), retry: true, models: [], sample: '' };
          }
          const models = answer?.models || [];
          const sample = oneLine(answer?.text).slice(0, 200);
          const parsed = parseFitAnswer(answer?.text, advert);
          if (!parsed.ok) {
            return { outcome: review(`fit answer invalid: ${parsed.error}`, { failed: true }), retry: true, models, sample };
          }
          if (!parsed.excerptFound) {
            return { outcome: review(`excerpt not found in the advert; the model said ${parsed.verdict}: ${oneLine(parsed.reason)}`, { excerpt: oneLine(parsed.excerpt) }), retry: true, models, sample };
          }
          const outcome = { verdict: parsed.verdict, reason: oneLine(parsed.reason), excerpt: oneLine(parsed.excerpt), failed: false, ceiling: false, allowed: false, held: false };
          if (outcome.verdict === 'SKIP') {
            outcome.allowed = allow.has(canonicalize(row.company));
            outcome.held = outcome.allowed || !settings.skip;
          }
          return { outcome, retry: false, models, sample };
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      let result = await attempt();
      if (result === null) {
        reserved--;
        return record(row, budgetSpent());
      }
      if (result.retry) {
        // One retry per failed call, and no more: a bad envelope or a timeout is
        // usually a one-off, and a row that fails twice is a row a person should
        // see. The retry takes what is left of the run's budget, so a second try
        // can never push the run past it; with nothing left, the first failure's
        // REVIEW stands.
        //
        // The first failure is kept whether or not the second call rescues it.
        // Without this, a judge failing every first call would be invisible: the
        // row would read as a clean verdict and the run would only look slow.
        tally.retried++;
        tally.retries.push({
          company: row.company || '',
          title: row.title || '',
          reason: result.outcome.reason,
          sample: result.sample,
        });
        const second = await attempt();
        if (second !== null) result = second;
      }
      for (const model of result.models) tally.models.set(model, (tally.models.get(model) || 0) + 1);
      return record(row, result.outcome);
    } finally {
      release();
    }
  }

  return { assess, tally, settings };
}

/** The gate the scan runs: the rules loaded from the settings' paths, the call through `claude`. */
export function buildFitGate(settings, { canonicalize, priorCuts } = {}) {
  let rules = null;
  let rulesError = '';
  try {
    if (!settings.criteriaPath) throw new Error('fit_gate.criteria_path is not set');
    rules = loadFitRules({ briefPath: settings.briefPath, criteriaPath: settings.criteriaPath });
  } catch (err) {
    rulesError = err?.message || String(err);
  }
  return createFitGate({ settings, rules, rulesError, judge: claudeJudge(settings), canonicalize, priorCuts });
}

// The `fit:` value lives in `_fit-prompt.mjs`, which imports nothing but `fs`,
// so the dashboard's parity test can import the one definition.
export { formatFitValue };

/** The reason on a SKIP line moved to Processed. */
export function formatFitSkipReason(reason, date) {
  return `skipped (fit: ${oneLine(reason)}, ${date})`;
}

/**
 * The run's fit lines: one summary line, then one line per SKIP and REVIEW
 * with its reason, so a model's verdict is never invisible, and one line per
 * first call that failed and was asked again, so a judge that fails every
 * first call shows up in the run log even when every retry rescues the row.
 * Last, when there were any, the repeats filed without a call, one line each.
 */
export function formatFitSummary(gate) {
  const { tally, settings } = gate;
  const models = [...tally.models.entries()].map(([m, n]) => `${m} ${n}`).join(', ');
  const lines = [
    `Fit gate:              assessed ${tally.assessed}, PASS ${tally.pass}, SKIP ${tally.skip}, REVIEW ${tally.review}, failed calls ${tally.failed}, ceiling hits ${tally.ceilingHits}, retried ${tally.retried}`,
    `                       ${settings.model}, effort ${settings.effort} (flag), calls ${tally.calls}${models ? `, answered by: ${models}` : ''}; SKIP switch ${settings.skip ? 'on' : 'off, SKIPs stay in the Inbox as review'}`,
  ];
  for (const row of tally.rows) {
    const held = row.verdict === 'SKIP' && row.held
      ? ` | kept in the Inbox: ${row.allowed ? 'always_allow' : 'SKIP switch off'}`
      : '';
    const excerpt = row.excerpt ? ` | "${row.excerpt}"` : '';
    lines.push(`FIT ${row.verdict} | ${row.company || '?'} | ${row.title || '?'} | ${row.reason}${excerpt}${held}`);
  }
  for (const retry of tally.retries) {
    const said = retry.sample ? ` | the judge said: "${retry.sample}"` : '';
    lines.push(`FIT RETRY | ${retry.company || '?'} | ${retry.title || '?'} | first call failed: ${retry.reason}${said}`);
  }
  // Repeats are not judged, so they sit outside "assessed" and get their own
  // count, printed only when there is one so a run without any reads as before.
  if (tally.repeats.length > 0) {
    const since = settings.rulesChanged ? `, since the rules changed ${settings.rulesChanged}` : '';
    lines.push(`Fit gate repeats:      ${tally.repeats.length} cut by the gate within ${FIT_REPEAT_WINDOW_DAYS} days${since}, filed again with no call`);
    for (const repeat of tally.repeats) {
      lines.push(`FIT REPEAT | ${repeat.company || '?'} | ${repeat.title || '?'} | cut on ${repeat.cutOn}, not judged again`);
    }
  }
  return lines;
}
