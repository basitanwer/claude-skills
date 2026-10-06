---
name: guided-review
description: Open a local visual code-review webapp for any git commit, commit range, branch, or uncommitted working-tree changes, then explain the change as a guided walkthrough grouped by purpose, post comments beside the code, answer questions in context, track new changes since the last review, and apply reviewer feedback on request. Use when the user asks to review, walk through, or explain a commit, range, branch, or their working tree visually or "in the review UI"; invokes /guided-review (HEAD, a SHA, A..B, a branch, --working-tree, --resume); wants to resume a saved review; asks what changed since they last reviewed or approved; or wants queued review comments addressed.
---

# Guided review

A local webapp (browser UI on `127.0.0.1`) that this session drives through a CLI bridge, `scripts/gr`. There is no separate review engine: **this session is the reviewer's agent.** It writes the walkthrough, posts the comments, and answers whatever the reviewer asks in the UI. Git is the authority for every diff; the app stores only the review layer (walkthrough, comments, conversation, viewed marks, approvals) as local JSON.

`gr` below means `<this skill's directory>/scripts/gr`. Run it from inside the repository under review, or pass `--repo DIR`. Full command reference and exact comparison semantics: [references/cli.md](references/cli.md).

## Rules

- **Read-only by default.** Reviewing and explaining never edits repository files. Edit only for an apply request or when the user asks. Commit only when the user (or the request) says to commit.
- **Never approve on your own.** `gr approve` is for when the user explicitly says to approve; finishing a walkthrough is not approval.
- **Never invent diff content.** Anchor comments and focus targets to real lines of changed files: the lines `gr diff` printed, or, for unchanged code around them, the file's actual line numbers (read the file first). Pass `--expect` with text from that line. The server copies the line from git and rejects a file that did not change, a line that does not exist, or a failed `--expect`; when it does, re-read instead of adjusting numbers by guesswork.
- **Say what was compared.** `gr review` prints `note:` lines describing the comparison (frozen vs moving sides, root/merge handling). Relay them.
- If `gr` reports the web UI is not built, run `scripts/install.sh` once. `gr doctor` diagnoses problems.

## Arguments

| Invocation | Comparison |
|---|---|
| `/guided-review HEAD` or `abc123` or a tag | That one commit against its parent (root commit: against the empty tree; merge: against its first parent). Both sides frozen. |
| `/guided-review A..B` (also `HEAD~5..HEAD`) | What `B` adds since it diverged from `A`. A branch name is a moving side, anything else is frozen; `--freeze` pins branch names; `--direct` compares the two endpoints as they are. |
| `/guided-review <branch>` | That branch against the default branch (`--base REF` to change). |
| `/guided-review --working-tree` | Uncommitted changes (staged, unstaged, untracked) against `HEAD`. `--base REF` widens it to commits plus uncommitted changes since `REF`. |
| `/guided-review --resume` | The most recently used saved review for this repo. `--resume A..B` resumes that exact comparison; `--resume --list` lists them. |

Pass the user's argument to `gr review` unchanged. With no argument, ask what to review, offering `--working-tree` if `git status` is dirty and the current branch against the default branch otherwise.

## Workflow

1. **Open.** `gr review <args>` starts the server if needed, creates or resumes the review, and opens the browser. It prints the session, file counts, discovered spec/plan files, and notes. `EMPTY DIFF` means there is nothing to review: tell the user and stop. A resumed review reporting `NEW SINCE LAST REVIEW` goes to step 6 first.

2. **Understand.** `gr diff` prints the git diff with old/new line numbers (`--stat` for the file list, `--file P` for one file). Read changed files in full, grep callers and tests, and read `git log`/`git show` for the range. Read any spec/plan `gr review` listed; attach one it missed with `gr artifact add PATH --role spec|plan`.

3. **Write the walkthrough.** Write the JSON described in [references/walkthrough-schema.md](references/walkthrough-schema.md) to a temp file and store it with `gr annotate --file <json>`. Group files by what they accomplish together, lead with the part that most deserves attention, and assess the change against the spec/plan when one exists. The server reconciles it against git and prints what it corrected.

4. **Comment beside the code.** For each concrete finding: `gr comment --file P --line N --expect "<text on that line>" --text "…"`. `--side old` targets a removed line. Other anchors: `--file P` (whole file; the only option for binaries), `--section ID`, `--summary`, `--question ID`, `--artifact PATH --line N` (a spec/plan line). Keep comments to things worth the reviewer's attention; narration belongs in the walkthrough.

5. **Listen for the reviewer.** Run `gr wait` **in the background** and tell the user the review is ready. It returns when the reviewer asks for something in the UI, printing one `REQUEST <id> <kind>` block per request with the exact command that completes it:

   | Kind | What the reviewer did | Do this |
   |---|---|---|
   | `question` | Asked something, possibly about a specific line | Investigate, then `gr answer <id> --text "…"`; add `--file P --line N` to point at the code you cite. |
   | `walkthrough` | Asked for a walkthrough, or an update after changes | Step 3 (for an update, read `gr drift` first), then `gr annotate --file <json> --request <id>`. |
   | `apply` | Sent queued comments to be addressed | Step 7, then `gr done <id>`. |
   | `decisions` | Answered the walkthrough's open questions | Fold the answers into the walkthrough (`gr annotate`), `gr resolve` each, then `gr done <id>`. |

   For work that takes more than a few seconds, post `gr progress <id> "what you are doing"` between steps; it shows live in the UI and is also how a cancellation reaches you (exit code 130: stop that request). If you cannot complete one, `gr fail <id> --text "why"`. After handling the requests, run `gr wait` in the background again. Questions the user asks in the terminal are answered here as usual; move the UI while explaining with `gr focus --file P --line N` or `gr tour --stop "path:line | note" --stop …`.

6. **New changes.** `gr drift` shows commits and the exact delta since the last reviewed or approved state, and which viewed files changed. Explain the delta and refresh the walkthrough (`gr annotate` again). `gr comments --status outdated` lists comments whose line no longer exists; report them as stale, never re-attach them.

7. **Apply feedback, only when asked** (an `apply` request, or the user asking in the terminal; `gr comments --status queued` lists what is waiting). For each comment: make the edit with your normal tools, then record the outcome with `gr resolve <commentId> --verdict addressed|reworked|skipped --note "…"`. Use `gr reply <commentId> --text "…"` when the answer is an explanation, not a change. Leave edits uncommitted unless the request says `commit: yes` or the user tells you to commit; then stage only the files you changed (the tree may hold the user's own uncommitted work), commit, and add `--sha <commit>` to the resolutions. Finish by listing every comment with its verdict.

## Reporting back

After opening or resuming, tell the user: what is being compared (from the notes), the UI URL, what you did (walkthrough written, N comments), and that you are listening for requests from the UI. State plainly anything `gr` refused or reported as unsupported.

## Other references

- [references/cli.md](references/cli.md): every command, comparison semantics, edge cases, the request protocol, storage, environment, and the HTTP contract.
- [references/walkthrough-schema.md](references/walkthrough-schema.md): the walkthrough JSON and how to write a good one.
- [references/feature-matrix.md](references/feature-matrix.md): what is covered, how each feature was verified, and known limitations. Read when the user asks whether something is supported.
