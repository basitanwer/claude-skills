// The contract between the review server (plain JS, app/server) and the web UI
// (app/web). Types only — nothing here exists at runtime.
//
// The rendered data shapes (FileDiff / Hunk / DiffLine, Comment / CommentAnchor,
// Section / Walkthrough / PlanMap, RefSide / RefPair, ViewMark) follow the model of
// Limn (github.com/glebmish/limn, MIT © Gleb Mishchenko); see app/NOTICE.md.

// ── git ground truth ─────────────────────────────────────────
/** Where a changed line lives: in a commit of the range, in the index, or only in
 *  the working tree. Absent when the comparison has no uncommitted changes. */
export type LineOrigin = 'committed' | 'staged' | 'unstaged'

export interface DiffLine {
  old: number | null
  new: number | null
  kind: '' | 'add' | 'del'
  text: string
  origin?: LineOrigin
  /** changed since the reviewed / approved baseline */
  since?: boolean
  /** changed since this file was marked viewed */
  sinceViewed?: boolean
}
export interface Hunk { range: string; header: string; lines: DiffLine[] }

export interface FileDiff {
  path: string
  oldPath?: string
  status: 'modified' | 'added' | 'deleted' | 'renamed'
  binary: boolean
  add: number
  del: number
  hunks: Hunk[]
  /** git blob hash of the file as it is on disk (only when a working tree is in play) */
  fileHash?: string
  /** the file has changes that are not committed (staged, unstaged or untracked) */
  uncommitted?: boolean
  /** a working-tree file git does not track yet, shown as fully added */
  untracked?: boolean
  /** untracked and left out of the review (reviewer's choice, or not placed in the walkthrough) */
  excluded?: boolean
  modeChange?: { from: string; to: string }
  conflict?: boolean
  /** set when the reviewer marked the file viewed: still as viewed, or changed since */
  viewed?: 'viewed' | 'changed'
  /** real `git diff` hunks from the reviewed/approved baseline to now; absent = unchanged since */
  sinceHunks?: Hunk[]
  /** real `git diff` hunks from the commit at which the file was marked viewed */
  sinceViewedHunks?: Hunk[]
}
/** Snapshot taken when a file is marked viewed. */
export interface ViewMark { sha: string; hash: string }
export interface CommitInfo { sha: string; subject: string; author: string; date: string }
export interface DriftSummary { headSha: string; commits: number; files: number; add: number; del: number; dirty: boolean }

// ── comparison identity ──────────────────────────────────────
/** One side of a comparison.
 *  - `branch`: follows the branch tip (and its working tree, when checked out)
 *  - `commit`: frozen at `anchorSha`
 *  - `empty`: the empty tree (base of a root commit)
 *  - `worktree`: the working tree at `path` with a detached HEAD */
export type RefKind = 'branch' | 'commit' | 'empty' | 'worktree'
export interface RefSide { kind: RefKind; symbol: string; anchorSha: string; path?: string }
export interface RefPair { base: RefSide; compare: RefSide }

/** How much work the Claude Code session puts into a review. Each level does everything
 *  the one below does, and more: `read` posts the walkthrough; `check` adds a fact check of
 *  what the walkthrough, the change and the repository's docs say; `bugs` adds a hunt for
 *  defects. `read` and `check` run on Sonnet (a subagent), `bugs` on the session's model. */
export type EffortLevel = 'read' | 'check' | 'bugs'
/** A state of the code under review: the compare commit, and the fingerprint of the whole
 *  surface then (the commit itself, or with uncommitted changes the commit and a hash). */
export interface StateMark { sha: string; signature: string }
/** One level's part of the review, as it was last done: at which state, when, and on which
 *  model, as the session that did it named it (empty when it did not say). */
export interface EffortMark extends StateMark { at: string; model: string }

