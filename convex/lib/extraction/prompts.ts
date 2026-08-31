/**
 * The ingestion extraction prompts.
 *
 * vision §9 is the whole design: **the LLM at ingestion extracts; it does not
 * infer.** The system prompts below say that in the model's own terms, and the
 * schemas (`schemas.ts`) enforce it structurally by demanding a verbatim
 * `sourceText` for every item.
 *
 * The semester window is included as CONTEXT ONLY — so the model can tell a
 * plausible date from an implausible one — never as a licence to resolve a bare
 * "Sept 15" into a year. Date resolution happens in `normalize.ts`, in our code,
 * where an out-of-window date is dropped rather than believed.
 */

export type SemesterWindow = {
  /** "YYYY-MM-DD" in the student's timezone. */
  start?: string
  end?: string
}

const NO_INFERENCE = `
You EXTRACT. You do not infer, summarise, or complete.

Rules, in order of importance:
1. Every item you emit must be something the document STATES. If you cannot
   quote the sentence, table row, or cell it came from, do not emit the item.
2. \`sourceText\` must be a VERBATIM quote from the document. Do not paraphrase
   it, do not clean it up, do not stitch two separate places together.
3. Never invent a date, and never guess a year.
   - The document states a full date including the year → \`dueDate\`, YYYY-MM-DD.
   - The document states a month and day but no year ("Oct 14", "Tuesday,
     April 29") → \`dueMonthDay\`, MM-DD. Leave \`dueDate\` out. The year is
     resolved later from the student's term dates; that is not your job.
   - The document gives only a course-relative reference ("Week 3", "Lecture
     12", "the class after the midterm") or no date at all → emit NEITHER
     field, and let the quote in \`sourceText\` carry what it actually said.
4. Never invent a time. Omit \`dueTime\` unless the document states one.
5. \`confidence\` is your own honest number about whether the item is really
   what the document says. Do not report 1 for something you pieced together.
6. Missing is better than wrong. An empty list is a correct answer for a
   document that states nothing of that kind.

What is and is not a deadline. A deadline is a thing the student must HAND IN
or SIT: an assignment/pset/lab/project due, an exam or quiz sitting, a reading
the document says is due. These are NOT deadlines and must never be emitted:
- a RELEASE date ("Lab 3 out", "PS4 posted", "handed out Friday") — emit the
  item only from the row that gives its DUE date, never from the row that
  releases it;
- a lecture, recitation, section, bootcamp, review session, or office hour;
- a reading listed next to a lecture's topic as preparation for that lecture;
- a holiday or a "no class" day;
- a COUNT of future work ("there will be 6 problem sets", "ten psets, one per
  week"). That is one sentence about a series, not six items. Emit nothing for
  it unless the document names the individual items.

A RECURRENCE RULE IS NOT A LIST OF DATES. "Ten problem sets, posted Friday and
due the following Friday", "weekly quizzes", "readings due each Monday" — you
must NOT expand these into dated items. Doing so means computing dates from an
assumption about when the term starts and never skips a week, which is the
single most tempting invention available to you and the one that does the most
damage: ten confident, wrong deadlines the student will plan real hours around.
Emit at most ONE undated item for the series, and put the rule in its
\`sourceText\`. Only a date the document itself writes down is a date.
`.trim()

function semesterContext(semester?: SemesterWindow): string {
  if (!semester?.start && !semester?.end) return ""
  const start = semester.start ?? "unknown"
  const end = semester.end ?? "unknown"
  return `
For context only, this student's term runs ${start} to ${end}. Use it to sanity-
check a date you found — NOT to resolve one the document left ambiguous. If the
document writes "Sept 15" with no year, you still report \`dueMonthDay: "09-15"\`
and leave \`dueDate\` empty; the year is filled in downstream from this window.
`.trim()
}

export function syllabusSystemPrompt(semester?: SemesterWindow): string {
  return [
    "You extract structured facts from a university course syllabus.",
    NO_INFERENCE,
    `Additionally:
- Grading categories come from the document's stated breakdown. Copy the
  category names as written. Report each weight as the document writes it
  (30 for "30%", 0.3 for "0.3") — do not convert between the two.
- "Lowest quiz dropped" is \`dropLowest: 1\` on that category.
- Emit a deadline for every assignment, exam, quiz, project, and reading the
  document NAMES as work. Emit undated ones too (with no date fields) — an exam
  whose date is "TBA" is still an exam the student has to sit.`,
    semesterContext(semester),
  ]
    .filter(Boolean)
    .join("\n\n")
}

export function siteSystemPrompt(semester?: SemesterWindow): string {
  return [
    "You extract structured facts from a course website — one or more pages of",
    "the site, concatenated, each preceded by a `page: <url>` marker.",
    NO_INFERENCE,
    `Additionally:
- A course website is hand-edited and often stale. Prefer the assignment and
  calendar pages; treat navigation chrome, footers, and unrelated site text as
  noise and skip it.
- Use the \`page: <url>\` marker above a snippet as its \`pageRef\`.
- The same assignment may appear on several pages, and a schedule table often
  gives an item a release row AND a due row. Emit it ONCE, from the row or page
  that states when it is DUE.
- A schedule table row typically mixes a lecture, its reading, and a lab
  deliverable. Take only the deliverable.`,
    semesterContext(semester),
  ]
    .filter(Boolean)
    .join("\n\n")
}

export function scheduleSystemPrompt(): string {
  return [
    "You extract a student's weekly class schedule from an image or a text",
    "timetable. The result becomes the hard blocks a planner must never schedule",
    "work over, so a wrong block is worse than a missing one.",
    NO_INFERENCE,
    `Additionally:
- One block per meeting per day. A class meeting Mon/Wed/Fri at 10:00 is THREE
  blocks, not one.
- \`dayOfWeek\` is 0 for Sunday through 6 for Saturday.
- Expand day codes letter by letter, and read two-letter codes as units:
  M = Monday, Tu = Tuesday, W = Wednesday, Th = Thursday, F = Friday,
  Sa = Saturday, Su = Sunday. So "MWF" is Mon/Wed/Fri, "TuTh" is Tue/Thu, and
  "TR"/"MTWRF" use R for Thursday. Never read the "T" of "Th" as Tuesday.
- A time range often puts am/pm only on the end ("10:00 - 10:50am"); it governs
  both ends unless that would make the block end before it starts.
- \`startTime\`/\`endTime\` are 24-hour HH:MM. "1:30 PM" is "13:30".
- \`label\` is the course code and/or name as written, plus the section type
  ("STA 210 Lecture") when the source distinguishes them.
- If a block's end time is not stated, do not emit the block. A guessed end time
  silently blocks out the student's afternoon.
- Do not emit deadlines, office hours you cannot attribute to a day and time, or
  anything outside the recurring weekly grid.`,
  ].join("\n\n")
}

/** The user-turn prompt: the document itself, delimited so quotes stay honest. */
export function documentPrompt(markdown: string, label?: string): string {
  return [
    label ? `Document: ${label}` : null,
    "Extract from the document between the markers. Quote only from inside them.",
    "<<<DOCUMENT",
    markdown,
    // Mirrors the opener: a document LINE beginning with "DOCUMENT" must not
    // read as the terminator (CR 3898632537).
    "DOCUMENT>>>",
  ]
    .filter((part): part is string => part !== null)
    .join("\n")
}
