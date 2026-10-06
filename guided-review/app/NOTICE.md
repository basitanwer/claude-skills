# Third-party notice

guided-review was designed with **Limn** — https://github.com/glebmish/limn, commit
`d896f377c51f7fbcfb5c3369564203f12d5942b7` (v0.3.0), MIT License, © 2026 Gleb
Mishchenko — as its reference. No Limn backend code is included: the server in
`server/` is an independent implementation.

Two things do derive from Limn and remain under its license (`LICENSE.limn`):

- `web/src/worddiff.ts` and `web/src/highlight.ts`, lifted unchanged apart from an
  import path.
- The rendered data model in `shared/types.ts` (the shapes of diff files, hunks and
  lines, comments and their anchors, walkthrough sections and the plan map, ref
  sides and viewed marks) follows Limn's `src/shared/types.ts`.

Ideas adopted from Limn's design, reimplemented here: git as the only source of
diffs, branch sides keyed by name and commit sides by SHA, walkthroughs reconciled
against the diff, exact-text comment re-anchoring, approval of an exact surface, and
`GIT_OPTIONAL_LOCKS`-safe polling.

Build-time dependencies of the web UI (React, Zustand, highlight.js, react-markdown,
remark-gfm, Vite, TypeScript) are installed from npm under their own open-source
licenses; see `package.json`. The server and the `gr` bridge have no dependencies.