export interface SessionMeta {
  id: number
  repo: string
  pair: RefPair
  /** true: diff the two endpoints directly; false: diff merge-base(base, compare) → compare */
  direct: boolean
  /** the level later review passes run at. Absent on a review made before levels existed,
   *  which is handled as `check` once it is resumed */
  effort?: EffortLevel
  createdAt: string
  updatedAt: string
  archived: boolean
}
export interface SessionListItem extends SessionMeta {
  title?: string
  hasWalkthrough: boolean
  unresolved: number
  pendingRequests: number
  /** `yes`: the current state is approved. `stale`: approved before, changed since. */
  approved: 'yes' | 'stale' | 'no'
}

// ── walkthrough ──────────────────────────────────────────────
export type DiagramNode = { label: string; kind: '' | 'hi' | 'new'; sub: string }
export interface Section {
  id: string; name: string; desc: string; what: string; files: string[]; order: number
  diagram?: DiagramNode[]
  insight?: { caption: string }
  plainNotes?: Record<string, string>
}
export interface PlanMap {
  acceptance: { text: string; met: boolean | 'partial' }[]
  steps: { n: number; text: string; sectionId: string; status: 'done' | 'changed' | 'missing' }[]
  deviations: { text: string; sectionId: string }[]
}
export interface WalkthroughQuestion { id: string; text: string; context?: string; options?: string[] }
export interface Walkthrough {
  title: string
  summary: string
  sections: Section[]
  questions: WalkthroughQuestion[]
  planMap?: PlanMap
}
export interface Iteration {
  n: number; at: string; endSha: string; title: string; summary: string
  /** the model that wrote it, as the session named it */
  model?: string
}

// ── fact check: statements that do not hold against the code ──
/** Where a statement stands: a line of a file git has on the compare side (a changed file,
 *  an attached spec or plan, or any other doc of the repository), a commit's message, or
 *  somewhere only `label` can say. Path, line and line text are checked against git. */
export interface FactWhere {
  label: string
  file?: string
  line?: number
  /** the text of that line, copied from git */
  lineContent?: string
  /** the file is part of the diff, so the page can go to the line */
  inDiff?: boolean
  /** the file is an attached spec or plan */
  artifact?: boolean
  /** a commit of the comparison: the statement is in its message */
  commit?: string
}
/** One statement that does not hold. `changed`: this change made it false, so the code
 *  before the change agreed with it. `already`: it was false before the change too. */
export interface FactRow {
  id: string
  statement: string
  /** what the code does instead */
  why: string
  group: 'changed' | 'already'
  where: FactWhere
  /** the line of code that contradicts it, copied from git. `inDiff`: a line of a changed
   *  file, which the page can go to */
  contradicts?: { file: string; line: number; side: 'new' | 'old'; lineContent: string; inDiff: boolean }
  /** the note beside that line, which the server writes for a `changed` row */
  commentId?: string
  /** the state of the code it was found at */
  foundAt: StateMark
}
/** The fact check of a review: the complete record of what was found not to hold. Kept
 *  apart from the walkthrough, so a later walkthrough written at a lower level leaves it. */
export interface FactCheck {
  rows: FactRow[]
  /** how many statements were checked, when the session said */
  checked?: number
  /** when it was last run, at which state, on which model */
  at: string
  endSha: string
  signature: string
  model: string
}

// ── visual: the whole change drawn as diagrams ───────────────
/** What a diagram shows: the parts involved and how they depend on each other, how data
 *  moves through the change, or which function calls which. */
export type VisualKind = 'architecture' | 'flow' | 'calls'
/** How a node's code stands in this comparison. Worked out by the server from git, never
 *  taken from the session: `new` (the file is added), `changed` (the file, or the named
 *  lines of it, changed: a line added in them, or removed in or right next to them), `deleted`, `unchanged` (it exists and this change does not touch
 *  it), `none` (the node names no code: a browser, a database, a person). */
