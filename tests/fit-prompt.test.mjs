/**
 * tests/fit-prompt.test.mjs — the fit judgement's prompt and answer reader (ticket D2a).
 *
 * The prompt carries the rules and the advert in their own fenced blocks, and
 * the reader accepts exactly one line of JSON with a known verdict. Anything
 * else is `ok: false`, which the gate turns into REVIEW. An excerpt the model
 * invented is reported as not found.
 *
 * Inline adverts only; nothing here reads tests/fixtures/fit/, calls a model or
 * touches the network.
 *
 * Run: node test-all.mjs --only fit-prompt
 */

import { buildFitPrompt, parseFitAnswer, excerptInAdvert, FIT_VERDICTS } from '../providers/_fit-prompt.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\nproviders/_fit-prompt.mjs — one prompt, one line of JSON back (D2a)');

function ok(label, cond) {
  if (cond) pass(label);
  else fail(label);
}

const ADVERT = `# Operations Associate — Example Ltd

You will own our onboarding workflow end to end.
Requirements: 2+ years in an operations role.`;

{
  const prompt = buildFitPrompt({ brief: 'BRIEF-RULES', criteria: 'CRITERIA-RULES', advert: ADVERT });
  ok('the brief is inside its block', /=== THE CANDIDATE'S TRIAGE BRIEF[^\n]*\nBRIEF-RULES\n=== END OF BRIEF ===/.test(prompt));
  ok('the criteria are inside their block', /ROLE CRITERIA[^\n]*\nCRITERIA-RULES\n=== END OF CRITERIA ===/.test(prompt));
  ok('the advert comes last, inside its block', prompt.indexOf('=== THE ADVERT') > prompt.indexOf('=== END OF CRITERIA ===') && prompt.includes(`${ADVERT}\n=== END OF ADVERT ===`));
  ok('every verdict is named in the frame', FIT_VERDICTS.every((v) => prompt.includes(v)));
}

{
  const r = parseFitAnswer('{"verdict":"PASS","reason":"Owns a workflow.","excerpt":"You will own our onboarding workflow end to end."}', ADVERT);
  ok('a well-formed PASS is read', r.ok && r.verdict === 'PASS' && r.excerptFound === true);
}

{
  const r = parseFitAnswer('{"verdict":"SKIP","reason":"x","excerpt":"You will run a contact centre of 300 agents."}', ADVERT);
  ok('an invented excerpt is read but marked not found', r.ok && r.excerptFound === false);
}

ok('extra whitespace and a dropped full stop do not hide a real excerpt', excerptInAdvert('Requirements:  2+ years in an operations role', ADVERT));
ok('curly quotes match straight ones', excerptInAdvert('We’re hiring an “operator” today', 'We\'re hiring an "operator" today.'));
ok('a fragment too short to prove anything is not found', !excerptInAdvert('2+ years', ADVERT));

for (const [label, stdout] of [
  ['prose around the JSON', 'Here you go:\n{"verdict":"PASS","reason":"r","excerpt":"e"}'],
  ['a code fence', '```json\n{"verdict":"PASS","reason":"r","excerpt":"e"}\n```'],
  ['not JSON', 'PASS'],
  ['an unknown verdict', '{"verdict":"MAYBE","reason":"r","excerpt":"e"}'],
  ['a missing reason', '{"verdict":"SKIP","excerpt":"You will own our onboarding workflow end to end."}'],
  ['an empty answer', ''],
]) {
  ok(`${label} is not ok`, parseFitAnswer(stdout, ADVERT).ok === false);
}
