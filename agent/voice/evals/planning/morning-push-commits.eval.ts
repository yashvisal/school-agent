import { defineEval } from "eve/evals"

import type { Plan } from "../../lib/core.js"
import type { CommitPlanInput } from "../../tools/commitPlan.js"

/**
 * The morning push has to leave a record (VOICE_TOOLS.md §4b). A text nobody
 * committed is a plan that exists only in the thread: the Dashboard's Today
 * panel stays empty, a check-in has nothing to ask about, and tomorrow's replan
 * cannot see what it is replacing.
 *
 * Two properties, both hard:
 *
 * 1. A morning push calls `commitPlan` once, for the day it planned, with the
 *    1–3 blocks it named.
 * 2. Every block satisfies the invariant Core enforces, asserted here against the
 *    plan the agent actually saw (captured from the `getFeasibleActions` output):
 *    inside a free window that option can use, ending by the due minute on the
 *    due day, and no two picks covering the same minutes.
 *
 * The check is against the WINDOW a `fits` entry points at, not the fit's own
 * span, because the span is not the invariant: a fit starts at the head of its
 * window and runs one effort estimate long, so requiring literal containment
 * would make two blocks in one afternoon impossible and refuse a 7pm block in a
 * 9am–9pm window. What the guarantee is actually about — never a class, never
 * past the due time — is a property of the window and the due time, and that is
 * what both Core and this eval check. Core is the second gate: the call is also
 * asserted to have COMPLETED, and a rejected commit fails the tool.
 */
/** Minutes from local midnight for an instant, in the student's zone. */
function localMinutes(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms))
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)
  return value("hour") * 60 + value("minute")
}

export default defineEval({
  description:
    "A morning push commits the plan it just texted: one commitPlan call for that date, 1-3 picks, every block inside the option's fits.",
  tags: ["planning"],
  async test(t) {
    await t.send(
      "MORNING PUSH for tomorrow. Call getFeasibleActions, pick 1-3 actions, and text the plan. First message rule: no links, no media.",
    )
    t.succeeded()

    // The plan the agent was shown. Captured from the tool's own output so the
    // fits being asserted against are the ones it actually had.
    let plan: Plan | undefined
    t.calledTool("getFeasibleActions", {
      output: (value: unknown) => {
        plan = value as Plan
        return true
      },
      count: 1,
    })

    t.calledTool("commitPlan", {
      status: "completed",
      count: 1,
      input: (value: unknown) => {
        const input = value as CommitPlanInput
        if (!input?.picks || input.picks.length < 1 || input.picks.length > 3) {
          return false
        }
        if (plan && input.date !== plan.date) return false

        return input.picks.every((pick, i) => {
          if (pick.endMin <= pick.startMin) return false
          // Exactly one complete identity.
          if (!pick.taskId && !pick.deadlineId && !(pick.title && pick.courseId)) {
            return false
          }
          // A day is a sequence: no two blocks cover the same minutes.
          const overlaps = input.picks
            .slice(0, i)
            .some(
              (earlier) =>
                Math.max(earlier.startMin, pick.startMin) <
                Math.min(earlier.endMin, pick.endMin),
            )
          if (overlaps) return false

          // Shape-only when the plan could not be captured; Core's own
          // verification still stands behind `status: "completed"`.
          if (!plan) return true

          const option = plan.options.find((o) =>
            pick.taskId
              ? o.taskId === pick.taskId
              : pick.deadlineId
                ? o.deadlineId === pick.deadlineId
                : o.title === pick.title && o.courseId === pick.courseId,
          )
          if (!option) return false

          // Never past the due minute on the due day. `dueInDays === 0` is the
          // planner's own statement that `dueAt` falls on the planned date; the
          // minute is read in the STUDENT's zone, which the plan carries.
          const cutoffMin =
            option.dueAt !== undefined && option.dueInDays === 0
              ? localMinutes(option.dueAt, plan.timezone)
              : 1440

          return option.fits.some((fit) => {
            const window = plan?.windows[fit.windowIndex]
            if (!window) return false
            return (
              pick.startMin >= window.startMin &&
              pick.endMin <= Math.min(window.endMin, cutoffMin)
            )
          })
        })
      },
    })

    // The commit is the plan, not an announcement of one.
    t.judge.autoevals
      .closedQA(
        "The assistant's messages never mention saving, logging, recording, committing, or adding anything to a plan, app, or dashboard — they just say what to do and when.",
        { on: t.transcript },
      )
      .label("never-announces-the-tool")
      .gate(0.8)
  },
})