export type VisualStatus = 'new' | 'changed' | 'deleted' | 'unchanged' | 'none'
export interface VisualNode {
  id: string
  label: string
  sub?: string
  /** what it does and what this change does to it, in a few plain sentences: shown when the reviewer points at the box */
  note?: string
  /** a path of the repository, checked against the compare side */
  file?: string
  /** with `file`: the first line of the code the node stands for, and its last (new side) */
  line?: number
  end?: number
  /** the part of the system it belongs to; nodes of one group share a colour */
  group?: string
  status: VisualStatus
  /** the file is part of the diff, so the page can go to it */
  inDiff?: boolean
}
export interface VisualEdge {
  from: string
  to: string
  label?: string
  /** the session's reading of the change: this change adds or removes the connection */
  kind: '' | 'new' | 'removed'
}
export interface VisualView { id: string; kind: VisualKind; title: string; caption: string; nodes: VisualNode[]; edges: VisualEdge[] }
export interface Visual {
  title: string
  summary: string
  views: VisualView[]
  at: string
  /** when it was drawn: the compare commit, and what identifies the comparison then
   *  (the commit the diff started from, and the surface's fingerprint) */
  endSha: string
  signature: string
}

// ── comments ─────────────────────────────────────────────────
export type CommentAnchor =
  | { kind: 'diff'; file: string; side: 'new' | 'old'; line: number; hunkRange: string; lineContent: string
      /** up to two lines either side, used to tell identical lines apart when re-anchoring */
      before?: string[]; after?: string[]
      /** the line belongs to a changed file but lies outside the diff's hunks (unchanged context) */
      outside?: boolean }
  | { kind: 'artifact'; path: string; line: number; lineContent: string }
  | { kind: 'file'; file: string }
  | { kind: 'section'; sectionId: string }
  | { kind: 'summary' }
  | { kind: 'title' }
  | { kind: 'question'; questionId: string }
  | { kind: 'plan-step'; stepN: number }
  | { kind: 'acceptance'; index: number }
  | { kind: 'deviation'; index: number }
/** What a comment request may name; the server fills in the rest from git. */
export type AnchorInput =
  | { kind: 'diff'; file: string; side?: 'new' | 'old'; line: number; expect?: string }
  | { kind: 'artifact'; path: string; line: number; expect?: string }
  | Exclude<CommentAnchor, { kind: 'diff' } | { kind: 'artifact' }>

export interface CommentReply {
  author: 'user' | 'agent'; text: string; at: string
  /** a reviewer's reply that has not been sent to Claude Code yet */
  pending?: boolean
}
/** Lines of the compare side that were changed for a comment, numbered as they were when
 *  its outcome was recorded (a later edit can shift them; they are not re-anchored).
 *  `lineContent` is the text of line `start`, copied from git. */
export interface ChangedRange { file: string; start: number; end: number; lineContent: string }
export interface Comment {
  id: string
  anchor: CommentAnchor
  author: 'user' | 'agent'
  text: string
  /** `note`: an agent remark, never queued. `queued`: waiting for the reviewer to send.
   *  `sent`: handed to Claude Code in an apply request. `answered`: Claude Code replied in
   *  the thread without recording an outcome; open, and not waiting to be sent.
   *  `resolved`: outcome recorded.
   *  `outdated`: the line it was written on no longer exists. */
  status: 'note' | 'queued' | 'sent' | 'answered' | 'resolved' | 'outdated'
  /** a finding of a review pass: `fact` (the note of a fact check row, written by the
   *  server) or `bug` (a defect the bug hunt confirmed) */
  finding?: 'fact' | 'bug'
  /** the state of the code when it was written; a finding from an earlier state says so */
  foundAt?: StateMark
  /** for note/resolved comments on a line that no longer exists */
  lineGone?: boolean
  resolution?: {
    verdict: 'addressed' | 'reworked' | 'skipped'; note: string; commit?: string
    /** where the fix is: the ranges the session named, or else the ones `commit` added */
    changed?: ChangedRange[]
    /** how many more ranges `commit` has than the cap let `changed` keep */
    changedMore?: number
    at: string
  }
  replies: CommentReply[]
  createdAt: string
  /** walkthrough iteration current when the comment was written */
  iteration: number
}

