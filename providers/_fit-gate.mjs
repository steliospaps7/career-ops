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
 * Under `providers/` with an underscore prefix, like `_fit-prompt.mjs`, so the
 * provider registry never discovers it as a board.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import * as yaml from 'js-yaml';
import { buildFitPrompt, parseFitAnswer, loadFitRules, FIT_SYSTEM_PROMPT } from './_fit-prompt.mjs';

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
    command,
  };
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
 * JSON, an envelope marked `is_error`, and on `signal` aborting, which kills
 * the child.
 */
export function claudeJudge({ command = ['claude'], model, effort }) {
  const [bin, ...lead] = command;
  const args = [...lead, ...claudeJudgeArgs({ model, effort })];
  return (prompt, { signal } = {}) => new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      child.kill('SIGTERM');
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

/**
 * The gate for one run.
 *
 * @param {object} options
 * @param {object} options.settings - from readFitGateSettings, enabled
 * @param {{brief: string, criteria: string}|null} options.rules - the two rule files' text
 * @param {string} [options.rulesError] - why the rules could not be loaded
 * @param {(prompt: string, opts: {signal: AbortSignal}) => Promise<{text: string, models?: string[]}>} options.judge
 * @param {(name: string) => string} [options.canonicalize] - the scan's company canonicaliser
 * @param {() => number} [options.now]
 */
export function createFitGate({ settings, rules, rulesError = '', judge, canonicalize = (n) => String(n ?? '').trim().toLowerCase(), now = Date.now }) {
  const allow = new Set((settings.alwaysAllow || []).map((c) => canonicalize(c)));
  const tally = { assessed: 0, pass: 0, skip: 0, review: 0, failed: 0, ceilingHits: 0, calls: 0, models: new Map(), rows: [] };
  let firstCallAt = null;
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
    const advert = String(row.advert ?? '');
    if ((row.readStatus != null && row.readStatus !== 'read') || !advert.trim()) {
      return record(row, review('advert not read, nothing to judge'));
    }
    if (!rules) {
      return record(row, review(`rules not loaded: ${oneLine(rulesError) || 'unknown'}`, { failed: true }));
    }
    if (tally.calls >= settings.maxRows) {
      return record(row, review(`row ceiling reached (${settings.maxRows} per run)`, { ceiling: true }));
    }
    tally.calls++;
    await acquire();
    let controller = null;
    let timer = null;
    try {
      if (firstCallAt == null) firstCallAt = now();
      const remaining = settings.budgetMs - (now() - firstCallAt);
      if (remaining <= 0) {
        return record(row, review(`time budget spent (${Math.round(settings.budgetMs / 60_000)} min per run)`, { ceiling: true }));
      }
      const timeoutMs = Math.min(settings.callTimeoutMs, remaining);
      controller = new AbortController();
      let answer;
      try {
        answer = await Promise.race([
          judge(buildFitPrompt({ ...rules, advert, company: row.company, title: row.title, location: row.location }), { signal: controller.signal }),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(Object.assign(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`), { timedOut: true }));
            }, timeoutMs);
          }),
        ]);
      } catch (err) {
        return record(row, review(`fit call failed: ${oneLine(err?.message) || 'unknown error'}`, { failed: true }));
      }
      for (const model of answer?.models || []) tally.models.set(model, (tally.models.get(model) || 0) + 1);
      const parsed = parseFitAnswer(answer?.text, advert);
      if (!parsed.ok) {
        return record(row, review(`fit answer invalid: ${parsed.error}`, { failed: true }));
      }
      if (!parsed.excerptFound) {
        return record(row, review(`excerpt not found in the advert; the model said ${parsed.verdict}: ${oneLine(parsed.reason)}`, { excerpt: oneLine(parsed.excerpt) }));
      }
      const outcome = { verdict: parsed.verdict, reason: oneLine(parsed.reason), excerpt: oneLine(parsed.excerpt), failed: false, ceiling: false, allowed: false, held: false };
      if (outcome.verdict === 'SKIP') {
        outcome.allowed = allow.has(canonicalize(row.company));
        outcome.held = outcome.allowed || !settings.skip;
      }
      return record(row, outcome);
    } finally {
      if (timer) clearTimeout(timer);
      release();
    }
  }

  return { assess, tally, settings };
}

/** The gate the scan runs: the rules loaded from the settings' paths, the call through `claude`. */
export function buildFitGate(settings, { canonicalize, judge = null } = {}) {
  let rules = null;
  let rulesError = '';
  try {
    if (!settings.criteriaPath) throw new Error('fit_gate.criteria_path is not set');
    rules = loadFitRules({ briefPath: settings.briefPath, criteriaPath: settings.criteriaPath });
  } catch (err) {
    rulesError = err?.message || String(err);
  }
  return createFitGate({ settings, rules, rulesError, judge: judge || claudeJudge(settings), canonicalize });
}

/** The value of a queue line's `fit:` segment, before sanitising. */
export function formatFitValue(outcome) {
  if (!outcome) return '';
  return outcome.verdict === 'PASS' ? 'PASS' : `${outcome.verdict} (${oneLine(outcome.reason)})`;
}

/** The reason on a SKIP line moved to Processed. */
export function formatFitSkipReason(reason, date) {
  return `skipped (fit: ${oneLine(reason)}, ${date})`;
}

/**
 * The run's fit lines: one summary line, then one line per SKIP and REVIEW
 * with its reason, so a model's verdict is never invisible.
 */
export function formatFitSummary(gate) {
  const { tally, settings } = gate;
  const models = [...tally.models.entries()].map(([m, n]) => `${m} ${n}`).join(', ');
  const lines = [
    `Fit gate:              assessed ${tally.assessed}, PASS ${tally.pass}, SKIP ${tally.skip}, REVIEW ${tally.review}, failed calls ${tally.failed}, ceiling hits ${tally.ceilingHits}`,
    `                       ${settings.model}, effort ${settings.effort} (flag), calls ${tally.calls}${models ? `, answered by: ${models}` : ''}; SKIP switch ${settings.skip ? 'on' : 'off, SKIPs stay in the Inbox as review'}`,
  ];
  for (const row of tally.rows) {
    const held = row.verdict === 'SKIP' && row.held
      ? ` | kept in the Inbox: ${row.allowed ? 'always_allow' : 'SKIP switch off'}`
      : '';
    const excerpt = row.excerpt ? ` | "${row.excerpt}"` : '';
    lines.push(`FIT ${row.verdict} | ${row.company || '?'} | ${row.title || '?'} | ${row.reason}${excerpt}${held}`);
  }
  return lines;
}
