# Walkthrough JSON (`gr annotate`)

`gr annotate --file walkthrough.json` stores the walkthrough this session wrote (`--request <id>` when it answers a walkthrough request from the UI). Only `title` and `sections[].name`/`files` are required; everything else may be omitted.

```json
{
  "title": "One line describing the whole change",
  "summary": "Two or three plain sentences to read before anything else. Markdown allowed.",
  "sections": [
    {
      "id": "retry-policy",
      "name": "Retry policy",
      "desc": "One sentence: why this section matters to the reviewer.",
      "what": "- Three to six short bullets in plain words: what this part does, what is different now, what to look at first.\n- Markdown. This is the narration.",
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
  "factCheck": {
    "checked": 37,
    "rows": [{ "statement": "Retries back off exponentially.", "where": "README.md:42", "contradicts": "src/retry.ts:18", "why": "withRetry() now waits attempt × 200 ms, which is linear.", "group": "changed" }]
  },
  "artifactPaths": ["specs/retry/spec.md"]
}
```

## Field rules

- `sections[].files`: exact paths as printed by `gr diff --stat`. Each file belongs to one section.
- `sections[].id`: short stable slug. Comments and focus targets use it (`--section retry-policy`). Defaults to `s1`, `s2`, … if omitted.
- `diagram`: 2–5 nodes showing the mechanism. `kind` is `""` (plain), `"hi"` (the key node), or `"new"` (introduced by this change).
- `questions`: decisions only the author can make. `options` (2–4) only when the plausible answers are clear. Bugs and risks are not questions: at effort level `bugs` they are posted as comments once checked (`gr comment --finding bug`); at `read` and `check` the pass does not look for them and posts none.
- `planMap`: include only when a spec or plan exists. `met` is `true`, `false`, or `"partial"`. `status` is `done`, `changed`, or `missing`. `sectionId` must be one of your section ids (or `""`).
- `factCheck`: from effort level `check` up. The statements that do not hold against the code, each with where it stands and the line that contradicts it; `group` is `"changed"` (this change made it false) or `"already"` (it was false before). Fields, method and the `update` form are in [effort-levels.md](effort-levels.md). Leave the key out at `read`: a walkthrough stored without it leaves a stored fact check as it is.
- What a level leaves out: at `read`, no `questions` and no `planMap`.
- `artifactPaths`: spec/plan files you found that `gr review` did not list. Only paths matching a recognised layout are accepted here (see "Spec and plan discovery" in cli.md); attach any other file with `gr artifact add PATH --role spec|plan`.

## What the server does with it

Git is the authority, so the walkthrough is reconciled, not trusted. `gr annotate` prints each correction:

- a file that is not in the diff is dropped from its section;
- a file listed in two sections stays in the first;
- a section left with no files is dropped;
- changed files you did not place go into a generated "Other changes" section, so every changed file is covered. Untracked files are the exception: unplaced untracked files stay out of the walkthrough and appear under "Excluded" in the UI;
- `planMap` references to unknown section ids are cleared;
- in `factCheck`, a path git does not have or a line that does not exist is taken out of its row (the row stays), the text of each line is copied from git, and every `changed` row whose contradicting line is part of the diff gets a note beside that line, written by the server.

Storing a walkthrough records the current compare commit as the "reviewed" state, which is the baseline `gr drift` measures against until the reviewer approves. Each `gr annotate` replaces the walkthrough and adds an entry to its history. Pass `--model "<the model that wrote it>"`: the page shows it beside the walkthrough.

## Writing a good one

Write for a reviewer who has not read the code and has five minutes. A walkthrough that reads like the code in prose is not read.

- **Short.** `summary`: two or three sentences (under 450 characters): what the change is for, and the one thing to know before reading. `desc`: one short sentence. `what`: three to six bullets (under 700 characters), each one or two lines. No paragraph per file.
- **Bullets, not blocks.** `what` is a Markdown list. One bullet per thing the reviewer should know: what this part does, what is different now, what to look at first.
- **Plain words first.** Say what happens, as you would to a colleague from another team: "asks the top-level categories first, then only the children of what was picked". Name a function, flag or file only when the reviewer needs the name to find something, and then one or two per section, not all of them.
- **Leave out** what the reviewer can read in the code: every helper, every option, constants, retry and error-handling mechanics, how a value is passed along. If it is worth knowing about one file, it goes in that file's `plainNotes` (one or two sentences, shown on the file), not in `what`.
- **Group by purpose, not by directory.** 2–8 sections, ordered by where attention pays off: core behaviour first, tests and config later.
- From effort level `check` up, when a spec/plan exists, judge the implementation against it criterion by criterion (`planMap`) and call out divergences. At `read` the walkthrough explains and judges nothing: no `planMap`, no `questions`, no verdicts in `what`.

A `what` of the right size:

```markdown
- Runs a sample of products through the model, one level of the category tree at a time.
- Asks the 24 top-level categories first, keeps at most 3, then asks only about their children.
- Saves every raw answer, so the picking rule can be changed later without paying for new calls.
- Start with `run-jev.mjs`; the other three files are what it calls.
```

`gr annotate` says "too long" for a summary, a narration or a file note over its limit. Nothing is cut: shorten those texts and store the walkthrough again.
