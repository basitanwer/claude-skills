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

export interface SessionMeta {
  id: number
  repo: string
  pair: RefPair
  /** true: diff the two endpoints directly; false: diff merge-base(base, compare) → compare */
  direct: boolean
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
export interface Iteration { n: number; at: string; endSha: string; title: string; summary: string }

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
export interface Comment {
  id: string
  anchor: CommentAnchor
  author: 'user' | 'agent'
  text: string
  /** `note`: an agent remark, never queued. `queued`: waiting for the reviewer to send.
   *  `sent`: handed to Claude Code in an apply request. `resolved`: outcome recorded.
   *  `outdated`: the line it was written on no longer exists. */
  status: 'note' | 'queued' | 'sent' | 'resolved' | 'outdated'
  /** for note/resolved comments on a line that no longer exists */
  lineGone?: boolean
  resolution?: { verdict: 'addressed' | 'reworked' | 'skipped'; note: string; commit?: string; at: string }
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
  /** focus / tour chips attached to an agent answer */
  actions?: UiAction[]
}

/** Work the reviewer asked the attached Claude Code session to do, from the UI. */
export type RequestKind = 'walkthrough' | 'question' | 'apply' | 'decisions'
export type RequestStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
export interface ReviewRequest {
  id: string
  kind: RequestKind
  status: RequestStatus
  /** question text, or the reviewer's steer for walkthrough / apply */
  text?: string
  anchor?: CommentAnchor
  /** apply / decisions: the comments handed over (new comments and threads with new replies) */
  commentIds?: string[]
  /** apply: the subset of `commentIds` sent only because the reviewer replied in the thread */
  replyIds?: string[]
  /** apply: whether there is a working tree Claude Code could edit (false for a fixed commit) */
  editable?: boolean
  /** when a session claimed it */
  startedAt?: string
  /** walkthrough: fold new changes into the existing one instead of starting over */
  update?: boolean
  /** apply: the reviewer asked for the edits to be committed */
  commit?: boolean
  progress: { at: string; text: string }[]
  error?: string
  createdAt: string
  finishedAt?: string
}
/** `listening`: `gr wait` is connected. `working`: the session was active recently or
 *  has a request in hand. `away`: nothing has been heard from a session. */
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
  iterations: Iteration[]
  comments: Comment[]
  messages: Message[]
  requests: ReviewRequest[]
  viewedAt: Record<string, ViewMark>
  reviewedSections: string[]
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
  resolution?: { verdict: 'addressed' | 'reworked' | 'skipped'; note: string; commit?: string }
  reply?: { author: 'user' | 'agent'; text: string }
}
export interface ServerInfo {
  app: 'guided-review'; version: string; pid: number; home: string; host: string; port: number
  /** browser tabs connected right now */
  tabs: number
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
  startSession(repo: string, base: string, compare: string, opts?: { fresh?: boolean; direct?: boolean }): Promise<{ sessionId: number; resumed: boolean }>
  findSession(repo: string, base: string, compare: string, opts?: { direct?: boolean }): Promise<{ sessionId: number } | null>
  /** Build a review without saving anything. */
  previewReview(repo: string, base: string, compare: string, opts?: { direct?: boolean; view?: ReviewView }): Promise<LoadedReview>
  loadSession(sessionId: number, view?: ReviewView): Promise<LoadedReview>
  archiveSession(sessionId: number, archived: boolean): Promise<void>
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
  commentAdd(sessionId: number, input: { anchor: AnchorInput; text: string; author: 'user' | 'agent'; status?: 'note' | 'queued' }): Promise<Comment>
  commentUpdate(sessionId: number, id: string, patch: CommentPatch): Promise<Comment>
  commentDelete(sessionId: number, id: string): Promise<void>
  approve(sessionId: number): Promise<ReviewState>
  unapprove(sessionId: number): Promise<ReviewState>
  approveArtifact(sessionId: number, path: string, approved: boolean): Promise<ReviewState>
  setArtifacts(sessionId: number, refs: { role: 'spec' | 'plan'; path: string }[]): Promise<ReviewState>
  getPrefs(): Promise<Record<string, string>>
  setPref(key: string, value: string): Promise<void>

  // requests: the reviewer asks the attached Claude Code session for something
  requestCreate(sessionId: number, input: { kind: RequestKind; text?: string; anchor?: AnchorInput; commentIds?: string[]; update?: boolean; commit?: boolean }): Promise<ReviewRequest>
  requestCancel(sessionId: number, requestId: string): Promise<ReviewRequest>
  /** Put a claimed request back in the queue (the session that took it seems to be gone). */
  requestRetry(sessionId: number, requestId: string): Promise<ReviewRequest>

  // bridge: used by the Claude Code session through scripts/gr
  /** Claim every pending request (they become `running`). */
  requestTake(sessionId: number): Promise<ReviewRequest[]>
  /** The same for every review of a repository. With `includeRunning`, requests an
   *  earlier session claimed and never finished are handed over again. */
  requestTakeAll(repo: string, includeRunning?: boolean): Promise<{ sessionId: number; request: ReviewRequest; comments: Comment[]; resumed: boolean }[]>
  /** Several bridge calls as one atomic update: all succeed and the page refreshes once,
   *  or none is applied and the error names the failing operation. */
  batch(sessionId: number, ops: BatchOp[]): Promise<{ results: unknown[] }>
  /** Add a progress line and/or finish. Rejects with "cancelled" if the reviewer cancelled it. */
  requestUpdate(sessionId: number, requestId: string, patch: { progress?: string; status?: 'done' | 'failed'; error?: string }): Promise<ReviewRequest>
  /** Post an agent message; with `requestId` it answers that question and completes it. */
  messagePost(sessionId: number, input: { text: string; requestId?: string; actions?: UiAction[] }): Promise<Message>
  /** Store a walkthrough; it is reconciled against the live diff. */
  annotate(sessionId: number, walkthrough: unknown, requestId?: string): Promise<{ sections: number; warnings: string[] }>
  /** Push a UI action to the tabs showing this review. Targets are validated against the diff. */
  uiAction(sessionId: number, action: UiAction): Promise<{ tabs: number }>
}

/** One step of `batch`: any of these bridge channels with its arguments after the session id. */
export interface BatchOp {
  channel: 'commentAdd' | 'commentUpdate' | 'commentDelete' | 'messagePost' | 'requestUpdate' | 'annotate' | 'uiAction' | 'setViewed' | 'setArtifacts'
  args: unknown[]
}

// ── push: GET /events?session=<id>[&ui=1|&bridge=1], or ?bridge=1&repo=<path> for
//    every review of a repository (Server-Sent Events) ──
export interface PushMap {
  /** review state changed (comment, walkthrough, request, message, approval…): reload */
  'session:changed': { sessionId: number }
  /** the code under review changed on disk or in git */
  'repo:changed': { sessionId: number; signature: string; headSha: string; dirty: boolean }
  'ui:action': { sessionId: number; action: UiAction }
  presence: { sessionId: number; presence: Presence }
  /** the reviewer cancelled a request a session had claimed */
  'request:cancelled': { sessionId: number; requestId: string }
  notify: { sessionId: number; title: string; body: string }
}
