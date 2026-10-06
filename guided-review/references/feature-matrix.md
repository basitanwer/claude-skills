# Feature inventory and coverage

Reference implementation studied: **Limn** (github.com/glebmish/limn) at commit `d896f377c51f7fbcfb5c3369564203f12d5942b7` (v0.3.0, 2026-07-01, MIT). The inventory below was derived from its `README.md`, `docs/architecture.md`, `docs/agent-layer.md`, `docs/storage-layer.md`, `src/**` and `tests/**`.

What was built instead of reusing it: an independent, dependency-free server (`app/server`), a web UI written from scratch (`app/web`) and laid out like GitHub's pull-request page (Conversation, Commits, Spec & plan and Files changed tabs; file tree; split and unified diffs; a Review menu in place of "Submit review"), and the `gr` bridge (`scripts/gr.mjs`). No Limn backend code is included. Limn's agent engines are replaced by one rule: **the Claude Code session that opened the review does all agent work**, and the UI reaches it through requests.

Contents: [Verified column](#verified-column) · [Limn features and what became of them](#limn-features-and-what-became-of-them) · [Additions](#additions) · [Not carried over](#not-carried-over) · [Limitations](#limitations) · [Reproducing](#reproducing)

## Verified column

- **T:** an automated integration test in `app/tests/` (`loop` = `loop.test.mjs`, 15 tests; `sem` = `semantics.test.mjs`, 14 tests; `filelines.test.mjs`, 6 tests for expand-context, comments outside the hunks, hide whitespace, single-commit view and the list's approved state; `idle.test.mjs`, 1 test; plus tests for `gr listen`, `gr batch`, two-way thread replies and request retry). They drive the real server through `gr` against real git repositories, and play the browser's part by calling the same HTTP channels the UI calls. All 54 pass.
- **UI:** exercised in Chrome against the running server, with HTTP calls standing in for the Claude Code session.
- **UI + gr:** additionally re-checked in Chrome with the real `gr` as the session: a review with a walkthrough rendered, the indicator read *listening* while `gr wait` was blocked, a question created from the page woke `gr wait`, the indicator read *working*, a `gr progress` line was accepted, and `gr answer` with an anchor scrolled the tab to the cited line and cleared the request. No console errors.
- **UI (built):** implemented and compiles, but that control was not exercised.
- **Demo:** `scripts/demo.sh` ran end to end without a browser.

## Limn features and what became of them

| # | Limn capability | Limn source | Here | Verified |
|---|---|---|---|---|
| 1 | Repository dashboard, recent repositories | `ipc.ts` dashboard, `Dashboard.tsx` | Reimplemented: `main.mjs` `dashboard`/`openRepo`; UI `#/` | UI. Filter box, notices banner: UI (built) |
| 2 | Saved sessions per repo: list, resume, archive, restore, new | `db/sessions.ts`, `RepoHub.tsx` | Reimplemented: `store.mjs`; UI hub; `gr sessions`/`archive`/`review --resume --list` | T loop (resume, archive); UI |
| 3 | Branch and worktree overview | `repoState`, `git.ts` | Reimplemented, read-only | UI |
| 4 | Check out a branch into a worktree, add a worktree | `switchBranch`, `checkoutInto`, `addWorktreeFor` | **Dropped**: see "Not carried over" | — |
| 5 | Compare any refs: branches, commits, tags, SHAs, relative refs | `resolveRefInput`, `RefPicker.tsx` | Reimplemented: `review.mjs` `resolveInput`; UI ref picker (with tags); `gr review A..B` | T sem (ranges, tags, relative refs); UI |
| 6 | Preview that becomes a saved session on first write | `previewReview` | Reimplemented | T sem (empty diff creates no session); UI |
| 7 | Git as authority: unified diff parsing, renames, deletions, binaries, mode changes, merge-base, unrelated histories | `git.ts` | Reimplemented: `git.mjs` `parsePatch` (hunk lengths from the header; paths from the header halves) | T sem (rename, delete, binary, mode-only, no trailing newline, diverged ranges); UI |
| 8 | Syntax highlighting and word-level diff | `highlight.ts`, `worddiff.ts`, `DiffView.tsx` | The two utilities lifted; new diff component with split and unified views and expand-context (`fileLines`) | T filelines; UI |
| 9 | Uncommitted changes alongside commits; lines labelled committed / staged / unstaged; untracked files, excludable | `mergeDiff.ts`, `review.ts` | Reimplemented: `git.mjs` `tagOrigins` (joins on working-tree line numbers) | T sem (working tree, `--base`); UI |
| 10 | Guided walkthrough: title, summary, sections by purpose, narration, diagrams, per-file notes, open questions | `prompts.ts`, `schema.ts`, `SectionView.tsx` | Kept as a data model; **written by the session** (`gr annotate`) instead of an engine | T loop; UI; UI + gr |
| 11 | Walkthrough checked against git: unknown files dropped, every changed file covered | `validate.ts` | Reimplemented: `review.mjs` `reconcile` | T loop |
| 12 | Spec/plan discovery, document view, cross-check (acceptance, steps, deviations), per-document approval | `artifacts.ts`, `ArtifactDoc.tsx` | Reimplemented with more path conventions, plus explicit `gr artifact add` | T loop (discovery, spec-line comment, add/remove); UI |
| 13 | Comments on diff lines, files, sections, summary, title, questions, spec/plan lines, plan steps, acceptance rows, deviations | `CommentAnchor`, `Threads.tsx` | Reimplemented; anchors validated **on the server** for every caller | T loop; UI (diff line, file, section, summary, spec line) |
| 14 | Comments on a text selection in prose | `selection` anchors | **Dropped** | — |
| 15 | Comment lifecycle: queued → sent → resolved with verdict and note; replies; unhandled comments return to the queue | `sendBatch`, `tools.ts` | Reimplemented: `commentUpdate`, request completion | T loop; UI |
| 16 | Re-anchoring when code moves; stale comments marked | `anchor.ts` | Reimplemented and extended (context-aware, whitespace-tolerant, notes follow too) | T loop (moved line, vanished line, identical lines, re-indented line) |
| 17 | Generate a walkthrough from the UI | `generate`, Claude/Codex engines | **Replaced**: a `walkthrough` request to the attached session | T loop; UI; Demo |
| 18 | Contextual chat, "ask about this line" | `sendChat`, `ChatDrawer.tsx` | **Replaced**: a `question` request; one conversation per review | T loop; UI; UI + gr; Demo |
| 19 | Apply queued feedback, one resolution per comment | `sendBatch` | **Replaced**: an `apply` request; the session edits and reports | T loop; UI; Demo |
| 20 | Answer the walkthrough's open questions | refine batch | **Replaced**: a `decisions` request | T loop; UI |
| 21 | Agent drives the UI: focus, tour, comments, edit the walkthrough | `tools.ts`, `ActionChips.tsx` | Reimplemented as bridge commands: `gr focus` / `tour` / `say` / `comment` / `annotate`; answers carry focus and tour chips | T loop (focus, tour, say reach a tab; bad target refused); UI; UI + gr |
| 22 | Agent suggests marking files viewed | `suggest_mark_viewed` | **Dropped** | — |
| 23 | Live progress for a running operation | `EngineEvent` stream, `GenPanel.tsx` | **Replaced**: `gr progress` lines under the request | T loop; UI |
| 24 | Cancellation | `operations.ts` | **Replaced**: reviewer cancels a request; the session learns at its next `gr` call for it (exit 130) | T loop; UI (cancel before pickup) |
| 25 | Errors surfaced | failure paths in `ipc.ts` | Reimplemented: `gr fail`, server refusals shown as toasts, `gr` exit codes | T loop, sem (bad input); UI |
| 26 | Permission handling: execution modes, approval cards | `executionMode.ts`, `approvals.ts` | **Replaced**: Claude Code's own permission prompts; the UI has none | By construction; not separately tested |
| 27 | One operation per repository | `repoLocks` | Not needed: no engine runs. Writes are serialised per review | — |
| 28 | File-viewed tracking with "changed since viewed" | `viewed_files`, `ViewMark` | Reimplemented; the server takes the snapshot (`setViewed`) | T loop; UI |
| 29 | Section-reviewed tracking | `reviewed_sections` | Reimplemented | UI |
| 30 | Change detection and "since you reviewed" pill | `startWatch` | Reimplemented, one watcher **per open review** | T sem (two reviews at once); UI |
| 31 | Delta views: since approved / reviewed, since viewed | `diffSince`, `markSince` | Reimplemented | T loop (delta only); UI |
| 32 | Update the walkthrough after new commits | `generate(update)` | **Replaced**: `walkthrough` request with `update`; a stale flag drives the UI prompt | T loop; UI |
| 33 | Approval of an exact state, history, unapprove | `session_approvals` | Reimplemented | T loop (approve, new commit, uncommitted edit, return to approved state); UI |
| 34 | Session identity: branch by name, commit by SHA; resume by identity | `refIdentity` | Reimplemented, plus `direct` and working-tree sides | T loop (frozen vs moving, `--freeze`, `--direct`), sem |
| 35 | Local persistence of everything above | SQLite, `db/` | **Replaced**: JSON file per review, atomic writes, unreadable files set aside | T loop (survives a server restart). Corrupt-file path: not tested |
| 36 | Walkthrough iterations | `iterations` | Kept as a light history (title, summary, commit) | UI |
| 37 | Copy a walkthrough from another session | `copyReviewFrom` | **Dropped** | — |
| 38 | Missing ref on resume: warning and re-target | `refMissing`, `retargetSession` | Reimplemented | UI (built) |
| 39 | Claude engine on the local login | `engines/claude.ts` | **Replaced by the session itself**: no SDK, no second run | UI + gr |
| 40 | Codex engine; model and effort selection | `engines/codex*.ts`, `agents.ts` | **Dropped** with the engines | — |
| 41 | Headless local server, loopback bind, origin and rebinding guard, optional token | `server/` | Reimplemented | T (every test goes through it). Token mode: not tested |
| 42 | Completion notification | Electron `Notification` | Reimplemented: browser notification when the tab is hidden, macOS banner when no tab is open | UI (built); not observed firing |
| 43 | Deterministic fake engine | `engines/fake.ts` | Not needed: tests and the demo play the session directly | — |

## Additions

Requested for this skill and not in Limn.

| # | Addition | Where | Verified |
|---|---|---|---|
| A1 | Claude Code skill and the `gr` bridge | `SKILL.md`, `scripts/gr.mjs` | T (all); Demo |
| A2 | Request protocol between the UI and the session: `listen` (for a Monitor), `wait`, `answer`, `progress`, `done`, `fail`; attached / working / not-attached indicator | `main.mjs`, `gr.mjs`, UI | T loop (both arrival orders, presence states), listen tests; UI; UI + gr |
| A2a | Two-way threads: the reviewer's reply under any comment is pending until sent, delivered with the next send, answered by the session in the same thread | `main.mjs`, UI, `gr reply` | T; UI; checked end to end with a real Claude Code Monitor: reply in the page → event in the session → `gr batch` reply shown in the thread |
| A2b | `gr batch`: many writes as one atomic update | `main.mjs` `batch`, `gr.mjs` | T (happy path, atomic failure, cancelled request) |
| A2c | Stuck-request recovery: elapsed counter, "Send again" after five minutes without progress; unfinished requests re-delivered to the next listener | `requestRetry`, `requestTakeAll`, UI | T; UI |
| A3 | A single historical commit as a comparison | `gr.mjs` `resolveSpec` | T sem |
| A4 | Root commits (empty-tree base) | `review.mjs` | T sem; UI |
| A5 | Merge commits: first parent, stated | `gr.mjs` | T sem |
| A6 | Working-tree-only review, including a detached `HEAD` | `review.mjs` (`worktree` side) | T sem; UI |
| A7 | Direct two-endpoint comparison (`--direct`) | `review.mjs`, `gr.mjs` | T sem, loop |
| A8 | Apply leaves edits uncommitted unless the request or the user says to commit | request `commit` flag, `SKILL.md` | T loop (HEAD unchanged); UI |
| A9 | Server-side anchor validation with exact text copied from git, for any line of a changed file; `--expect` guard | `review.mjs` `makeAnchor` | T loop, sem, filelines |
| A10 | Approval cannot be given by the agent on its own | `gr approve` refuses without `--confirmed-by-user`; the UI's Approve is disabled while unseen changes are pending | T loop; UI |
| A11 | Comparison semantics reported on open | `gr review` notes | T sem |
| A12 | `gr drift`: commits and exact delta since the reviewed / approved state | `gr.mjs` | T loop |
| A13 | Any number of reviews watched at once; polling never takes git's index lock | `main.mjs` watcher, `git.mjs` | T sem (two reviews) |
| A14 | No dependencies at run time; Node 20; human-readable storage | `app/server`, `store.mjs` | T (all) |

## Not carried over

| Limn feature | Why |
|---|---|
| Agent engines (Claude Agent SDK, Codex app-server), model and effort picker, execution modes, approval cards, tool-call log | Decision: everything goes through the Claude Code session. |
| Multiple chat threads with their own agents | One conversation per review; there is one agent. |
| Check out into a worktree, add a worktree | They existed so an engine's edits landed on the right branch. The session edits wherever the branch is checked out; the server stays read-only on the repository. |
| Agent "suggest mark viewed", text-selection comments, copy a walkthrough between sessions | Not rebuilt. |
| Electron app, DMG, native dialogs, `limn` desktop CLI | The goal is a local webapp. Opening a repository is by path. |
| SQLite storage | Replaced by JSON files. No migration: there was no data to keep. |

## Limitations

- **A session must be attached for the UI's requests to be acted on.** The UI says when none is. Requests wait; nothing times out.
- **A Claude Code Monitor lasts at most 30 minutes**, so the listener must be started again when it expires; requests made in between are kept and delivered on restart. A pending reply cannot be edited or deleted before it is sent.
- **Cancelling running work is not instant.** It takes effect at the session's next `gr progress` / `answer` / `done` for that request.
- **The "working" indicator means "recently active"**: any `gr` call for the review within two minutes, or a request in hand.
- **Verification gaps**: the UI was rebuilt in GitHub's layout after the per-row "UI" checks above were first made; the rebuilt UI was re-exercised end to end (see cli.md for its structure), but these controls were only compiled, not clicked: the notification, re-targeting a missing ref, the conflict badge, the dashboard notices banner, `ui:action` navigate, request Cancel and the failed-request row, reply / edit / resolve / reopen / delete from a thread's menu, sending decisions, "Ask Claude Code" from a line composer, Update walkthrough, the file panel's list mode, artifact approve, and the keyboard shortcuts.
- **GitHub options added after the first pass** (server side tested in `filelines.test.mjs`): comments on any line of a changed file including unchanged context, hide whitespace, a single-commit view (read-only), approved state in the review list. Still not matched: commenting inside a single-commit view, and selecting a sub-range of commits.
- **Idle stop**: the server exits after 30 minutes with nothing connected (`idle.test.mjs`); an open tab or a blocked `gr wait` keeps it running. `gr` untested: `--repo`, `serve --port`, `open`, `review --force`, `tour --file`, token mode. The corrupt-file recovery path is untested. The whole loop was run by tests, by the demo, and by hand, but not yet by a real `/guided-review` invocation in a fresh Claude Code session.
- **Comparisons**: no combined merge diffs; no staged-only or unstaged-only view; remote-tracking refs are frozen, not followed; the working tree of a *linked* worktree with a detached `HEAD` cannot be reviewed (branches checked out in linked worktrees can).
- **"Since" in a dirty tree** is commit-granular: uncommitted changes always count as changed since the last review, and `NEW SINCE LAST REVIEW` prints for any dirty tree that has a baseline.
- **Anchoring** matches line text (exactly, then ignoring whitespace). A reworded line makes its comment stale; that is intended.
- **Focus in a background tab** runs when the tab becomes visible.
- **Platform**: developed and tested on macOS with Node 22.12. Linux should work (paths follow XDG) but was not tested; Windows is untested. SHA-256 repositories and submodule contents are not supported.
- **Untracked files** over 2 MB or containing NUL bytes are listed without content.

## Reproducing

```bash
cd ~/.claude/skills/guided-review/app
npm test            # 54 integration tests, about 130 s, needs only Node and git
npx tsc --noEmit    # contract + web UI type-check (needs the dev dependencies)
../scripts/demo.sh  # the whole loop on a throwaway repository, browser open
```
