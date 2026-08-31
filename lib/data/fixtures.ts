/**
 * A small, realistic semester so every panel has something true-shaped to
 * render before Core ships the schema. Invented courses — **no real Duke data**
 * (vision §7: `fixtures/` holds the founder's stale snapshots; this file is
 * deliberately generic and safe to commit).
 *
 * Dates are generated relative to local midnight today so the fixtures never go
 * stale. Everything carries provenance, and the change feed exercises both tiers
 * of the apply rule (core.md "Two-tier apply rule").
 */

import type {
  Change,
  Course,
  Deadline,
  Provenance,
  Source,
  StudentSignal,
  Task,
} from "./types"

const STUDENT = "student_fixture"

/* ── date helpers ───────────────────────────────────────────────────────── */

function midnight(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

/** `at(2, 14, 30)` → ISO for 14:30 two days from today. */
function at(dayOffset: number, hour = 23, minute = 59): string {
  const d = midnight()
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString()
}

/* ── provenance shorthands ──────────────────────────────────────────────── */

function canvas(ref: string, snapshot: string, hours = 1): Provenance {
  return {
    source: "canvas",
    sourceRef: ref,
    confidence: 1,
    snapshotId: snapshot,
    observedAt: hoursAgo(hours),
  }
}

function syllabus(ref: string, confidence: number, hours = 96): Provenance {
  return {
    source: "syllabus",
    sourceRef: ref,
    confidence,
    snapshotId: "snap_syllabus_intake",
    observedAt: hoursAgo(hours),
  }
}

/** Signals are facts too: what was said or seen, where, and how sure. */
function signal(
  source: Provenance["source"],
  ref: string,
  hours: number,
  confidence = 1,
): Provenance {
  return {
    source,
    sourceRef: ref,
    confidence,
    snapshotId: "snap_signals_live",
    observedAt: hoursAgo(hours),
  }
}

/* ── courses ────────────────────────────────────────────────────────────── */

export const courses: Course[] = [
  {
    _id: "course_orgchem",
    studentId: STUDENT,
    name: "Organic Chemistry II",
    code: "CHEM 202",
    accent: "var(--accent)",
    sourceRefs: { canvasCourseId: "41207", icalUrl: "canvas://41207.ics" },
    gradingScheme: [
      { name: "Midterms", weight: 0.4 },
      { name: "Final exam", weight: 0.25 },
      { name: "Problem sets", weight: 0.2, dropRule: "lowest 2 dropped" },
      { name: "Lab reports", weight: 0.15 },
    ],
    status: "active",
    provenance: syllabus("CHEM-202-syllabus.pdf p.2", 0.94),
  },
  {
    _id: "course_algos",
    studentId: STUDENT,
    name: "Algorithms & Data Structures",
    code: "CS 231",
    accent: "var(--green)",
    sourceRefs: { canvasCourseId: "41338", siteUrl: "https://cs231.example.edu" },
    gradingScheme: [
      { name: "Programming assignments", weight: 0.45 },
      { name: "Midterm", weight: 0.2 },
      { name: "Final project", weight: 0.25 },
      { name: "Participation", weight: 0.1 },
    ],
    status: "active",
    provenance: canvas("courses/41338", "snap_canvas_0912", 2),
  },
  {
    _id: "course_micro",
    studentId: STUDENT,
    name: "Intermediate Microeconomics",
    code: "ECON 205",
    accent: "var(--orange)",
    sourceRefs: { canvasCourseId: "41102" },
    gradingScheme: [
      { name: "Problem sets", weight: 0.3, dropRule: "lowest 1 dropped" },
      { name: "Midterm", weight: 0.3 },
      { name: "Final exam", weight: 0.4 },
    ],
    status: "active",
    provenance: syllabus("ECON-205-syllabus.pdf p.1", 0.88),
  },
  {
    _id: "course_modernism",
    studentId: STUDENT,
    name: "Modernism & the City",
    code: "ENGL 118",
    accent: "var(--red)",
    sourceRefs: { icalUrl: "https://engl118.example.edu/feed.ics" },
    gradingScheme: [
      { name: "Response papers", weight: 0.3 },
      { name: "Seminar essay", weight: 0.45 },
      { name: "Seminar participation", weight: 0.25 },
    ],
    status: "active",
    provenance: syllabus("ENGL-118-syllabus.pdf p.3", 0.71),
  },
]

/* ── deadlines ──────────────────────────────────────────────────────────── */

export const deadlines: Deadline[] = [
  /* Organic Chemistry II */
  {
    _id: "dl_chem_ps7",
    courseId: "course_orgchem",
    title: "Problem Set 7 — carbonyl chemistry",
    kind: "homework",
    dueAt: at(1, 23, 59),
    pointsPossible: 40,
    category: "Problem sets",
    submissionStatus: "unsubmitted",
    provenance: canvas("assignments/908114", "snap_canvas_0912", 2),
  },
  {
    _id: "dl_chem_quiz5",
    courseId: "course_orgchem",
    title: "Quiz 5 (ch. 17–18)",
    kind: "quiz",
    dueAt: at(3, 10, 0),
    pointsPossible: 25,
    category: "Midterms",
    submissionStatus: "unsubmitted",
    provenance: canvas("assignments/908231", "snap_canvas_0912", 2),
  },
  {
    _id: "dl_chem_lab6",
    courseId: "course_orgchem",
    title: "Lab report 6 — Grignard synthesis",
    kind: "homework",
    dueAt: at(6, 17, 0),
    pointsPossible: 50,
    category: "Lab reports",
    submissionStatus: "unsubmitted",
    provenance: canvas("assignments/908277", "snap_canvas_0912", 2),
  },
  /* CHEM 202 Midterm 2 is deliberately absent: it exists only as the pending
   * `chg_chem_midterm_room` addition. Under the two-tier rule (core.md) an
   * LLM-interpreted `deadline_added` is held until approval, so materializing
   * it here would show an unapproved deadline as current course state.
   * `pendingChangeId` is for deadlines that already exist and may move. */
  {
    _id: "dl_chem_reading12",
    courseId: "course_orgchem",
    title: "Read ch. 18.4–18.9 before lecture",
    kind: "reading",
    dueAt: at(2, 9, 30),
    provenance: syllabus("CHEM-202-syllabus.pdf p.6", 0.63),
  },
  {
    _id: "dl_chem_ps8",
    courseId: "course_orgchem",
    title: "Problem Set 8 — amines",
    kind: "homework",
    dueAt: at(8, 23, 59),
    pointsPossible: 40,
    category: "Problem sets",
    provenance: canvas("assignments/908340", "snap_canvas_0912", 2),
  },

  /* Algorithms & Data Structures */
  {
    _id: "dl_cs_pa4",
    courseId: "course_algos",
    title: "PA4 — union-find & percolation",
    kind: "homework",
    dueAt: at(0, 23, 59),
    pointsPossible: 100,
    category: "Programming assignments",
    submissionStatus: "unsubmitted",
    provenance: canvas("assignments/771402", "snap_canvas_0912", 1),
  },
  {
    _id: "dl_cs_pa5",
    courseId: "course_algos",
    title: "PA5 — shortest paths",
    kind: "homework",
    dueAt: at(7, 23, 59),
    pointsPossible: 100,
    category: "Programming assignments",
    provenance: canvas("assignments/771455", "snap_canvas_0912", 1),
  },
  {
    _id: "dl_cs_midterm",
    courseId: "course_algos",
    title: "Midterm",
    kind: "exam",
    dueAt: at(10, 18, 0),
    pointsPossible: 150,
    category: "Midterm",
    provenance: canvas("assignments/771388", "snap_canvas_0912", 1),
  },
  {
    _id: "dl_cs_reading9",
    courseId: "course_algos",
    title: "Sedgewick §4.4 before Thursday",
    kind: "reading",
    dueAt: at(4, 9, 0),
    provenance: syllabus("CS-231-syllabus.pdf p.5", 0.68),
  },
  {
    _id: "dl_cs_proposal",
    courseId: "course_algos",
    title: "Final project proposal",
    kind: "project",
    dueAt: at(12, 23, 59),
    pointsPossible: 25,
    category: "Final project",
    provenance: canvas("assignments/771501", "snap_canvas_0912", 1),
  },
  {
    _id: "dl_cs_quiz3",
    courseId: "course_algos",
    title: "Section quiz 3",
    kind: "quiz",
    dueAt: at(5, 14, 0),
    pointsPossible: 20,
    category: "Participation",
    provenance: canvas("assignments/771470", "snap_canvas_0912", 1),
  },
  {
    _id: "dl_cs_pa3",
    courseId: "course_algos",
    title: "PA3 — priority queues",
    kind: "homework",
    dueAt: at(-3, 23, 59),
    pointsPossible: 100,
    category: "Programming assignments",
    submissionStatus: "graded",
    provenance: canvas("assignments/771350", "snap_canvas_0912", 1),
  },

  /* Intermediate Microeconomics */
  {
    _id: "dl_econ_ps5",
    courseId: "course_micro",
    title: "Problem Set 5 — consumer choice",
    kind: "homework",
    dueAt: at(1, 17, 0),
    pointsPossible: 30,
    category: "Problem sets",
    submissionStatus: "unsubmitted",
    provenance: canvas("assignments/650221", "snap_canvas_0912", 3),
  },
  {
    _id: "dl_econ_midterm",
    courseId: "course_micro",
    title: "Midterm",
    kind: "exam",
    dueAt: at(9, 13, 0),
    pointsPossible: 100,
    category: "Midterm",
    provenance: canvas("assignments/650190", "snap_canvas_0912", 3),
    pendingChangeId: "chg_econ_midterm_move",
  },
  {
    _id: "dl_econ_ps6",
    courseId: "course_micro",
    title: "Problem Set 6 — production",
    kind: "homework",
    dueAt: at(8, 17, 0),
    pointsPossible: 30,
    category: "Problem sets",
    provenance: canvas("assignments/650260", "snap_canvas_0912", 3),
  },
  {
    _id: "dl_econ_reading",
    courseId: "course_micro",
    title: "Varian ch. 6–7",
    kind: "reading",
    dueAt: at(3, 13, 0),
    provenance: syllabus("ECON-205-syllabus.pdf p.4", 0.59),
  },
  {
    _id: "dl_econ_ps4",
    courseId: "course_micro",
    title: "Problem Set 4 — budget sets",
    kind: "homework",
    dueAt: at(-6, 17, 0),
    pointsPossible: 30,
    category: "Problem sets",
    submissionStatus: "graded",
    provenance: canvas("assignments/650180", "snap_canvas_0912", 3),
  },
  {
    _id: "dl_econ_final",
    courseId: "course_micro",
    title: "Final exam",
    kind: "exam",
    dueAt: at(58, 9, 0),
    pointsPossible: 200,
    category: "Final exam",
    provenance: syllabus("ECON-205-syllabus.pdf p.2", 0.83),
  },

  /* Modernism & the City */
  {
    _id: "dl_engl_response4",
    courseId: "course_modernism",
    title: "Response paper 4 — Mrs Dalloway",
    kind: "homework",
    dueAt: at(2, 12, 0),
    pointsPossible: 20,
    category: "Response papers",
    submissionStatus: "unsubmitted",
    provenance: {
      source: "ical",
      sourceRef: "event-assignment-88231",
      confidence: 1,
      snapshotId: "snap_ical_0912",
      observedAt: hoursAgo(5),
    },
  },
  {
    _id: "dl_engl_reading_ulysses",
    courseId: "course_modernism",
    title: "Ulysses — 'Lestrygonians' + Kenner essay",
    kind: "reading",
    dueAt: at(4, 12, 0),
    provenance: syllabus("ENGL-118-syllabus.pdf p.7", 0.55),
  },
  {
    _id: "dl_engl_essay_outline",
    courseId: "course_modernism",
    title: "Seminar essay outline",
    kind: "project",
    dueAt: at(11, 12, 0),
    pointsPossible: 15,
    category: "Seminar essay",
    provenance: syllabus("ENGL-118-syllabus.pdf p.8", 0.66),
  },
  {
    _id: "dl_engl_essay",
    courseId: "course_modernism",
    title: "Seminar essay (4,000 words)",
    kind: "project",
    dueAt: at(31, 12, 0),
    pointsPossible: 100,
    category: "Seminar essay",
    provenance: syllabus("ENGL-118-syllabus.pdf p.8", 0.66),
  },
  {
    _id: "dl_engl_response5",
    courseId: "course_modernism",
    title: "Response paper 5 — The Waste Land",
    kind: "homework",
    dueAt: at(9, 12, 0),
    pointsPossible: 20,
    category: "Response papers",
    provenance: {
      source: "ical",
      sourceRef: "event-assignment-88304",
      confidence: 1,
      snapshotId: "snap_ical_0912",
      observedAt: hoursAgo(5),
    },
  },
  {
    _id: "dl_engl_presentation",
    courseId: "course_modernism",
    title: "Seminar presentation slot",
    kind: "other",
    dueAt: at(14, 12, 0),
    category: "Seminar participation",
    provenance: syllabus("ENGL-118-syllabus.pdf p.9", 0.48),
  },
]

/* ── tasks (the plan, from Core's planner) ──────────────────────────────── */

export const tasks: Task[] = [
  {
    _id: "task_cs_pa4",
    studentId: STUDENT,
    courseId: "course_algos",
    deadlineId: "dl_cs_pa4",
    title: "Finish PA4 — percolation stats + writeup",
    type: "do",
    status: "in_progress",
    plannedFor: at(0, 14, 0),
    estEffortMin: 120,
    createdBy: "agent",
  },
  {
    _id: "task_chem_ps7",
    studentId: STUDENT,
    courseId: "course_orgchem",
    deadlineId: "dl_chem_ps7",
    title: "Problem Set 7, questions 1–6",
    type: "do",
    status: "todo",
    plannedFor: at(0, 17, 30),
    estEffortMin: 90,
    createdBy: "agent",
  },
  {
    _id: "task_econ_ps5",
    studentId: STUDENT,
    courseId: "course_micro",
    deadlineId: "dl_econ_ps5",
    title: "ECON 205 Problem Set 5",
    type: "do",
    status: "todo",
    plannedFor: at(0, 20, 0),
    estEffortMin: 60,
    createdBy: "agent",
  },
  {
    _id: "task_chem_read",
    studentId: STUDENT,
    courseId: "course_orgchem",
    deadlineId: "dl_chem_reading12",
    title: "Read ch. 18.4–18.9 before tomorrow's lecture",
    type: "prepared",
    status: "todo",
    plannedFor: at(0, 21, 30),
    estEffortMin: 45,
    createdBy: "agent",
  },
  {
    _id: "task_cs_review",
    studentId: STUDENT,
    courseId: "course_algos",
    deadlineId: "dl_cs_quiz3",
    title: "Review shortest-path proofs for section quiz",
    type: "prepared",
    status: "todo",
    plannedFor: at(1, 15, 0),
    estEffortMin: 60,
    createdBy: "agent",
  },
  {
    _id: "task_engl_response",
    studentId: STUDENT,
    courseId: "course_modernism",
    deadlineId: "dl_engl_response4",
    title: "Draft response paper 4",
    type: "do",
    status: "todo",
    plannedFor: at(1, 19, 0),
    estEffortMin: 75,
    createdBy: "agent",
  },
  {
    _id: "task_chem_quiz_prep",
    studentId: STUDENT,
    courseId: "course_orgchem",
    deadlineId: "dl_chem_quiz5",
    title: "Quiz 5 prep — carbonyl mechanisms",
    type: "prepared",
    status: "todo",
    plannedFor: at(2, 16, 0),
    estEffortMin: 60,
    createdBy: "agent",
  },
  {
    _id: "task_cs_pa3_done",
    studentId: STUDENT,
    courseId: "course_algos",
    deadlineId: "dl_cs_pa3",
    title: "PA3 — priority queues",
    type: "do",
    status: "done",
    plannedFor: at(-3, 15, 0),
    estEffortMin: 120,
    actualEffortMin: 205,
    createdBy: "agent",
  },
]

/* ── changes ────────────────────────────────────────────────────────────── */

export const changes: Change[] = [
  /* needs_approval / pending — syllabus & schedule parses chat couldn't confirm */
  {
    _id: "chg_econ_midterm_move",
    studentId: STUDENT,
    courseId: "course_micro",
    deadlineId: "dl_econ_midterm",
    kind: "deadline_moved",
    summary: "ECON 205 midterm may move from Thursday to the following Monday",
    fields: [
      { field: "dueAt", before: at(9, 13, 0), after: at(13, 13, 0) },
      { field: "location", before: "Gross 103", after: "Gross 107" },
    ],
    origin: "site",
    tier: "needs_approval",
    status: "pending",
    toolLabel: "crawled course site",
    confidence: 0.62,
    snapshotIds: ["snap_site_econ_0911", "snap_site_econ_0912"],
    at: hoursAgo(6),
  },
  {
    _id: "chg_engl_schedule_parse",
    studentId: STUDENT,
    courseId: "course_modernism",
    kind: "grading_scheme_parsed",
    summary: "ENGL 118 grading scheme read from the syllabus — three categories",
    fields: [
      { field: "Response papers", before: null, after: "30%" },
      { field: "Seminar essay", before: null, after: "45%" },
      { field: "Seminar participation", before: null, after: "25%" },
    ],
    origin: "syllabus",
    tier: "needs_approval",
    status: "pending",
    toolLabel: "parsed syllabus",
    confidence: 0.71,
    snapshotIds: ["snap_syllabus_intake"],
    at: hoursAgo(20),
  },
  {
    _id: "chg_chem_midterm_room",
    studentId: STUDENT,
    courseId: "course_orgchem",
    /* no `deadlineId`: approving this change is what creates the deadline */
    kind: "deadline_added",
    summary: "CHEM 202 Midterm 2 read off the syllabus — evening slot, not on Canvas",
    fields: [
      { field: "dueAt", before: null, after: at(16, 19, 0) },
      { field: "pointsPossible", before: null, after: "200" },
    ],
    origin: "syllabus",
    tier: "needs_approval",
    status: "pending",
    toolLabel: "parsed syllabus",
    confidence: 0.91,
    snapshotIds: ["snap_syllabus_intake"],
    at: hoursAgo(20),
  },

  /* auto / applied — structured sources, already in state */
  {
    _id: "chg_cs_pa5_added",
    studentId: STUDENT,
    courseId: "course_algos",
    deadlineId: "dl_cs_pa5",
    kind: "deadline_added",
    summary: "New from Canvas: PA5 — shortest paths",
    fields: [{ field: "dueAt", before: null, after: at(7, 23, 59) }],
    origin: "canvas",
    tier: "auto",
    status: "applied",
    toolLabel: "polled Canvas",
    snapshotIds: ["snap_canvas_0911", "snap_canvas_0912"],
    at: hoursAgo(1),
  },
  {
    _id: "chg_chem_ps7_moved",
    studentId: STUDENT,
    courseId: "course_orgchem",
    deadlineId: "dl_chem_ps7",
    kind: "deadline_moved",
    summary: "Problem Set 7 moved a day later",
    fields: [{ field: "dueAt", before: at(0, 23, 59), after: at(1, 23, 59) }],
    origin: "canvas",
    tier: "auto",
    status: "applied",
    toolLabel: "polled Canvas",
    snapshotIds: ["snap_canvas_0911", "snap_canvas_0912"],
    at: hoursAgo(2),
  },
  {
    _id: "chg_cs_pa3_graded",
    studentId: STUDENT,
    courseId: "course_algos",
    deadlineId: "dl_cs_pa3",
    kind: "grade_posted",
    summary: "PA3 graded — 94/100",
    fields: [{ field: "score", before: null, after: "94" }],
    origin: "canvas",
    tier: "auto",
    status: "applied",
    toolLabel: "polled Canvas",
    snapshotIds: ["snap_canvas_0912"],
    at: hoursAgo(9),
  },
  {
    _id: "chg_econ_ps4_graded",
    studentId: STUDENT,
    courseId: "course_micro",
    deadlineId: "dl_econ_ps4",
    /* the transition is to `graded`, so the kind is `grade_posted` — a feed
     * filter that trusts `kind` must not read a grade event as a submission */
    kind: "grade_posted",
    summary: "Problem Set 4 grade posted",
    fields: [
      { field: "submissionStatus", before: "submitted", after: "graded" },
    ],
    origin: "canvas",
    tier: "auto",
    status: "applied",
    toolLabel: "polled Canvas",
    snapshotIds: ["snap_canvas_0912"],
    at: hoursAgo(30),
  },
  {
    _id: "chg_engl_response4_added",
    studentId: STUDENT,
    courseId: "course_modernism",
    deadlineId: "dl_engl_response4",
    kind: "deadline_added",
    summary: "New from the ENGL 118 calendar feed: response paper 4",
    fields: [{ field: "dueAt", before: null, after: at(2, 12, 0) }],
    origin: "ical",
    tier: "auto",
    status: "applied",
    toolLabel: "read iCal feed",
    snapshotIds: ["snap_ical_0912"],
    at: hoursAgo(5),
  },
  {
    _id: "chg_chat_skip",
    studentId: STUDENT,
    courseId: "course_orgchem",
    kind: "chat_decision",
    summary: "You said you'd push the ch. 18 reading to tomorrow — replanned",
    fields: [{ field: "plannedFor", before: at(-1, 20, 0), after: at(0, 21, 30) }],
    origin: "chat",
    tier: "needs_approval",
    status: "approved",
    toolLabel: "confirmed in the thread",
    snapshotIds: [],
    at: hoursAgo(14),
  },
]

/* ── sources ────────────────────────────────────────────────────────────── */

export const sources: Source[] = [
  {
    _id: "src_canvas",
    studentId: STUDENT,
    kind: "canvas",
    label: "Canvas",
    detail: "Personal access token · canvas.example.edu",
    lastPolledAt: hoursAgo(0.4),
    health: "healthy",
    covers: ["CHEM 202", "CS 231", "ECON 205"],
  },
  {
    _id: "src_ical",
    studentId: STUDENT,
    kind: "ical",
    label: "Course calendar feed",
    detail: "engl118.example.edu/feed.ics",
    lastPolledAt: hoursAgo(5),
    health: "healthy",
    covers: ["ENGL 118"],
  },
  {
    _id: "src_syllabi",
    studentId: STUDENT,
    kind: "syllabus",
    label: "Syllabi",
    detail: "4 PDFs uploaded at onboarding",
    lastPolledAt: hoursAgo(20),
    health: "degraded",
    covers: ["CHEM 202", "CS 231", "ECON 205", "ENGL 118"],
    note: "2 parses are waiting on your approval — grading scheme and one exam date.",
  },
  {
    _id: "src_site",
    studentId: STUDENT,
    kind: "site",
    label: "ECON 205 course site",
    detail: "econ205.example.edu · crawled nightly",
    lastPolledAt: hoursAgo(6),
    health: "failing",
    covers: ["ECON 205"],
    note: "Last crawl returned a login wall. Dates from this site are frozen at the 11th.",
  },
  {
    _id: "src_schedule",
    studentId: STUDENT,
    kind: "schedule",
    label: "Weekly class schedule",
    detail: "Uploaded image · 12 hard blocks",
    lastPolledAt: null,
    health: "never_synced",
    covers: ["All courses"],
    note: "One-time upload. These blocks are what the planner refuses to schedule over.",
  },
]

/* ── signals (read-only here; every surface writes them, vision §4b) ─────── */

export const studentSignals: StudentSignal[] = [
  {
    _id: "sig_pacing_cs",
    studentId: STUDENT,
    kind: "pacing",
    text: "said 2h, took 3h25 on PA3",
    courseId: "course_algos",
    taskId: "task_cs_pa3_done",
    origin: "observed",
    observedAt: hoursAgo(70),
    provenance: signal("canvas", "task_cs_pa3_done/completion", 70),
  },
  {
    _id: "sig_difficulty_chem",
    studentId: STUDENT,
    kind: "difficulty",
    text: "asked about carbonyl mechanisms three times this week",
    courseId: "course_orgchem",
    origin: "workspace",
    observedAt: hoursAgo(26),
    provenance: signal("chat", "workspace/course_orgchem", 26, 0.8),
  },
  {
    _id: "sig_availability",
    studentId: STUDENT,
    kind: "availability",
    text: "not free Thursday evenings this month",
    origin: "chat",
    observedAt: hoursAgo(48),
    provenance: signal("chat", "thread/2026-08-29", 48),
  },
]
