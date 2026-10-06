# `gr` reference

Contents: [Install and launch](#install-and-launch) · [Comparison semantics](#comparison-semantics) · [Edge cases](#edge-cases) · [Commands](#commands) · [Requests from the reviewer](#requests-from-the-reviewer) · [Anchors](#anchors) · [Spec and plan discovery](#spec-and-plan-discovery) · [State and identity](#state-and-identity) · [Environment](#environment) · [HTTP contract](#http-contract) · [What costs Claude usage](#what-costs-claude-usage)

## Install and launch

```bash
~/.claude/skills/guided-review/scripts/gr doctor     # verify
~/.claude/skills/guided-review/scripts/install.sh    # only if the web UI is not built
~/.claude/skills/guided-review/scripts/demo.sh       # optional: the full loop on a throwaway repo
```

Requirements: Node 20 or newer and `git`. The server and `gr` have no dependencies. `npm` is needed only to rebuild the web UI (`install.sh --rebuild`).

From Claude Code: `/guided-review <args>` inside a repository. From a shell: `gr review <args>`. The server starts on demand and binds `127.0.0.1` only (default port 8791, next free port if taken). It stops with `gr stop`, or by itself after 30 minutes with no browser tab and no `gr wait` connected and no request; any `gr` command starts it again, and nothing is lost because every change is written to disk as it happens. Log: `<home>/server.log`.

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

Flags: `--freeze` pins any branch name to its current commit. `--new` starts a second review of the same pair instead of resuming. `--no-open` skips the browser. `--force` opens an empty diff anyway.

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

Common options: `--repo DIR` (default: cwd), `--session N` (default: the review last opened for this repo), `--json`.

**Reviews**

| Command | Purpose |
|---|---|
| `review <spec> [--base REF] [--freeze] [--direct] [--new] [--no-open]` | Open or resume a comparison; opens the browser. |
| `review --resume [SPEC] [--list]` | Reopen the latest saved review, a specific comparison, or list them. |
| `sessions [--include-archived]` · `archive [N]` · `unarchive N` | Manage saved reviews (archive is a soft delete). |
| `open` | Open the current review in the browser. |
| `diff [--file P] [--stat]` | The git diff with old/new line numbers and line labels. |
| `state` | Walkthrough, spec/plan check, viewed files, comments, conversation, requests, approval. `--json --full` dumps everything. |
| `drift` | New commits and the exact delta since the reviewed/approved state; files changed since they were marked viewed. |

**Walkthrough, comments, UI**

| Command | Purpose |
|---|---|
| `annotate --file F.json` (`-` = stdin) `[--request ID]` | Store the walkthrough (see walkthrough-schema.md). |
| `artifact add PATH --role spec\|plan` · `artifact remove PATH` · `artifact list` | Attach or detach spec/plan files the review is judged against. |
| `comment <anchor> --text T [--expect TEXT] [--as user] [--queued]` | Add a comment. From this session it is a `note`; `--queued` or `--as user` puts it in the reviewer's queue. |
| `comments [--status note\|queued\|sent\|resolved\|outdated]` | List comments. |
| `reply ID --text T` · `resolve ID --verdict addressed\|reworked\|skipped --note T [--sha C]` · `reopen ID` · `delete-comment ID` | Manage a comment thread and its resolution. |
| `focus <anchor>` | Scroll every open tab of this review to a spot and highlight it. Opens a tab if none is open. |
| `tour --stop "path:line[:old] \| note" …` or `--file stops.json` | A 2–8 stop walkthrough card in the UI. Stops may also be `section:ID`, a bare path, or `summary`. `--loop` to cycle. |
| `say "text"` | Show a transient status line in the UI. |
| `note "text" [<anchor>]` | Add a message to the review's conversation without a request, e.g. to record an answer given in the terminal. |
| `viewed --file P [--unset]` · `section-reviewed ID [--unset]` | Set review-tracking marks (normally the reviewer does this in the UI). |
| `approve --confirmed-by-user` · `unapprove` | Record or withdraw approval of the exact current state. Refused without the flag. |

**Requests** (see next section): `wait [--timeout S] [--on-change]`, `requests [--all]`, `answer REQ --text T [<anchor>] [--stop …]`, `progress REQ "text"`, `done REQ [--text T]`, `fail REQ --text reason`.

**Server**: `serve [--port N]`, `stop`, `status`, `doctor`, `rpc <channel> '[json args]'` (raw call).

Exit codes: `0` ok, `1` usage error or refused, `3` server unreachable, `130` the reviewer cancelled the request.

## Requests from the reviewer

The UI cannot do agent work itself. Its "Ask Claude Code" buttons create **requests**, stored in the review, that the attached session claims with `gr wait` and completes with one command. Walkthrough, question, and apply are distinct kinds with distinct completions.

| Kind | Created by | Carries | Completed by |
|---|---|---|---|
| `walkthrough` | Generate / Update walkthrough | optional steer; `update` flag | `gr annotate --file F --request ID` |
| `question` | The conversation box, optionally "about this line" | the question, optional anchor with the line's text | `gr answer ID --text "…"` (an anchor or `--stop`s attach clickable focus/tour chips) |
| `apply` | "Send N to Claude Code" on queued comments | comment ids (now `sent`), optional steer, `commit` flag | edits, `gr resolve` per comment, then `gr done ID` |
| `decisions` | Answering the walkthrough's open questions | the answer comments | updated walkthrough, `gr resolve` per answer, then `gr done ID` |

Lifecycle: `pending` → `running` (claimed by `gr wait`) → `done` | `failed` | `cancelled`.

- **Waiting.** `gr wait` blocks until at least one request is pending, claims all pending requests, prints them, and exits. Run it in the background so its exit wakes the session. `--timeout S` gives up after S seconds (prints `no requests`). `--on-change` also returns when the code under review changes.
- **Progress.** `gr progress ID "text"` appends a line the UI shows live under the request.
- **Cancellation.** The reviewer can cancel a pending or running request. A pending one is simply never delivered. For a running one, the next `gr progress`, `gr answer`, `gr done` or `gr annotate --request` for it fails with exit code 130; stop working on it. Cancellation is therefore as prompt as the session's next progress report, not instant.
- **Failure.** `gr fail ID --text "why"` ends a request with a reason the UI shows.
- **Unresolved comments.** When an apply or decisions request ends in any way, comments still `sent` return to `queued`, so nothing is lost.
- **Permissions.** Edits are made by this Claude Code session with its normal tools, so Claude Code's own permission prompts and settings apply. The UI has no permission controls.
- **Presence.** The UI shows whether a session is attached: *listening* while a `gr wait` is connected, *working* for two minutes after any `gr` call for that review or while a request is running, otherwise *not attached*. Requests made while nothing is attached wait until a session runs `gr wait`.
- **Notifications.** Completing a request or storing a walkthrough notifies the reviewer: a browser notification when the tab is in the background, or a macOS banner when no tab is open on that review.

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

Everything is local and human-readable: `<home>/sessions/<id>.json` holds one review (walkthrough and its history, comments and replies, conversation, requests, viewed and reviewed marks, excluded untracked files, approval history, attached spec/plan paths); `<home>/index.json` holds opened repositories and preferences; `<home>/bridge.json` holds the server port and the current review per repository. Diffs and file contents are never stored; they are read from git on every load. Writes are atomic (temp file, then rename). A file that fails to parse is set aside as `*.corrupt-<time>`, never deleted.

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
| `GUIDED_REVIEW_IDLE_MINUTES` | Idle time before the server stops itself (default 30; `0` = never). |
| `GUIDED_REVIEW_HOST` / `GUIDED_REVIEW_TOKEN` | Server-side only. Binding a non-loopback host is refused unless a token is set; `gr` itself always uses `127.0.0.1`. |

## HTTP contract

The UI and `gr` use the same two endpoints. Both reject requests whose `Origin` does not match `Host`, and (without a token) any `Host` that is not a loopback name, which blocks cross-site requests and DNS rebinding.

- `POST /rpc/<channel>` with a JSON array of arguments → `{"value": …}` or HTTP 400 `{"error": "…"}`.
- `GET /events?session=<id>` (Server-Sent Events; `&ui=1` for a browser tab, `&bridge=1` for `gr wait`) → frames `{"channel", "msg"}` on `session:changed`, `repo:changed`, `ui:action`, `presence`, `notify`.

Every channel, argument and data shape is declared in `app/shared/types.ts` (`Api`, `PushMap`). The server is `app/server/` (`main.mjs` HTTP and handlers, `review.mjs` assembly, anchors and reconciliation, `git.mjs` git access, `store.mjs` persistence).

Routes the UI understands: `#/` (dashboard), `#/repo?path=<abs>`, `#/review?session=<id>`, `#/review?repo=<abs>&base=<ref>&compare=<ref>[&direct=1]`, each review route optionally with `&tab=conversation|commits|spec|files` (default `files`), `&w=1` (hide whitespace), `&commit=<sha>` (one commit of the range, read-only) and `&focus=<url-encoded JSON target>`. Special ref inputs: `@empty` (empty tree, base only) and `@worktree` (compare only: the current branch, or the working tree itself when `HEAD` is detached).

## What costs Claude usage

Only this Claude Code session. The server, UI, storage and every `gr` command are local tooling: they make no network calls and start no model. There is no second agent run, no API key, and no other service; work the reviewer requests in the UI is done by the session that is attached, on its existing login.
