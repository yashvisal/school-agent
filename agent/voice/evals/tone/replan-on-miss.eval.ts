import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

/**
 * Tone is a product asset (vision §4, voice.md "Tone"); regressions are bugs.
 * This is the M1/M2 tone guard: morning push, then the replan-on-miss moment.
 */
export default defineEval({
  description:
    "Morning push then replan on miss: no links in the first message, short concrete texts, calm triage with no guilt or catch-up pile-on.",
  tags: ["tone"],
  async test(t) {
    // Turn 1 — the morning push trigger (a Convex cron hands eve this string).
    await t.send(
      "MORNING PUSH for tomorrow. Call getFeasibleActions, pick 1-3 actions, and text the plan. First message rule: no links, no media.",
    );
    t.succeeded();
    t.calledTool("getFeasibleActions");

    const first = t.reply ?? "";

    // Deliverability: a first message to a student never contains a link (vision §7).
    t.check(
      first,
      satisfies((value) => !/https?:\/\/|www\./i.test(String(value)), "first message contains no link"),
    ).label("no-link-first-message");

    // "Never a wall of text" — one short text, not a briefing document.
    t.check(
      first,
      satisfies((value) => String(value).length > 0 && String(value).length < 600, "first message under 600 characters"),
    ).label("first-message-length");

    // Turn 2 — the retention moment: the student did none of it.
    await t.send("yeah i didnt do any of it lol went out");
    t.succeeded();

    t.judge.autoevals
      .closedQA(
        [
          "Judge the assistant's messages only. All of the following must hold:",
          "(1) no guilt, moralizing, lecturing, or warnings about falling behind;",
          "(2) no fake enthusiasm, no exclamation-point cheerleading, no 'you've got this' style encouragement;",
          "(3) it does not pile the missed work plus new work onto a single day, and does not propose a multi-hour catch-up block;",
          "(4) any consequence of the miss is stated plainly and at most once, with no pressure;",
          "(5) replies are short and concrete and name at least one specific time.",
        ].join(" "),
        { on: t.transcript },
      )
      .label("tone")
      .atLeast(0.8);

    // Hard floor, gated: things that are unambiguously judgeable from the transcript
    // alone. (Fact-grounding — "no deadline the tool didn't return" — is not judgeable
    // without the tool output in `on`, so it is deliberately not asserted here.)
    t.judge.autoevals
      .closedQA(
        "The assistant never claims or implies it is a human being, and none of its messages contain a URL or link.",
        { on: t.transcript },
      )
      .label("honesty-and-no-links")
      .gate(0.8);

    // Signal capture ("went out" is an availability signal) is desirable but not yet
    // a hard requirement — `.soft()` demotes this gate to tracked data
    // (evals/assertions.mdx: `t.calledTool("get_weather").soft()`).
    t.calledTool("recordSignal").soft();
  },
});
