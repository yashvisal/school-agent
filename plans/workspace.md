# Workspace — The Course Builder

> Inherits [vision.md](./vision.md) (esp. §4b signals, §8 surfaces and the scope rule, §10 truth rule and isolation). Siblings: [core.md](./core.md), [voice.md](./voice.md), [face.md](./face.md), [roadmap.md](./roadmap.md). **As of 2026-09-04 this doc supersedes face.md's "Milestone 3 — workspaces come alive" and the course-workspace bullet in vision §8.** Milestone 3: "it prepares".

## Goal

The course workspace is where the agent **builds things for the student and the student works on them**: documents, spreadsheets, slide decks, chats — each open as a **tab in the viewport**, each **filed in the course's Library**. Not one artifact type at a time behind a chat; a builder with the right tools, scoped to one course and one student.

**Exit test (M3):** a planned `prepared` task exists ("review deck for Midterm 1, from the lecture slides"). Overnight the workspace agent builds the deck from that course's Canvas captures and files it under the exam's folder. The morning text mentions it. The student opens it in a tab, asks the rail chat to shorten slide 3, edits a bullet by hand, and downloads a `.pptx`. Everything they did wrote signals. Nothing they did required naming, saving, or choosing a folder.

## What changed, and why (2026-09-04)

Before: M3 was one narrow artifact kind (primer / review outline / lesson) rendered as prose, and vision §12 deferred "generic-workspace features" until usage proved students wanted to write rather than read. **Decision: the workspace is a builder from the start.** The differentiator is *the plan makes the thing* — and "the thing" is whatever a student would otherwise open Google Docs, Sheets, or Slides to make. A chat that can only talk about a primer is the pull-tool shape we said we would not compete in. So the agent gets tools to build documents, sheets, and decks, the viewport gets editors for them, and the student can edit directly.

What does **not** change:

- **Scope rule (vision §8).** No planning tools in this agent, ever. "What should I do / when" is a thread question.
- **Truth rule (vision §10).** Convex holds every artifact; the sandbox filesystem is a materialized view; an agent write is a Convex write with a filesystem side effect.
- **Isolation.** One sandbox per session (student × course), verified in Spike B.
- **Every exchange writes signals** (vision §4b). Building alongside the student is the richest cognitive-signal source we will have: what they asked for, what they edited, where they stalled.
- **No goal-driven tutoring** (vision §12). A lesson is still one kind of document, always the fulfilment of a planned task.

## The shape — tabs over a Library

Course mode already has a chat tab strip in the viewport (`lib/workspace/chat-tabs.ts`, sessionStorage, UI state only). That strip becomes the **open-items strip**: any Library item opens as a tab.

