# weekly-grid-text

- **Source:** hand-authored, 2026-08-31. Not fetched from anywhere — it is a
  synthetic stand-in for the printed schedule a student information system
  emits, in the shape core.md "Adapters" #5 describes ("uploaded image/file").
  Contains no real student data.
- **Why it is authored rather than fetched:** a real class schedule is by
  definition one student's private timetable; there is no public one to check
  in. The image path is exercised by the same fixture converted to markdown, so
  the *extraction contract* is tested without shipping a student's week.

## What it exercises

- **Multi-day day-codes.** `MWF`, `TuTh`, `MW` must each expand into one block
  PER DAY, not one block per row: 3 + 1 + 2 + 2 + 1 = NINE blocks from five rows
  is the whole assertion.
- **`Tu` vs `Th` disambiguation** — the classic off-by-one that silently moves a
  class, and the reason the planner's hard-constraint guarantee needs a correct
  grid rather than a plausible one.
- **12-hour → 24-hour conversion** (`1:30 - 3:20pm` → `13:30`–`15:20`), and a
  morning range whose meridiem appears only on the end time
  (`10:00 - 10:50am`).
- **Non-round times** (`1:25 - 2:40pm`, `3:05 - 5:35pm`) — a model rounding to
  the half hour is a wrong hard constraint.
- **Negative case:** the "Notes" section mentions office hours and a start week.
  Neither is a weekly block; emitting either is a precision failure.