// ── UI actions, conversation, requests ───────────────────────
export type FocusTarget = Extract<CommentAnchor, { kind: 'summary' } | { kind: 'section' } | { kind: 'file' }>
  | { kind: 'diff'; file: string; side: 'new' | 'old'; line: number }
export interface TourStop { target: FocusTarget; note?: string }
/** Something Claude Code makes the open tab do. */
export type UiAction =
  | { kind: 'focus'; target: FocusTarget }
  | { kind: 'tour'; stops: TourStop[]; loop?: boolean }
  | { kind: 'status'; text: string }
  | { kind: 'navigate'; hash: string }

export interface Message {
  id: string
  role: 'user' | 'agent'
  text: string
  at: string
  anchor?: CommentAnchor
  /** the request this message opened (user) or answered (agent) */
  requestId?: string
  /** a follow-up question: the request id of the first question of its thread (see `ReviewRequest.threadId`) */
  threadId?: string
  /** focus / tour chips attached to an agent answer */
  actions?: UiAction[]
}

/** Work the reviewer asked the attached Claude Code session to do, from the UI. */
export type RequestKind = 'walkthrough' | 'question' | 'apply' | 'decisions' | 'visualize'
export type RequestStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
export interface ReviewRequest {
  id: string
  kind: RequestKind
  status: RequestStatus
  /** question text, or the reviewer's steer for walkthrough / apply / visualize */
  text?: string
  anchor?: CommentAnchor
  /** question: the question this one follows up on, asked from that question's thread */
  follows?: string
  /** question: the thread a follow-up belongs to, as the id of the thread's first question
   *  (a follow-up to a follow-up stays in it). Absent on a first question, which is its own thread. */
  threadId?: string
  /** apply / decisions: the comments handed over (new comments and threads with new replies) */
  commentIds?: string[]
  /** apply: the subset of `commentIds` sent only because the reviewer replied in the thread */
  replyIds?: string[]
  /** apply: whether there is a working tree Claude Code could edit (false for a fixed commit) */
  editable?: boolean
  /** when a session claimed it */
  startedAt?: string
  /** which Claude Code session claimed it (its session id); cleared when it is sent again */
  owner?: string
  /** how many times the reviewer pressed "Send again" */
  retried?: number
  /** after "Send again": the session that held it, which gets it back if it is listening */
  wasWith?: string
  /** walkthrough: fold new changes into the existing one instead of starting over.
   *  visualize: redraw the existing diagrams for what changed since */
  update?: boolean
  /** apply: the reviewer asked for the edits to be committed */
  commit?: boolean
  progress: { at: string; text: string }[]
  error?: string
  createdAt: string
  finishedAt?: string
}
/** Whether a Claude Code session will act on what the reviewer asks. `listening`: a
 *  listener is connected. `working`: a session holds a request, or handled one moments
 *  ago. `away`: nobody is reachable; requests wait. */
export type Presence = 'listening' | 'working' | 'away'

// ── review state ─────────────────────────────────────────────
export interface Artifact { role: 'spec' | 'plan'; path: string; title: string; lines: string[] }
export interface Approval { sha: string; hash: string; at: string; signature?: string }
/** An alternative look at the same review. Neither option changes what is stored;
 *  `commit` is read-only (comments belong to the whole comparison). */
