---
description: Independent review of the current change before merge. Three axes: the app's rules, the spec, and an outside model.
allowed-tools: Bash, Read, mcp__*__send-message
---

Review runs on three axes, because a change can be perfectly conventional, still not be the change we scoped, and still carry a bug that a Claude reviewer reading Claude's own work waves through.

**Axis 1, standards.** Spawn a fresh reviewer on the branch's diff against `main`, briefed with `web/AGENTS.md` and the seven-edit recipe for a new run kind. Its questions: does anything reimplement the core instead of calling it; does any write path bypass `set-status.mjs`; can anything submit without a human; does a kind that reads an advert hold a write tool; does the proof check the last step or the first; is a personal file staged.

**Axis 2, spec conformance.** If a spec exists in `specs/`, spawn a second, independent reviewer whose only question is: does this diff do what the spec said, all of it and nothing else? It reports anything in the spec that is missing, anything built that the spec never asked for, and any success criterion it cannot see evidence for. Give it the spec and the diff, nothing else, so it is not anchored by the builder's reasoning. Skip this axis only when there is no spec.

**Axis 3, an outside pair of eyes.** The first two axes are both Claude reading work Claude wrote, which is the blind spot the shipping protocol warns about. Send the same diff to a model from another company, using the OpenRouter `send-message` tool with model `openai/gpt-5.6-terra`. Ask for concrete defects only: what breaks, on what input, and where. Tell it to rank by severity and to say plainly if it finds nothing serious rather than padding a list.

Two settings matter. Use `reasoning_effort` medium and `max_tokens` of about 6000, because that cap counts the model's own thinking as well as its answer, and a tight cap returns an empty reply that still bills. A review of a normal branch costs roughly a cent.

Send the diff itself, plus any context the code assumes but does not state: which files can be absent, what runs unattended, and that a job advert is untrusted text. This model cannot see the repo, so anything it needs has to be in the message. If the branch is too large to send whole, send the files carrying the logic and say which ones you left out, rather than truncating in silence.

Relay its findings under their own heading and mark them unverified. Check each against the actual code before anyone acts on it. Say which ones you confirmed and which did not hold up.

If OpenRouter is not connected, the balance is empty, or the call fails, say so in one line and carry on. This axis never blocks a review.

Run all three, relay all three, with the merge recommendation. Do not merge; Stelios decides. If it returns findings that are fixable, fix them on the branch and re-run /review until it is clean or he accepts what is left.
