# `gr` reference

Contents: [Install and launch](#install-and-launch) · [Comparison semantics](#comparison-semantics) · [Edge cases](#edge-cases) · [Commands](#commands) · [Effort levels](#effort-levels) · [Requests from the reviewer](#requests-from-the-reviewer) · [Anchors](#anchors) · [Spec and plan discovery](#spec-and-plan-discovery) · [State and identity](#state-and-identity) · [Environment](#environment) · [HTTP contract](#http-contract) · [What costs Claude usage](#what-costs-claude-usage)

## Install and launch

```bash
~/.claude/skills/guided-review/scripts/gr doctor     # verify
~/.claude/skills/guided-review/scripts/install.sh    # only if the web UI is not built
~/.claude/skills/guided-review/scripts/demo.sh       # optional: the full loop on a throwaway repo
```

Requirements: Node 20 or newer and `git`. The server and `gr` have no dependencies. `npm` is needed only to rebuild the web UI (`install.sh --rebuild`).

From Claude Code: `/guided-review <args>` inside a repository. From a shell: `gr review <args>`. The server starts on demand and binds `127.0.0.1` only (default port 8791, next free port if taken). It stops by itself after 30 minutes with no browser tab and no `gr listen` / `gr wait` connected and no request. `gr stop` stops it at once, but one server serves every review on the machine, so it is refused while any review tab or listener is connected, the caller's own included (`gr stop --force` overrides); any `gr` command starts it again, and nothing is lost because every change is written to disk as it happens. Log: `<home>/server.log`.

## Comparison semantics

Every review is a (base, compare) pair. Each side is a **moving branch** (the review follows the branch tip, and its working tree when the branch is checked out) or a **frozen commit**. A side is moving only when it is exactly a local branch name; a SHA, tag, `HEAD`, `HEAD~N`, or any other expression is frozen at the commit it resolves to when the review is created.

| `gr review …` | base | compare | Notes |
|---|---|---|---|
| `HEAD`, `abc123`, `v1.2` | the commit's parent, frozen | the commit, frozen | One historical commit. |
| …a root commit | the empty tree | the commit, frozen | Every file shows as added. |
| …a merge commit | first parent, frozen | the merge, frozen | What the merge brought in. For the other side use `<parent2>..<merge>`. |
| `A..B`, `A...B` | `A` | `B` | Diff is merge-base(A, B) → B: what `B` adds since it diverged from `A`. Identical to `git diff A B` whenever `A` is an ancestor of `B`. `A..` means `A..HEAD`. |
| `A..B --direct` | `A` | `B` | The two endpoints compared as they are (`git diff A B`), including what only `A` has. |
| `<branch>` | default branch (`main`, else `master`, else first branch) | the branch, moving | `--base REF` overrides the base. The default branch itself is reviewed as its tip commit. |
| `--working-tree` | `HEAD`, frozen at its current commit | current branch, moving (or the working tree itself when `HEAD` is detached) | `HEAD` → working tree: staged, unstaged and untracked changes. |
| `--working-tree --base REF` | `REF` | as above | Commits since `REF` plus uncommitted changes. |

Flags: `--effort read|check|bugs` sets how far the review pass goes (see [Effort levels](#effort-levels); a new review runs at `check`). `--freeze` pins any branch name to its current commit. `--new` starts a second review of the same pair instead of resuming. `--no-open` skips the browser. `--force` opens an empty diff anyway.

**Uncommitted changes.** Whenever the compare side is a branch that is checked out (in the main checkout or a linked worktree), its uncommitted changes are part of the review. Each changed line is then labelled `committed`, `staged`, or `unstaged`. Untracked files appear as fully added files (over 2 MB or containing NUL bytes: listed as binary). The reviewer can exclude an untracked file in the UI, and untracked files the walkthrough does not place in a section are left out. There is no separate staged-only or unstaged-only comparison: both are shown together, distinguished by label.

## Edge cases

| Case | Behaviour |
|---|---|
| Root commit | Supported (empty-tree base). |
| Merge commit | First-parent diff, stated in the notes. |
| Rename | One file with `renamed from <old>`; addressable by either path. Pure renames have no line changes. |
| Deleted file | Shown with its removed lines; comment with `--side old`. |
| Binary file | Listed as `binary`, no line diff. File-level comments only; a line anchor is refused. |
| Mode-only change | Listed with `mode 100644 → 100755`. |
| No trailing newline | Diffed normally. |
| Empty diff | `EMPTY DIFF` is printed and no session is created. |
| Paths with spaces | Supported in repository paths and file names. |
| Unrelated histories | Compared against the empty tree; stated in the notes. |
| Detached `HEAD` | Commits and the working tree are both reviewable. |
| Deleted branch / pruned commit on resume | The review opens with a warning naming the missing side; the compare side can be re-targeted in the UI. |
| Unmerged (conflicted) files | Shown with a conflict flag; the diff includes the conflict markers. |

Not supported, and reported as such instead of guessed at:

- Combined (`--cc`) diffs for merge commits.
- Staged-only or unstaged-only comparisons.
- Remote-tracking refs as a *moving* side: `origin/main` works but is frozen at its current commit.
- Submodule contents, and SHA-256 object-format repositories.

## Commands

Common options: `--repo DIR` (default: cwd), `--session N` (default: the review last opened for this repo), `--json`, `--owner ID` (which Claude Code session is calling; default: the session id Claude Code puts in the environment, see [Requests from the reviewer](#requests-from-the-reviewer)).

**Reviews**

| Command | Purpose |
|---|---|
| `review <spec> [--base REF] [--freeze] [--direct] [--new] [--no-open] [--effort read\|check\|bugs]` | Open or resume a comparison; opens the browser. Prints the effort level, what it covers, and what is still to do at it. |
| `review --resume [SPEC] [--list] [--effort LEVEL]` | Reopen the latest saved review, a specific comparison, or list them. With `--effort`, raise or lower its level. |
| `effort [read\|check\|bugs]` | Show the current review's level and where each part of the pass stands (done for this state, for an earlier one, or not yet); with a level, change it. |
| `effort --done bugs --model M` | Record that the bug hunt was done at the current state, on model `M`. |
| `sessions [--include-archived]` · `archive [N]` · `unarchive N` | Manage saved reviews (archive is a soft delete). |
| `open` | Open the current review in the browser. |
| `diff [--file P] [--stat]` | The git diff with old/new line numbers and line labels. |
| `state` | Walkthrough, spec/plan check, viewed files, comments, conversation, requests, approval. `--json --full` dumps everything. |
| `drift` | New commits and the exact delta since the reviewed/approved state; files changed since they were marked viewed. |

**Walkthrough, comments, UI**

| Command | Purpose |
|---|---|
| `annotate --file F.json` (`-` = stdin) `[--request ID] [--model M]` | Store the walkthrough (see walkthrough-schema.md), and the fact check when the JSON has `factCheck`. `--model`: the model that wrote it, shown beside it in the page. |
| `factcheck --file F.json` (`-` = stdin) `[--model M]` | Store the fact check on its own: `{ "rows": […], "checked": N }` (see effort-levels.md). The rows are checked against git; a row this change made false gets a note beside the line that contradicts it. |
| `visualize --file F.json` (`-` = stdin) `[--request ID]` | Store diagrams of the whole change: architecture, data flow, function calls (see visual-schema.md). Paths and lines are checked against git (only git: the file system is not asked about a path); each box's status comes from the diff. A `visualize` request is completed only by this command, not by `annotate --request`. |
| `artifact add PATH --role spec\|plan` · `artifact remove PATH` · `artifact list` | Attach or detach spec/plan files the review is judged against. |
| `comment <anchor> --text T [--expect TEXT] [--as user] [--queued] [--finding bug]` | Add a comment. From this session it is a `note`; `--queued` or `--as user` puts it in the reviewer's queue. `--finding bug` labels it as a defect the bug hunt confirmed. Every comment of the session records the state of the code it was written at. |
| `comments [--status note\|queued\|sent\|answered\|resolved\|outdated]` | List comments. |
| `reply ID --text T` · `resolve ID --verdict addressed\|reworked\|skipped --note T [--changed "path:start-end" …] [--sha C]` · `reopen ID` · `delete-comment ID` | Manage a comment thread and its resolution. `--changed` (repeatable; `path:line` or `path:start-end`) names the lines edited for the comment, which the page offers as jumps to the fix: see [Where the fix is](#requests-from-the-reviewer). |
| `focus <anchor>` | Take every open tab of this review to a spot and highlight it. Code is shown in the Code pane and the Guide beside it does not move; a section or the summary is shown in the Walkthrough Guide. The jump is one step of the browser's Back, which returns the Code pane to where it was. Opens a tab if none is open. |
| `tour --stop "path:line[:old] \| note" …` or `--file stops.json` | A 2–8 stop walkthrough card in the UI. Stops may also be `section:ID`, a bare path, or `summary`. `--loop` to cycle. Each stop moves the page as `focus` does; the whole tour is one step of the browser's Back. |
| `say "text"` | Show a transient status line in the UI. |
| `note "text" [<anchor>]` | Add a message to the review's conversation without a request, e.g. to record an answer given in the terminal. |
| `viewed --file P [--unset]` · `section-reviewed ID [--unset]` | Set review-tracking marks (normally the reviewer does this in the UI). |
| `approve --confirmed-by-user` · `unapprove` | Record or withdraw approval of the exact current state. Refused without the flag. |

**Requests** (see next section): `listen [--on-change]`, `wait [--timeout S] [--on-change]`, `requests [--all]`, `answer REQ --text T [<anchor>] [--stop …]`, `progress REQ "text"`, `done REQ [--text T]`, `fail REQ --text reason`, `batch --file ops.json`.

**Server**: `serve [--port N]`, `stop [--force]`, `status`, `doctor`, `rpc <channel> '[json args]'` (raw call).

Exit codes: `0` ok, `1` usage error or refused, `3` server unreachable, `130` the reviewer cancelled the request.

## Effort levels

`--effort` says how far a review pass (the walkthrough, the fact check, the bug hunt) goes. The levels add up; [effort-levels.md](effort-levels.md) says how each part is done.

| Level | Covers | Runs on |
|---|---|---|
| `read` | the walkthrough only | Sonnet (a subagent the session starts) |
| `check` (default) | the walkthrough and a fact check | Sonnet (a subagent the session starts) |
| `bugs` | the walkthrough, a fact check and a bug hunt | the session's model |

- **Stored with the review.** A new review gets the level named, or `check` (also when it is started from the page). Resuming keeps the stored level; `--effort` on a resume, or `gr effort LEVEL`, raises or lowers it from then on. Raising adds only what the higher level adds; lowering removes nothing. A review made before effort levels has none until `gr review --resume`, which gives it `check` and says so.
- **Per part, what was done.** The review records for each level the state its part was last done at, when, and on which model: `read` when a walkthrough is stored, `check` when a fact check is stored (even an empty one), `bugs` by `gr effort --done bugs`. `--model` on those commands is the model that did the work; it is recorded as given, and as "not recorded" when left out (`gr` then says so), never assumed from the level. A walkthrough from before effort levels counts as done, with no model recorded: it is not owed again.
- **The fact check** is a list of rows: a statement that does not hold, where it stands, the line of code that contradicts it, what the code does instead, and the group, "made false by this change" or "was already false". The server checks it as it checks a walkthrough: a path must be one git has on the compare side (git alone is asked about a file the diff does not hold), a line must exist, and its text is copied from git; what cannot be confirmed is taken out of the row and reported, and the row stays. The list is stored apart from the walkthrough (`state.factCheck`), so a later walkthrough leaves it. At most 100 rows.
- **Notes beside the code come from the rows.** For every "made false by this change" row whose contradicting line is part of the diff, the server writes one comment on that line (`finding: "fact"`). Storing the fact check again keeps the two in step: a row given again keeps its id and its note; the note of a row that is gone is deleted unless somebody replied to it. With `"update": true` the stored rows stay unless given again or named in `"retire"`; a fact check that comes with the answer to an update request is an update unless it says `"update": false`. Without it the list is replaced and `gr` says how many earlier rows went. A fact check with a row that has no `statement` is refused whole, so that a malformed one is never stored as "nothing found". A row follows its note: when the note is re-anchored after the code moved, the row names the same line. A comment can only be anchored in a changed file or an attached spec or plan, which is why a statement in a README outside the diff is a row of the list and not a comment on the README.
- **Findings carry their state.** Every comment written by the session, and every fact check row, records the compare commit and the fingerprint of the code at that moment. Once the code has changed, a finding says "found at `<commit>`, an earlier state" in the page and in `gr state` / `gr comments`; nothing is removed.
- **A walkthrough request carries the level.** Its event has `"effort"`, and its `do` field says who does the work: at `read` and `check` a Sonnet subagent, with the `--session` and `--owner` its `gr` calls need (the request is held by the session that claimed it, so the subagent's calls have to carry that session's id); at `bugs` the session itself.
- **An older server.** One server serves every session and outlives an update of the skill. Against a server older than 0.3.0, `gr review` opens the review without a level and says the server has to be restarted; `gr effort`, `gr factcheck`, `gr annotate` with a `factCheck`, and `gr comment --finding` are refused with the same advice, since the older server would accept the last two and drop the finding.

## Requests from the reviewer

The page cannot do agent work itself. What the reviewer does there that needs Claude Code becomes a **request**, stored in the review, that the attached session receives and completes with one command. Walkthrough, question, and apply are distinct kinds with distinct completions.

| Kind | Created by | Carries | Completed by |
|---|---|---|---|
| `walkthrough` | Ask for / Update walkthrough | optional steer; `update` flag; `effort` (the review's level) | `gr annotate --file F --request ID` (run by the Sonnet subagent at `read` and `check`, with `--owner`) |
| `question` | The Conversation box, "Ask Claude Code" on a line, or a follow-up typed in a Question thread | the question, optional anchor with the line's text; for a follow-up also `follows` and the `thread` so far | `gr answer ID --text "…"` (an anchor or `--stop`s attach clickable focus/tour chips; the page offers the first one in a toast and does not move by itself) |
| `apply` | Review ▾ → Send | every pending comment and every thread with a pending reply; optional note; `commit`; `editable` | `gr reply` / edits + `gr resolve` per item (with `--changed` for the lines edited), then `gr done ID` |
| `decisions` | Answering the walkthrough's open questions | the answer comments | updated walkthrough, `gr resolve` per answer, then `gr done ID` |
| `visualize` | "Visualize this PR" in the Visualize Guide, or "Ask Claude Code to redraw them" when the code changed since | optional steer; `update` flag (the current diagrams are in `gr state --json`, `state.visual`) | `gr visualize --file F --request ID` |

Lifecycle: `pending` → `running` (claimed by a listener) → `done` | `failed` | `cancelled`.

**A claimed request has an owner**: the Claude Code session that claimed it (`gr` sends that session's id with every call; outside Claude Code there is none and the request is simply claimed). While its owner is alive, no other session is handed it. An owner is alive while one of its listeners is connected, and for a while after it was last heard from: two minutes for a session that uses `gr listen` (the gap is its listener being restarted), five for one that uses `gr wait` (it is disconnected while it works). After that the request is orphaned, and a session that is listening, or starts to, receives it with `"resumed": true, "yours": false`. The session it was taken from is told at its next call for that request (`gr progress`, `answer`, `done`, `annotate --request`, `visualize --request`, or a batch containing one), which fails with exit code 130 and `DISPLACED`. Two limits: a session that makes no `gr` call for longer than its grace period while another session is listening loses its request this way, so post `gr progress` during long work; and after the server restarts, every owner is given the grace period again from the restart, since what the server knew about who is alive is not kept on disk. A request claimed without an owner id is held for as long as a listener without one is connected, or its review heard from a session within the grace period.

**Threads are two-way.** A reply the reviewer types under any comment — Claude's note, their own comment, a resolved thread — is stored as *pending*, like a new comment, and is delivered with the next Review ▾ send. The session answers in the same thread with `gr reply`. `replyIds` on the request names the threads that were sent only because of a new reply; `gr` marks those replies as new.

**Questions have threads too.** A question asked from a line, a file or a section shows there as a Question thread, with the answer under it. The reviewer can ask a follow-up in that thread, and ask a failed or cancelled question again; unlike a reply under a comment, either goes to the session at once, as a new `question` request. That request carries `follows` (the id of the question it follows) and `thread`: everything said in the thread before it, oldest first, as `{"role": "user" | "agent", "text": "…"}`, so it can be answered in context. A question that got no answer (it failed, or was cancelled) is in `thread` on its own. `thread` is `null` when the review could not be read at the moment of delivery; `gr state` has the conversation. `gr wait` prints the same as an "earlier in this thread" block. The anchor is the thread's, and the request is completed like any question, with `gr answer ID`. A first question has neither field.

**Receiving requests**

- `gr listen` is the persistent listener, meant to be the command of a Claude Code Monitor. It covers every review of the repository, never exits by itself, reconnects if the server restarts, and prints one compact JSON line per event: `ready`, `request` (with a `do` field holding the completing command, `--session N` included), `cancelled`, `error`, and with `--on-change` `changed`. On start it also re-delivers the requests this same session already holds (`"resumed": true, "yours": true`), in case one was claimed and never reached it, and any that a session which is gone left behind (`"yours": false`); it never receives what another live session is working on. `"retried": true` marks a request the reviewer sent again. A Monitor lasts at most 30 minutes; start it again when it expires.
- `gr wait [--timeout S] [--on-change]` is the fallback without a Monitor tool: it blocks until requests exist, claims them, prints one `REQUEST <id> <kind>` block each, and exits. Run it in the background so its exit wakes the session, and again after handling them.

**During a request**

- **Progress.** `gr progress ID "text"` appends a line the page shows live under the request, next to an elapsed-time counter.
- **Cancellation.** The reviewer can cancel a pending or running request. `gr listen` prints a `cancelled` line at once; in any case the next `gr progress`, `gr answer`, `gr done`, `gr annotate --request` or `gr visualize --request` for it fails with exit code 130.
- **Stuck requests.** If a running request shows no progress for five minutes, or sooner when no session is reachable, the page offers "Send again". That clears the request's owner and puts it back in the queue; it is delivered with `"retried": true`, to the session that had it if that session is listening, otherwise to whichever listener asks first.
- **Failure.** `gr fail ID --text "why"` ends a request with a reason the page shows.
- **Comments without an outcome.** When an apply or decisions request ends in any way, a comment still `sent` goes one of two ways. If the request was an apply and Claude Code replied to the comment during it, the comment becomes `answered`: an open thread that is no longer waiting to be sent (the reviewer can reply again, or resolve it). One it never touched returns to pending, so nothing is lost. The same holds for a reply: a thread sent only for the reviewer's reply, and neither answered nor resolved, has that reply pending again (unless a later request that is still open already carries the thread). Reply before finishing: a `gr reply` made after `gr done` does not clear a reply that `done` has just given back.
- **Where the fix is.** `gr resolve --changed "path:start-end"` (repeat it for each place; `path:line` for one line) records the new-side lines the session edited for that comment. The page shows one chip per range under the resolution; a click shows those lines in the Code pane and flashes them, first folding in newer code when the code changed since the page loaded it (and leaving a single-commit view), and a folded resolved thread says how many places changed. The server checks each range the way it checks an anchor: the file must be part of the diff (a rename by either path) and the lines must exist on the compare side as it is now, uncommitted edits included when the compare side is a checked-out branch; the text of the first line is copied from git (a symlink is the one line git stores for it, the path it points at, never the file behind it). A range that is not there refuses the whole resolution, naming the range. At most 20 ranges. With `--sha` and no `--changed`, the ranges are the runs of lines that commit added (against its first parent) in files of the review, where every line of the run still reads on the compare side as the commit left it; a commit outside the comparison (not reachable from its compare side, or already part of its base) is recorded without lines; if it has more than 20, the first 20 are kept and `gr resolve` says how many were left out. An explicit `--changed` always wins, which is what to pass when one commit holds the fixes for several comments. A fix that only removes lines has no lines to name. The line numbers are stored as they were when the fix was recorded and are not re-anchored, so a later edit above them shifts what they point at (the page says so when the first line no longer reads as recorded).
- **Edits and permissions.** Edits are made by this Claude Code session with its normal tools, so Claude Code's own permission prompts and settings apply; the skill additionally has the session confirm in the terminal before the first edit a request asks for. A request on a fixed commit has `editable: false`: it can be answered but not edited.
- **Presence.** The page shows whether a session will act on what the reviewer asks: *working* while a live session holds a request, or for two minutes after one handled a request; *listening* while `gr listen` or `gr wait` is connected; otherwise *not attached*, including when a request is still claimed by a session that is gone. A session that only reads the review or posts comments with `gr` does not make a review look attended: that says nothing about whether a request would be picked up. (Any call from the session that holds a request does show that this session is still there.) Requests made while nothing is attached wait.
- **Notifications.** Completing a request or storing a walkthrough notifies the reviewer: a browser notification when the tab is in the background, or a macOS banner when no tab is open on that review.

**Batching writes.** `gr batch --file ops.json` (`-` = stdin) applies a JSON array of operations as one atomic update: either all are applied and the page refreshes once, or none is and the error names the failing operation. Each operation is an object with `op` and the same fields as the matching command's flags:

```json
[
  {"op": "comment", "file": "src/a.ts", "line": 12, "expect": "retry(", "text": "Unbounded retry."},
  {"op": "reply", "id": "c4", "text": "It is called from two places; both pass a budget."},
  {"op": "resolve", "id": "c7", "verdict": "addressed", "note": "Capped at 5.", "changed": ["src/a.ts:12-18"]},
  {"op": "answer", "request": "r3", "text": "Because …", "file": "src/a.ts", "line": 12},
  {"op": "done", "request": "r5"}
]
```

Operations: `comment` (takes `"finding": "bug"`), `reply`, `resolve`, `reopen`, `delete-comment`, `answer`, `note`, `progress`, `done`, `fail`, `annotate` (`walkthrough` object, `model`), `factcheck` (`factCheck` object, `model`), `effort-done` (`"level": "bugs"`, `model`), `visualize` (`visual` object), `focus`, `viewed`. A `resolve` operation takes `changed` as an array of `"path:start-end"` strings or `{"file", "start", "end"}` objects.

## Anchors

`<anchor>` is one of:

- `--file P --line N [--side new|old] [--expect TEXT]`: a line of a changed file. `N` is the new-file line number, or the old-file number with `--side old`. The line may be inside the diff's hunks or outside them (unchanged code around a change).
- `--file P`: a whole file.
- `--section ID` · `--summary` · `--title` · `--question ID` · `--step N` (plan step).
- `--artifact PATH --line N [--expect TEXT]`: a line of an attached spec/plan.

The **server** validates every anchor against git, whether it comes from `gr` or from the browser, and refuses one that is not there: a file that did not change, a line number past the end of the file, a line in a binary file, an unknown section, or a line whose text does not contain `--expect`. The stored anchor carries the line's exact text and two lines of context on each side, all copied from git, never text supplied by the caller. A line outside the hunks is marked as such; the UI shows it in place by opening the surrounding context.

On every load, comments on diff lines and spec/plan lines are re-anchored:

1. Find lines on the same side of the same file (following a rename) whose text equals the stored text exactly; failing that, lines equal after collapsing whitespace, so re-indenting a line does not orphan its comment. The diff's hunks are searched, and the rest of the file too when the comment is, or may now be, outside them.
2. Among several candidates prefer the one whose neighbouring lines match the stored context, then the one nearest the old position.
3. If no line matches, the comment is never moved to other code. A `queued` comment becomes `outdated`; a note, a sent comment or a resolved one is flagged as "line gone" and shown apart from the diff with its original text. A comment whose line reappears is re-attached.

## Spec and plan discovery

A markdown file is recognised as a spec or a plan by its path:

| Role | Paths |
|---|---|
| spec | `specs/<name>/spec.md`, `docs/superpowers/specs/*.md`, `docs/spec/*.md`, `docs/specs/*.md`, `docs/rfc/*.md`, `docs/rfcs/*.md`, `docs/design/*.md`, `docs/prd/*.md`, `spec.md`, `prd.md`, `design.md` |
| plan | `specs/<name>/plan.md`, `specs/<name>/tasks.md`, `docs/superpowers/plans/*.md`, `docs/plan/*.md`, `docs/plans/*.md`, `.claude/plans/*.md`, `plan.md`, `tasks.md` |

When a review is first loaded: every recognised file the diff touches is attached (up to 6). If the diff touches none, the single candidate of each role is attached, or, among several, the one whose first 50 lines mention the branch name. Nothing is guessed beyond that; attach anything else with `gr artifact add`. Contents are read from the working tree when the compare side has one, otherwise from the compare commit.

## State and identity

Everything is local and human-readable: `<home>/sessions/<id>.json` holds one review (its effort level and what was done at each level, walkthrough and its history, the fact check, the diagrams of the Visualize Guide, comments and replies, conversation, requests, viewed and reviewed marks, excluded untracked files, approval history, attached spec/plan paths); `<home>/index.json` holds opened repositories and preferences; `<home>/bridge.json` holds the server port and the current review per repository. Diffs and file contents are never stored; they are read from git on every load. Writes are atomic (temp file, then rename). A file that fails to parse is set aside as `*.corrupt-<time>`, never deleted.

The page also keeps a few things in the browser, in `localStorage`: where the reviewer left off and how they set the page up, and no review data beyond that. They never reach the server, another browser starts without them, and a browser that blocks storage is served without them.

| Key | Scope | Holds |
|---|---|---|
| `gr-left-<session id>` | one review | JSON: the Guide on show, the pick the Code pane follows, each Guide's own pick, whether all files are on show, whether the Guide or the code had the whole width or height, the folded folders of the tree |
| `gr-guide-w` | all reviews | JSON: each Guide's share of the workspace width, in percent |
| `gr-stack-h` | all reviews | The Guide's share of the height while the panes are stacked, in percent |
| `gr-tree-open`, `gr-tree-pin`, `gr-tree-w` | all reviews | The tree panel shown or hidden (`1` / `0`); `1` when it is pinned as a column beside a Guide; its width in px |
| `gr-diff-view`, `gr-files-view`, `gr-by-section`, `gr-hide-ws`, `gr-theme` | all reviews | `split` or `unified`; `tree` or `list`; `1` = the tree grouped by section; `1` = hide whitespace-only changes; the chosen theme |

`sessionStorage` holds `gr-token`, the token from the page's address, when the server was started with one.

- Default home: `~/Library/Application Support/guided-review` (macOS), `$XDG_CONFIG_HOME/guided-review` or `~/.config/guided-review` (Linux).
- **Identity** of a review is (repository, base identity, compare identity, direct or not). A branch side's identity is its name; a commit side's is its SHA. So `main..feature` is one review that follows `feature`, `main..<sha>` is a different, frozen one, and `--direct` is a third. `gr review` resumes the matching review unless `--new`.
- The repository is always the primary worktree's path, even when `gr` runs inside a linked worktree.
- **Reviewed state**: storing a walkthrough records the compare commit. **Approval** records the exact surface: the commit, plus the content of every uncommitted file that is part of the review. An approval covers only that surface; after any change `state` and `drift` say the earlier approval does not cover the current state. History is kept, so returning to an approved state shows as approved again. Excluded untracked files do not affect approval.
- **"Since" marks** use the latest approval as the baseline, or the last walkthrough when there is no approval. They are computed from a real `git diff` from that commit. Uncommitted changes always count as changed since the baseline, because the baseline is a commit.
- **Viewed** marks store the compare commit and the file's content hash, so a later commit or an uncommitted edit to that file both re-flag it.
- **Views**: hiding whitespace-only changes and showing a single commit of the range are alternative looks at the same review. They are computed on request (`git diff -w`; the commit against its first parent), change nothing that is stored, and leave comments anchored to the full comparison. A single-commit view is read-only.
- **Change detection**: while a tab or `gr wait` is connected to a review, the server fingerprints that review's code every 1.5 seconds (compare commit, `git status`, and the uncommitted diff) and notifies on change. Any number of reviews can be watched at once. Polling uses `GIT_OPTIONAL_LOCKS=0`, so it never blocks your own git commands.

## Environment

| Variable | Effect |
|---|---|
| `GUIDED_REVIEW_HOME` | State directory. Tests and the demo use a temporary one. |
| `GUIDED_REVIEW_PORT` | Preferred port (default 8791). |
| `GUIDED_REVIEW_NO_OPEN=1` | Never open a browser. |
| `GUIDED_REVIEW_OS_NOTIFY=0` | Disable the macOS notification fallback. |
| `GUIDED_REVIEW_OWNER` | The calling session's id, when not the one Claude Code provides (`CLAUDE_CODE_SESSION_ID`). Same as `--owner`. |
| `GUIDED_REVIEW_OWNER_GRACE_SECONDS` | Server-side: how long a session that is not connected still counts as alive after it was last heard from (default 300; a session that uses `gr listen` gets at most 120). |
| `GUIDED_REVIEW_IDLE_MINUTES` | Idle time before the server stops itself (default 30; `0` = never). |
| `GUIDED_REVIEW_HOST` / `GUIDED_REVIEW_TOKEN` | Server-side only. Binding a non-loopback host is refused unless a token is set; `gr` itself always uses `127.0.0.1`. |

## HTTP contract

The UI and `gr` use the same two endpoints. Both reject requests whose `Origin` does not match `Host`, and (without a token) any `Host` that is not a loopback name, which blocks cross-site requests and DNS rebinding.

- `POST /rpc/<channel>` with a JSON array of arguments → `{"value": …}` or HTTP 400 `{"error": "…"}`.
- `GET /events?session=<id>` (Server-Sent Events; `&ui=1` for a browser tab, `&bridge=1` for `gr wait`; `?bridge=1&repo=<path>` for `gr listen`, every review of a repository; a bridge adds `&owner=<session id>`, and `&listen=1` when it is a persistent listener) → frames `{"channel", "msg"}` on `session:changed`, `repo:changed`, `ui:action`, `presence`, `request:cancelled`, `notify`.

Every channel, argument and data shape is declared in `app/shared/types.ts` (`Api`, `PushMap`). The server is `app/server/` (`main.mjs` HTTP and handlers, `review.mjs` assembly, anchors and reconciliation, `git.mjs` git access, `store.mjs` persistence).

Routes the UI understands: `#/` (dashboard), `#/repo?path=<abs>`, `#/review?session=<id>`, `#/review?repo=<abs>&base=<ref>&compare=<ref>[&fresh=1][&direct=1]` (`fresh=1`: a new review even when a saved one matches). A review route optionally carries these parameters (the page writes them in this order; it reads them in any):

| Parameter | Values | Meaning |
|---|---|---|
| `guide` | `walkthrough`, `visual`, `conversation`, `spec`, `none` | The Guide on show in the Guide pane. `none`: the Guide pane closed, leaving the Code pane and the tree panel. |
| `pick` | URL-encoded JSON: `{"box":["<diagram id>","<box id>"]}`, `{"section":"<id>"[,"file":"<path>"]}`, `{"dir":"<path>"}` or `{"file":"<path>"[,"side":"old"][,"line":N][,"end":N]}` | The pick the Code pane is narrowed to. One that is not of these shapes is ignored. |
| `all` | `1` | Beside a Guide, all the files are on show, not only the pick's. Read only together with a `guide`. |
| `w` | `1` | Hide whitespace-only changes. |
| `commit` | `<sha>` | One commit of the range, read-only. |
| `focus` | URL-encoded JSON target: `{"kind":"diff","file":"<path>","side":"new"\|"old","line":N}`, or a `file`, `section` or `summary` anchor | A jump the session made (`gr focus`, a tour stop). The next step drops it. |

An address with none of `guide`, `pick` and `focus` reopens the review where this browser left it; a browser that never opened it shows the Walkthrough when there is one, else the Guide pane closed. The address names only the pick the code follows: each Guide's own pick is kept in `history.state` and in `gr-left-<session id>` (see [State and identity](#state-and-identity)). `tab=` is still accepted and the address is rewritten: `tab=conversation|spec|visual` becomes that `guide`, `tab=files` becomes `guide=none`, and `tab=commits` (or `guide=commits`) becomes `guide=none` with Details open in the top bar. A `.md` file in the Code pane, and a document in the Spec & plan Guide, shows rendered with a switch to its source lines.

Special ref inputs: `@empty` (empty tree, base only) and `@worktree` (compare only: the current branch, or the working tree itself when `HEAD` is detached).

## What costs Claude usage

Only this Claude Code session, and the subagent it starts. The server, UI, storage and every `gr` command are local tooling: they make no network calls and start no model. There is no API key and no other service; work the reviewer requests in the UI is done by the session that is attached, on its existing login.

The effort level sets where the review pass is spent. At `read` and `check` the session hands the pass to a subagent on Sonnet and does not read the diff or the result itself, so the pass costs Sonnet's price; at `bugs` the whole pass runs on the session's model. Questions, apply requests, decisions and diagrams are always the session's, so a `read` review is not Sonnet-priced end to end, and the first question in one is slower: the session reads the walkthrough then. On a session that is itself on a smaller model than Sonnet, `read` and `check` cost more than the session's own model would.
