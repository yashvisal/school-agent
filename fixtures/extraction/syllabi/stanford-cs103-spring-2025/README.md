# Fixture: Stanford CS103 syllabus (Spring 2025)

- Source URL: https://web.stanford.edu/class/archive/cs/cs103/cs103.1256/syllabus
- Fetched: 2026-08-31
- License: public Stanford course archive page; no explicit license stated. Retained here as a
  short excerpt for extraction testing only.
- Kind: university syllabus page with explicit exam dates

Why this fixture is interesting: it pairs a top-level percentage split (20/75/5) with a
*nested* weighting inside one category (exams are 1/6, 1/3, 1/2 of the exam score, i.e.
12.5% / 25% / 37.5% of the course), plus non-linear score transforms (square-root PSet
averaging, a `min{1, …}` participation formula whose "-3" is an implicit drop-3). It has three
explicitly dated exams with weekday + month + day + time but **no year**, and a recurring
"posted Friday, due the following Friday at 1:00 PM Pacific" rule with no enumerated dates —
so it tests both date normalization under a missing year and recurrence without invented
instances. The late policy contains a struck-through edit ("~~24 hours~~ 48 hours").