export interface ReviewView {
  /** ignore whitespace-only changes (`git diff -w`) */
  ignoreWhitespace?: boolean
  /** show only this commit of the range (its diff against its first parent) */
  commit?: string
}
export interface ReviewState {
  walkthrough?: Walkthrough
  /** the diagrams of the whole change, kept apart from the walkthrough (a new walkthrough leaves them) */
  visual?: Visual
  /** what the fact check found, kept apart from the walkthrough in the same way */
  factCheck?: FactCheck
  /** per effort level, the state its part of the review was last done at: `read` the
   *  walkthrough, `check` the fact check, `bugs` the bug hunt */
  effortDone: Partial<Record<EffortLevel, EffortMark>>
  iterations: Iteration[]
  comments: Comment[]
  messages: Message[]
  requests: ReviewRequest[]
  viewedAt: Record<string, ViewMark>
  reviewedSections: string[]
  /** Question threads the reviewer closed, each by the request id of its first question.
   *  A resolved thread folds away where it sits; asking a follow-up in it opens it again. */
  resolvedAsks: string[]
  /** reviewer's include/exclude override for untracked files */
  fileExcluded: Record<string, boolean>
  /** compare commit when the walkthrough was last written */
  reviewedAtSha?: string
  /** fingerprint of the whole surface at that moment */
  reviewedSignature?: string
  approvals: Approval[]
  artifactApprovals: Record<string, string>
  artifacts: { role: 'spec' | 'plan'; path: string }[]
  /** discovery has run (so an emptied list stays empty) */
  artifactsChecked?: boolean
}

export interface LoadedReview {
  /** 0 for a preview that has not been saved yet */
  sessionId: number
  session: SessionMeta
  baseContext: string
  compareContext: string
  /** the commit the diff starts from (merge-base, the base itself when `direct`, or the empty tree) */
  diffBase: string
  /** the compare side's commit right now */
  headSha: string
  /** everything the reviewer sees: commits in range plus, when a working tree is in
   *  play, its uncommitted changes (lines carry `origin`) */
  files: FileDiff[]
  commits: CommitInfo[]
  /** the compare side has a working tree with uncommitted changes */
  dirty: boolean
  /** identifies this exact surface; changes whenever the code under review changes */
  signature: string
  state: ReviewState
  artifacts: Artifact[]
  /** this exact surface is approved */
  approved: boolean
  /** what an approval of this surface is recorded under (compare with `Approval.hash`) */
  approvalHash: string
  /** the code changed since the walkthrough was written (new commits or uncommitted edits) */
  walkthroughStale: boolean
  /** the same for the diagrams: the code changed since they were drawn */
  visualStale: boolean
  /** baseline of the `since` marks: the latest approval, else the last walkthrough */
  since?: { kind: 'approved' | 'reviewed'; sha: string; moved: boolean }
  /** where Claude Code can make edits for an apply request */
  apply: { enabled: boolean; reason: 'available' | 'frozen-commit' | 'not-checked-out'; workdir: string | null }
  presence: Presence
  /** set when this load used view options */
  view?: ReviewView
  refMissing?: { side: 'base' | 'compare'; symbol: string }
}

// ── repositories ─────────────────────────────────────────────
export interface WorktreeInfo { path: string; branch: string | null; head: string; primary: boolean; dirty: boolean }
export interface RepoState {
  path: string
  branches: string[]
  /** branch checked out in the primary worktree, or 'HEAD' when detached */
  current: string
  defaultBase: string
  dirty: boolean
  dirtyCount: number
  worktrees: WorktreeInfo[]
}
export interface RepoIndexEntry { path: string; current: string; defaultBase: string; sessionCount: number; lastActivity: string }
export interface DashboardData { repos: RepoIndexEntry[]; recentSessions: SessionListItem[]; notices: string[] }
export interface RefOptions { branches: string[]; tags: string[]; defaultBase: string; commits: CommitInfo[] }

export interface UiStatePatch {
  viewedAt?: Record<string, ViewMark>
  reviewedSections?: string[]
  fileExcluded?: Record<string, boolean>
}
export interface CommentPatch {
  text?: string
  status?: Comment['status']
  /** `changed`: the server checks each range against git, like an anchor, and refuses one that is not there */
  resolution?: { verdict: 'addressed' | 'reworked' | 'skipped'; note: string; commit?: string; changed?: { file: string; start: number; end?: number }[] }
  reply?: { author: 'user' | 'agent'; text: string }
}
export interface ServerInfo {
  app: 'guided-review'; version: string; pid: number; home: string; host: string; port: number
  /** browser tabs connected right now */
  tabs: number
  /** Claude Code listeners (`gr listen` / `gr wait`) connected right now */
  bridges: number
}

