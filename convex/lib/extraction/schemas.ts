import { z } from "zod"

/**
 * The zod schemas the ingestion LLM extracts into (core.md "Adapters" #3-5).
 *
 * vision §9: **the LLM at ingestion extracts; it does not infer.** Every shape
 * here is built around that rule:
 *
 * - `sourceText` is REQUIRED on every extracted item and must quote the
 *   document verbatim. It is what makes the extraction contestable — a student
 *   (or a reviewer) can see the exact sentence a deadline came from, and an
 *   item with no quotable sentence is an invention, not a fact.
 * - `confidence` is REQUIRED and is the *model's own* number. `provenanceV`
 *   documents that confidence is a source fact, never fabricated downstream;
 *   this is the one place a real number enters the system for LLM-derived facts.
 * - `dueDate` is a plain string here rather than a `.regex()`-constrained one on
 *   purpose. Resolution ("Sept 15" → an instant) happens in OUR code
 *   (`normalize.ts`), not the model's: a value the model could not state
 *   unambiguously must fail our validation and be dropped, not fail the whole
 *   extraction and lose the other 30 items with it.
 */

export const extractedKindSchema = z.enum([
  "homework",
  "project",
  "exam",
  "quiz",
  "reading",
  "other",
])

export type ExtractedKind = z.infer<typeof extractedKindSchema>

const dueDate = z
  .string()
  .describe(
    "The due date as YYYY-MM-DD, and ONLY when the document itself states the " +
      "year. If the document writes a month and day with no year (\"Oct 14\", " +
      "\"Tuesday, April 29\"), leave this out and use dueMonthDay instead. " +
      "Never guess a year."
  )
  .optional()

/**
 * The overwhelmingly common case in a real syllabus: "Midterm: Tuesday, April
 * 29". Reported separately so the model never has to guess a year, and the year
 * is resolved from the student's own term window in `normalize.ts`.
 */
const dueMonthDay = z
  .string()
  .describe(
    "The due date as MM-DD when the document states a month and day but NO " +
      "year. Omit when the document states the year (use dueDate) or states no " +
      "calendar date at all."
  )
  .optional()

const dueTime = z
  .string()
  .describe(
    "The due time as 24-hour HH:MM, only when the document states one. Omit otherwise."
  )
  .optional()

export const extractedDeadlineSchema = z.object({
  title: z.string().describe("The item's title as the document names it."),
  kind: extractedKindSchema,
  dueDate,
  dueMonthDay,
  dueTime,
  pointsPossible: z
    .number()
    .describe("Points or marks the document assigns this item, if stated.")
    .optional(),
  category: z
    .string()
    .describe(
      "The grading category this item belongs to, using the document's own " +
        "category name (e.g. \"Problem Sets\"), if stated."
    )
    .optional(),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "How confident you are that this item, its kind, and its date are what " +
        "the document actually says. 1 = stated outright; 0.5 = implied but " +
        "hedged. Do not report high confidence for anything you inferred."
    ),
  sourceText: z
    .string()
    .describe(
      "The snippet of the document this item came from, quoted VERBATIM. If " +
        "you cannot quote it, do not emit the item."
    ),
  pageRef: z
    .string()
    .describe("Page number or section heading the snippet came from, if known.")
    .optional(),
})

export type ExtractedDeadline = z.infer<typeof extractedDeadlineSchema>

export const gradingCategorySchema = z.object({
  name: z.string().describe("The category name as the document writes it."),
  weight: z
    .number()
    .describe(
      "The category's share of the final grade as the document states it — a " +
        "percentage (30 for \"30%\") or a fraction (0.3 for \"0.3\"). Omit when " +
        "the document does not state a weight."
    )
    .optional(),
  dropLowest: z
    .number()
    .describe("How many lowest scores are dropped, if the document says so.")
    .optional(),
})

export const gradingSchemeSchema = z.object({
  categories: z.array(gradingCategorySchema),
  notes: z
    .string()
    .describe("Any stated caveat about grading that is not a category weight.")
    .optional(),
})

export const syllabusExtractionSchema = z.object({
  course: z.object({
    name: z.string().describe("The course title as the document names it."),
    code: z
      .string()
      .describe("The course number/code (e.g. \"18.06\", \"STA 210\"), if stated.")
      .optional(),
  }),
  gradingScheme: gradingSchemeSchema.optional(),
  deadlines: z.array(extractedDeadlineSchema),
  policies: z
    .object({
      lateWork: z.string().describe("The late-work policy, quoted or paraphrased closely.").optional(),
      attendance: z.string().describe("The attendance policy.").optional(),
    })
    .optional(),
})

export type SyllabusExtraction = z.infer<typeof syllabusExtractionSchema>

export const scheduleBlockSchema = z.object({
  dayOfWeek: z
    .number()
    .min(0)
    .max(6)
    .describe("0 = Sunday, 1 = Monday, … 6 = Saturday."),
  startTime: z.string().describe("Start of the block, 24-hour HH:MM."),
  endTime: z.string().describe("End of the block, 24-hour HH:MM."),
  label: z.string().describe("What meets in this block — the course code and/or name."),
  confidence: z.number().min(0).max(1),
  sourceText: z.string().describe("The row or cell this block came from, quoted VERBATIM."),
})

export const scheduleExtractionSchema = z.object({
  blocks: z.array(scheduleBlockSchema),
  timezoneNote: z
    .string()
    .describe("Any timezone the schedule states. Do not guess one.")
    .optional(),
})

export type ScheduleExtraction = z.infer<typeof scheduleExtractionSchema>
export type ExtractedBlock = z.infer<typeof scheduleBlockSchema>
