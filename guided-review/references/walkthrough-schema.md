# Walkthrough JSON (`gr annotate`)

`gr annotate --file walkthrough.json` stores the walkthrough this session wrote (`--request <id>` when it answers a walkthrough request from the UI). Only `title` and `sections[].name`/`files` are required; everything else may be omitted.

```json
{
  "title": "One line describing the whole change",
  "summary": "2–4 sentences to read before anything else. Markdown allowed.",
  "sections": [
    {
      "id": "retry-policy",
      "name": "Retry policy",
      "desc": "One sentence: why this section matters to the reviewer.",
      "what": "Plain-language explanation of what changed and why. Markdown allowed. This is the narration.",
      "files": ["src/retry.ts", "tests/retry.test.ts"],
      "order": 1,
      "diagram": [
        { "label": "request()", "kind": "", "sub": "caller" },
        { "label": "withRetry()", "kind": "hi", "sub": "now linear backoff" },
        { "label": "RetryBudget", "kind": "new", "sub": "caps total attempts" }
      ],
      "insight": { "caption": "The one thing the diagram shows." },
      "plainNotes": [{ "file": "src/retry.ts", "note": "Per-file note shown on that file." }]
    }
  ],
  "questions": [
    { "id": "q1", "text": "Was switching from exponential to linear backoff deliberate?", "context": "Retry policy", "options": ["Yes, keep linear", "No, restore exponential"] }
  ],
  "planMap": {
    "acceptance": [{ "text": "Retries are capped at 5", "met": true }, { "text": "Backoff is exponential", "met": "partial" }],
    "steps": [{ "n": 1, "text": "Add RetryBudget", "sectionId": "retry-policy", "status": "done" }],
    "deviations": [{ "text": "Plan said exponential backoff; implementation is linear.", "sectionId": "retry-policy" }]
  },
  "artifactPaths": ["specs/retry/spec.md"]
}
```

## Field rules

- `sections[].files`: exact paths as printed by `gr diff --stat`. Each file belongs to one section.
- `sections[].id`: short stable slug. Comments and focus targets use it (`--section retry-policy`). Defaults to `s1`, `s2`, … if omitted.
- `diagram`: 2–5 nodes showing the mechanism. `kind` is `""` (plain), `"hi"` (the key node), or `"new"` (introduced by this change).
- `questions`: decisions only the author can make. Bugs and risks are not questions; put them in `what` or post them as comments. `options` (2–4) only when the plausible answers are clear.
- `planMap`: include only when a spec or plan exists. `met` is `true`, `false`, or `"partial"`. `status` is `done`, `changed`, or `missing`. `sectionId` must be one of your section ids (or `""`).
- `artifactPaths`: spec/plan files you found that `gr review` did not list. Only paths matching a recognised layout are accepted here (see "Spec and plan discovery" in cli.md); attach any other file with `gr artifact add PATH --role spec|plan`.

## What the server does with it

Git is the authority, so the walkthrough is reconciled, not trusted. `gr annotate` prints each correction:

- a file that is not in the diff is dropped from its section;
- a file listed in two sections stays in the first;
- a section left with no files is dropped;
- changed files you did not place go into a generated "Other changes" section, so every changed file is covered. Untracked files are the exception: unplaced untracked files stay out of the walkthrough and appear under "Excluded" in the UI;
- `planMap` references to unknown section ids are cleared.

Storing a walkthrough records the current compare commit as the "reviewed" state, which is the baseline `gr drift` measures against until the reviewer approves. Each `gr annotate` replaces the walkthrough and adds an entry to its history.

## Writing a good one

- Group by purpose, not by directory. 2–8 sections.
- Order by where attention pays off: core behaviour first, tests and config later.
- `what` explains behaviour and reasoning, not a restatement of the diff. Say what a caller now observes.
- Be specific to this codebase: name the functions, the callers you checked, and the tests that cover (or do not cover) the change.
- When a spec/plan exists, judge the implementation against it criterion by criterion and call out divergences.
