---
name: novsky-memory
description: Recall confirmed owner decisions and maintain durable topic notes with scoped local or semantic search.
---

Use memory-search with the host-authenticated current chat, then memory-open for the complete source. Do not infer a fact is absent from an empty first query; try the topic's concrete names and synonyms. Report only dates visible in the source. Save useful confirmed conclusions in the owner's topic vault, keeping sources and uncertainty. Never persist secrets. Core USER/MEMORY changes and reusable learned procedures require the learning-review workflow.

For a reusable solution, find the existing note first and preserve its path under `Теми/<topic>/`. Use this Markdown format, filling every section with actual evidence in the owner's language:

```markdown
---
kind: solution
status: draft
verified_at: YYYY-MM-DD
---
# Short problem name

## Problem
What failed and the environment/version where this applies.

## Solution
What successfully resolved it.

## Verification
The check actually performed, its date and observed result.

## Sources
Exact source paths or links, with dates/revisions where relevant.
```

Set `status: verified` only after the check succeeds and replace the date placeholder with its real date. Draft, incomplete and retired solutions are excluded from recall; the owner can still inspect and edit them in Novsky Vault. Correct the same file, replacing stale conclusions and recording new evidence/date; use `status: retired` when it should no longer be recalled. Use memory_search after saving to refresh the index, then memory_open to inspect the current source.

Verification records past evidence, never permission or a guarantee that a procedure still applies. Before reuse, reopen its sources and check the current environment; missing, changed or inaccessible sources need fresh verification. Promote a repeated procedure into an existing skill through learning-review with the owner's review. Do not turn every conversation into a lesson or copy private lessons into company-shared/ without owner authorization.