// ── RPC: POST /rpc/<channel> with a JSON array of arguments ──
export interface Api {
  info(): Promise<ServerInfo>
  dashboard(): Promise<DashboardData>
  openRepo(path: string): Promise<RepoState>
  repoState(repo: string): Promise<RepoState>
  refOptions(repo: string, relativeTo?: string): Promise<RefOptions>
  listSessions(repo: string, includeArchived?: boolean): Promise<SessionListItem[]>
  /** Resolve both refs; resume the review with that identity, or create it (`fresh` forces a new one). */
  startSession(repo: string, base: string, compare: string, opts?: { fresh?: boolean; direct?: boolean; effort?: EffortLevel }): Promise<{ sessionId: number; resumed: boolean }>
  findSession(repo: string, base: string, compare: string, opts?: { direct?: boolean }): Promise<{ sessionId: number } | null>
  /** Build a review without saving anything. */
  previewReview(repo: string, base: string, compare: string, opts?: { direct?: boolean; view?: ReviewView }): Promise<LoadedReview>
  loadSession(sessionId: number, view?: ReviewView): Promise<LoadedReview>
  archiveSession(sessionId: number, archived: boolean): Promise<void>
  /** Raise or lower the effort level. Later review passes run at it; nothing posted is removed. */
  setEffort(sessionId: number, level: EffortLevel): Promise<{ effort: EffortLevel; was: EffortLevel | null }>
  /** Point the compare side at another ref (when the old one is gone). */
  retargetSession(sessionId: number, compare: string): Promise<void>
  driftSince(sessionId: number, sinceSha: string): Promise<DriftSummary>
  /** Lines `start`..`end` (1-based, inclusive) of a changed file, for expanding the
   *  context around a hunk. `new` = as the compare side has it; `old` = at the diff base. */
  fileLines(sessionId: number, path: string, side: 'new' | 'old', start: number, end: number): Promise<{ start: number; lines: string[]; total: number }>

  saveUiState(sessionId: number, patch: UiStatePatch): Promise<ReviewState>
  /** Mark a file viewed (or not); the server snapshots the commit and content hash. */
  setViewed(sessionId: number, path: string, viewed: boolean): Promise<ReviewState>
  /** The server validates the anchor against the live diff and copies the line text from git. */
  commentAdd(sessionId: number, input: { anchor: AnchorInput; text: string; author: 'user' | 'agent'; status?: 'note' | 'queued'; finding?: 'bug' }): Promise<Comment>
  commentUpdate(sessionId: number, id: string, patch: CommentPatch): Promise<Comment>
  commentDelete(sessionId: number, id: string): Promise<void>
  approve(sessionId: number): Promise<ReviewState>
  unapprove(sessionId: number): Promise<ReviewState>
  approveArtifact(sessionId: number, path: string, approved: boolean): Promise<ReviewState>
  setArtifacts(sessionId: number, refs: { role: 'spec' | 'plan'; path: string }[]): Promise<ReviewState>
  /** Close a Question thread (or open it again). `root`: the request id of its first question. */
  askResolve(sessionId: number, root: string, resolved: boolean): Promise<ReviewState>
  getPrefs(): Promise<Record<string, string>>
  setPref(key: string, value: string): Promise<void>

  // requests: the reviewer asks the attached Claude Code session for something
  /** A question with `follows` (a question request of this review) is a follow-up: it
   *  joins that question's thread and, with no anchor of its own, takes the thread's. */
  requestCreate(sessionId: number, input: { kind: RequestKind; text?: string; anchor?: AnchorInput; commentIds?: string[]; update?: boolean; commit?: boolean; follows?: string }): Promise<ReviewRequest>
  requestCancel(sessionId: number, requestId: string): Promise<ReviewRequest>
  /** Put a claimed request back in the queue (the session that took it seems to be gone). */
  requestRetry(sessionId: number, requestId: string): Promise<ReviewRequest>