| Tab kind   | Viewport                                | Editable by student | Built by agent |
| ---------- | --------------------------------------- | ------------------- | -------------- |
| `chat`     | conversation (today's `chat-transcript`) | —                   | —              |
| `document` | markdown editor                          | yes                 | yes            |
| `sheet`    | grid editor                              | yes                 | yes            |
| `deck`     | slide editor                             | yes                 | yes            |
| `file`     | PDF / image / Canvas capture viewer      | no                  | no             |

The rail carries **Context** (sources with provenance) and **Tasks** (this course's plan, read-only, from Core), and, whenever a non-chat tab is active, the **artifact-scoped chat** — the agent talking about the thing in the viewport ("shorten slide 3", "explain the formula in B4"). That is exactly vision §8's rail rule; it was written for this.

Sidebar in course mode stays **Overview · Library · Chats**. Chats remain their own list: they are items, but conversational ones deserve their own section. Whether Chats eventually folds into Library as a folder is open (see Open questions).

**Tab state is UI state.** Which items *exist* is Convex; which tabs are *open* is this browser tab's business. Closing a tab never loses anything, because nothing lives only in a tab (see Filing).

## Artifact kinds and their representation (decided, with one confirm)

Kinds: `document`, `sheet`, `deck`, `chat`, `file`.

**Canonical content is structured and lives in Convex. Office formats are exports, never the source.**

- `document` — markdown, with optional frontmatter for lesson structure (parts, progress).
- `sheet` — a JSON grid: cells with values and formulas as strings, column/row metadata. Export → `.xlsx`.
- `deck` — a JSON slide model: slides with title, body blocks, speaker notes, image refs into Convex storage. Export → `.pptx`.
- `file` — the raw bytes (Canvas capture, upload, texted-in attachment) in Convex storage; markdown rendering via AnyDoc where useful.

Why structured-in-Convex rather than real Office files built in the sandbox:

1. **The truth rule.** A `.pptx` blob is opaque. The agent cannot "shorten slide 3" against it without a round trip through a parser, versions cannot be diffed, and nothing about it is a fact Core can reason over.
2. **Artifact-scoped chat needs structure.** Every rail-chat edit is a patch to a model, streamed into the open tab. That only works if there is a model.
3. **The viewport editors need a model too.** A student editing a bullet is editing the same JSON the agent edits.
4. **Export is cheap and gives the student the file they actually hand in or present from.** The sandbox has a runtime; `python-pptx`, `openpyxl`, `python-docx` (or their Node equivalents) turn the model into a file on request. Exports are stored in Convex storage and downloaded from there.

Alternative considered: build real Office files in the sandbox and preview them. Fastest to demo, worst to iterate; kept as the export path only. **Confirm:** if the founder specifically wants the agent to author *native* `.pptx`/`.xlsx` so they open in PowerPoint/Excel with full fidelity, the export path is where that fidelity is earned, not the canonical model.

**Student editing is in.** This reverses vision §12's earlier deferral, decided with the rest of this doc. The editors exist so the student can work on what the agent built; they are not a productivity suite (see "Not building").

## Core: artifacts are content, not obligations

New table **`artifacts`** — studentId, courseId, kind, title, `folderPath`, `forTaskId?`, `forDeadlineId?`, `builtFrom?` (material ids), content (inline for small documents/sheets/decks; `storageId` when large), `version`, createdBy (`agent | student`), createdAt, updatedAt, lastOpenedAt. Exports are separate storage rows referenced from the artifact (`exports: [{ format, storageId, version, at }]`) so a stale export is visibly stale.

**Artifacts are written directly, like `materials`, not through `changes`.** core.md already carves this out for raw captures: they are content, not facts about the student's obligations; nothing to approve, nothing the planner reads. The same holds for a deck. The `changes` rule covers student *state*.

**One thing an artifact does change:** a `prepared` task's status. When an artifact linked to `forTaskId` is saved, Core emits a `task_updated` change (new origin `workspace`, tier `auto` — it is an observation that the work exists, not an interpretation of anything the student said) so the plan, the Dashboard, and the morning text all see "the deck is ready" without the workspace agent holding a planning tool. Core owns that rule; the agent only saves.

**Chats become durable in the same slice:** a `chats` table (studentId, courseId, title, eveSessionId, streamCursor, createdAt, lastMessageAt, `producedArtifactIds`) so a chat entry reopens where it was left (`initialSession` + `resume`, per face.md Spike B). The fixture-backed `useCourseChats` hook is replaced by a subscription; nothing in the UI moves.

**Library = one query over three tables**, per course: `materials` (Canvas captures), uploads (`sources` with storage), `artifacts` — each carrying a `folderPath`. Existing `materials` rows get a default folder ("From Canvas", mirroring the Canvas module name when present); uploads and texted-in files go to "Yours".

Versions: `version` counter and the previous `storageId` kept on the row. Full history is deferred until a student asks for it.

## Filing — where things go (the hard part, v0 proposal)

This is the piece the founder flagged as needing the most work. Two constraints pull against each other: vision §3.1 says never make the student tell the system things a system should know, and a Drive with no structure is a junk drawer that nobody opens twice.

**v0 rules — to be tested, not defended:**

1. **Every artifact is born filed.** There is no untitled, unsaved, "where do you want this?" limbo. The agent names it and places it at creation; the tab header always shows the path (`Library / Midterm 1 / review deck`). Opening in a tab and filing in the Library are the *same event*.
2. **Placement is derived from what the artifact is *for*, in this order:** the task or deadline it fulfils → a folder named for that deadline ("Midterm 1", "PS4"); else the material it was built from → that material's folder; else the course root.
3. **The course root has few, fixed folders** — `From Canvas` (captures, read-only, structured by Canvas modules when they exist), `Yours` (uploads, texted-in files, student-made items), and **one folder per deadline the agent has built for**. Not a free-form tree in v0. Folders appear when something is in them and never as empty scaffolding.
4. **The student can rename or move anything, once, and it sticks.** A move writes the new `folderPath` and a `preference` signal ("keeps psets in one folder"); the agent files the next one accordingly. Nothing is ever asked.
5. **Chats are filed only when they produced something**; the artifact carries `producedBy: chatId`, and the chat stays in Chats. A chat that produced nothing lives only in Chats.
6. **Nothing is deleted by the agent.** Archive is a student action; archived items leave the Library listing and stay in Convex.

Alternatives, kept close because `folderPath` is a string and switching is cheap: (a) ask at save time — rejected, it is the Notion-template death in miniature; (b) a flat, recency-sorted list with search and by-deadline filters, no folders at all — the fallback if folders prove wrong in the first pilot. Decide after watching five students use it, not before.

## The agent's tools

Today `agent/workspace/tools/` holds three Spike B probes (`write_marker`, `list_workspace`, `teardown`) and a stubbed `propose_change`. The probes are deleted once the real tools land. Target surface:

| Tool                                   | Does                                                                                                        | Writes to Core |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------- |
| *(hydrate, in `onSession`)*            | `state.md`, `signals.md`, materials manifest, artifacts manifest into `/workspace`                            | no             |
| `read_material(id)`                    | fetch one material's bytes / markdown on demand (manifest + fetch-on-demand, face.md)                        | no             |
| `create_artifact(kind, title, for?, content)` | the write path; Core save is the event, the `/workspace` file is the side effect                     | `artifacts`    |
| `update_artifact(id, patch)`           | a structured patch (replace slide 3's body, set B4); streams into the open tab                               | `artifacts`    |
| `export_artifact(id, format)`          | build `.docx` / `.xlsx` / `.pptx` / `.pdf` in the sandbox → Convex storage → download link                   | `artifacts.exports` |
| `propose_change`                       | fact fixes when a material contradicts `state.md` (exists; must call Core's `changes.propose`)              | `changes`      |
| `record_signal`                        | cognitive signals: what they asked, where they stalled, what they edited (vision §4b)                        | `studentSignals` |

No planning tools. The scope rule is enforced by this table, not by the prompt.

eve's built-in file and bash tools stay enabled for this agent (unlike Voice, which disables every built-in) because export generation runs inside the sandbox — but **artifacts are committed only through `create_artifact` / `update_artifact`.** A file the agent wrote to `/workspace` and never committed does not exist. Egress stays `deny-all`.

Every model call logs to Core's `usage` table (`hooks/usage.ts` is a console stub today; that is a Core-side write before any student uses this).

## Face: the editors

- **Document** — a markdown editor. Candidates: TipTap/ProseMirror; Convex's `prosemirror-sync` component is worth a look for agent-and-student edits to the same document without a merge story of our own.
- **Sheet** — a grid component with values and simple formulas; no pivots, no charts in v0. The agent writes formulas as strings; the grid evaluates.
- **Deck** — a slide-model renderer with an inline editor for title/body/notes; thumbnails in a strip; export button.
- **File** — PDF and image viewer for captures and uploads.
- **Agent edits stream into the open tab.** `lib/eve/reduce.ts` already maps `dynamic-tool` parts by `toolName`; `update_artifact` parts become editor patches with a visible "the agent is editing" state, and the approval primitive is reused wherever an edit should be confirmed rather than applied.

**Paper first.** Artboards needed before build: Library with folders (normal week, hell week, mid-semester), a document tab, a deck tab, a sheet tab, and the "agent building in a tab" state. The rail's artifact-scoped chat appears on each.

## Sequencing

Prerequisites are Slices 0–2 in [roadmap.md](./roadmap.md): a deployment, a correct daily loop, onboarding. Then, in order:

1. **Core** — `artifacts` and `chats` tables; the Library query; save / patch / export mutations; the `workspace` origin and the prepared-task rule; usage rows from the workspace agent.
2. **Agent** — real `hydrateWorkspace`; the tool table above; usage hook writes Convex; Clerk verifier on the browser channel (today it fails closed in any deployment); spike probes deleted.
3. **Face** — Library as a real listing with folders; tabs generalized from chats to items; document editor and file viewer; streaming agent edits.
4. **Face** — deck editor, then sheet editor. Deck first: it is the artifact students most visibly cannot make by hand in the time they have.
5. **The loop closes** — Voice's feasible set can carry a `prepared` option; the nightly pass creates the task; the workspace agent fulfils it before the planned window; the morning text says where it is.

Each step is one PR, mergeable alone, and no step lands a control that does nothing.

## Not building (M3)

- A productivity suite. Editors exist so the student can work on what the agent built for a course; features with no tie to a course, a material, or a task — arbitrary file management, sharing, real-time collaboration, comments — are out.
- Cross-course artifacts. An artifact belongs to one course; "study everything" is a thread question and a Dashboard view, not a workspace.
- Full version history, templates, themes, and formatting fidelity beyond what the export libraries give for free.
- Ingesting a student's *edits* as facts. Editing a deck writes signals, not state.

## Open questions

- **Filing v0 vs flat-and-search** — decide after the first pilot, not before.
- **Editor libraries** — TipTap vs a lighter markdown editor; which grid; whether `prosemirror-sync` fits.
- **Export runtime** — confirm Python (or Node equivalents) availability and cost on Vercel Sandbox; the export path is the one place fidelity is earned.
- **Chats as Library items** — keep the section, or fold in once Library is real?
- **Student-initiated artifacts** — "new doc" with no agent involvement is allowed; where does it file? (v0: `Yours`.)
- **What "built from" means for provenance** — `builtFrom` is a list of material ids today; is a per-slide citation worth the model cost?
- **How much of the workspace state the *thread* should know** — "your deck is ready" is one line; should Voice ever summarise what was built?
