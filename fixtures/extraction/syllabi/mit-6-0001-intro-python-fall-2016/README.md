# Fixture: MIT 6.0001 syllabus (Fall 2016)

- Source URL: https://ocw.mit.edu/courses/6-0001-introduction-to-computer-science-and-programming-in-python-fall-2016/pages/syllabus/
- Fetched: 2026-08-31
- License: MIT OpenCourseWare, CC BY-NC-SA 4.0
- Kind: university syllabus page (grading policy, no calendar)

Why this fixture is interesting: it exercises grading-category extraction from a clean
percentage table that sums to exactly 100%, plus two non-trivial policy shapes — an
accumulating late-day budget and a "drop up to 2 problem sets, roll their weight into the
final quiz" rule (a weight-transfer variant of drop-lowest, not a plain drop). Critically it
contains **zero calendar dates**: every deliverable is course-relative, so a correct extractor
must produce dateless items rather than inventing due dates.
