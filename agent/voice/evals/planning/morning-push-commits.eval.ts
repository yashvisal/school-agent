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
 * 2. Every block is inside one of that option's `fits` windows. Checked here
 *    against the plan the agent actually saw — captured from the
 *    `getFeasibleActions` output — and, independently, by Core, which refuses
 *    the commit outright if a block is not feasible. That is why the call is
 *    also asserted to have COMPLETED: a rejected commit fails the tool.
 */
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

        return input.picks.every((pick) => {
          if (pick.endMin <= pick.startMin) return false
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

          return option.fits.some((fit) => {
            const window = plan?.windows[fit.windowIndex]
            if (!window) return false
            return pick.startMin >= window.startMin && pick.endMin <= window.endMin
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