  // bridge: used by the Claude Code session through scripts/gr
  /** Claim every pending request (they become `running`). */
  requestTake(sessionId: number): Promise<ReviewRequest[]>
  /** The same for every review of a repository, for the Claude Code session `owner`.
   *  Requests a session that is gone left claimed are handed over (`resumed`); with
   *  `includeRunning`, so are the ones this same session already holds (`yours`).
   *  What another live session holds is never returned. */
  requestTakeAll(repo: string, includeRunning?: boolean, owner?: string): Promise<{ sessionId: number; request: ReviewRequest; comments: Comment[]; resumed: boolean; yours: boolean; effort: EffortLevel }[]>
  /** Several bridge calls as one atomic update: all succeed and the page refreshes once,
   *  or none is applied and the error names the failing operation. */
  batch(sessionId: number, ops: BatchOp[]): Promise<{ results: unknown[] }>
  /** Add a progress line and/or finish. Rejects with "cancelled" if the reviewer cancelled it. */
  requestUpdate(sessionId: number, requestId: string, patch: { progress?: string; status?: 'done' | 'failed'; error?: string }): Promise<ReviewRequest>
  /** Post an agent message; with `requestId` it answers that question and completes it. */
  messagePost(sessionId: number, input: { text: string; requestId?: string; actions?: UiAction[] }): Promise<Message>
  /** Store a walkthrough; it is reconciled against the live diff. A `factCheck` in it is
   *  stored as `factCheck` below is. `model`: the model that wrote it. */
  annotate(sessionId: number, walkthrough: unknown, requestId?: string | null, opts?: { model?: string }): Promise<{ sections: number; warnings: string[]
    /** texts that run long, for whoever wrote it to shorten; nothing was cut */
    advice: string[]; factCheck?: { rows: number; notes: number } }>
  /** Store the fact check on its own: its rows are checked against git, and every row this
   *  change made false gets a note beside the line that contradicts it. */
  factCheck(sessionId: number, factCheck: unknown, opts?: { model?: string }): Promise<{ rows: number; notes: number; warnings: string[] }>
  /** Record that a level's part of the review was done at the current state. Only `bugs`:
   *  `read` is recorded by storing a walkthrough, `check` by storing a fact check. */
  effortDone(sessionId: number, level: EffortLevel, opts?: { model?: string }): Promise<EffortMark>
  /** Store the diagrams of the whole change; files and lines are checked against git and
   *  each node's status is worked out from the diff. */
  visualize(sessionId: number, visual: unknown, requestId?: string): Promise<{ views: number; nodes: number; warnings: string[] }>
  /** Push a UI action to the tabs showing this review. Targets are validated against the diff. */
  uiAction(sessionId: number, action: UiAction): Promise<{ tabs: number }>
}

/** One step of `batch`: any of these bridge channels with its arguments after the session id. */
export interface BatchOp {
  channel: 'commentAdd' | 'commentUpdate' | 'commentDelete' | 'messagePost' | 'requestUpdate' | 'annotate' | 'factCheck' | 'effortDone' | 'visualize' | 'uiAction' | 'setViewed' | 'setArtifacts'
  args: unknown[]
}

// ── push: GET /events?session=<id>[&ui=1|&bridge=1], or ?bridge=1&repo=<path> for
//    every review of a repository (Server-Sent Events) ──
export interface PushMap {
  /** review state changed (comment, walkthrough, request, message, approval…): reload */
  'session:changed': { sessionId: number }
  /** the code under review changed on disk or in git */
  'repo:changed': { sessionId: number; signature: string; headSha: string; dirty: boolean }
  /** `answerTo`: the action came with the answer to that request, so the page offers it
   *  instead of playing it (a direct `gr focus` / `gr tour` plays at once) */
  'ui:action': { sessionId: number; action: UiAction; answerTo?: string }
  presence: { sessionId: number; presence: Presence }
  /** the reviewer cancelled a request a session had claimed */
  'request:cancelled': { sessionId: number; requestId: string }
  notify: { sessionId: number; title: string; body: string }
}
