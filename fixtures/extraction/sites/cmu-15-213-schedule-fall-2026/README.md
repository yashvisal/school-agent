# Fixture: CMU 15-213 course-site schedule (Fall 2026)

- Source URL: https://www.cs.cmu.edu/~213/schedule.html
- Fetched: 2026-08-31
- License: public CMU course website; no explicit license stated. Retained here as a short
  excerpt for extraction testing only.
- Kind: hand-edited course website schedule (stands in for a scraped course site, not an LMS)

Why this fixture is interesting: it is a dense date-keyed grid where one row can carry several
distinct facts — a lecture topic, a reading range, an assignment *release* ("L2 (bomblab)
out"), and an assignment *due* ("L1 due") — so it tests out-vs-due disambiguation, multiple
items per date ("L3 due, L4 (cachelab) out"), and lab-shorthand-to-title resolution
("L5a (malloc checkpoint) due"). It also contains no-class rows (fall break, Democracy Day,
Thanksgiving) that must not become deliverables, an exam row ("In-class Midterm"), and a due
date that lands on a no-class day. Every date is month + day with **no year**, so the
extractor must carry the term from context rather than guessing one, and must not roll Dec
dates back into the prior year.
