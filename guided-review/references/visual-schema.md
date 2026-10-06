# Visual JSON (`gr visualize`)

`gr visualize --file visual.json` stores diagrams of the whole change (`--request <id>` when it answers a `visualize` request from the UI). The reviewer reads them in the page's **Visualize** tab. You describe boxes and connections as data; the page lays them out and draws them. You never write markup, coordinates or colours.

```json
{
  "title": "One line: what the drawings show",
  "summary": "1–3 sentences to read first. Markdown allowed.",
  "views": [
    {
      "kind": "architecture",
      "title": "Architecture",
      "caption": "What this diagram shows, in one sentence. Markdown allowed.",
      "nodes": [
        { "id": "ui", "label": "Review page", "file": "app/web/src/", "group": "Page" },
        { "id": "server", "label": "Review server", "file": "app/server/", "group": "Server" },
        { "id": "git", "label": "git", "sub": "the authority" }
      ],
      "edges": [
        { "from": "ui", "to": "server", "label": "RPC" },
        { "from": "server", "to": "git", "label": "reads the diff" }
      ]
    },
    {
      "kind": "calls",
      "title": "Function calls",
      "nodes": [
        { "id": "retry", "label": "withRetry()", "at": "src/retry.ts:12-48" },
        { "id": "budget", "label": "RetryBudget.take()", "at": "src/budget.ts:5-19", "sub": "caps total attempts" }
      ],
      "edges": [{ "from": "retry", "to": "budget", "kind": "new" }]
    }
  ]
}
```

## Field rules

- `views`: 1–6 diagrams. `kind` is `architecture` (the parts involved and how they depend on each other), `flow` (how data or control moves through the change, in order) or `calls` (which function calls which). Draw the ones that help this change; three views are not required.
- `nodes`: 2–40 per view. `label` is required (up to 60 characters; the box shows as much as fits). `id` is what edges refer to (up to 80 characters); a node without one is given `n1`, `n2`, ….
- Text is cut to its limit without a note: `title` 120 characters, `summary` 1200, a view's `title` 80 and `caption` 600, `sub` 90, `group` 40, an edge `label` 40.
- **Where a node's code is**: `at: "path:start-end"`, or `file`, `line`, `end` apart. Give a function its whole range, not only its first line. A path may be a file or a directory (`"app/server/"`), written from the repository root exactly as `gr diff --stat` and git spell it (no `./`, no `..`, the same letter case). Omit it for something that is not code in this repository (a browser, a database, a person).
- `sub`: one short line under the label (up to 90 characters). Without it the box shows the file name and lines.
- `group`: the part of the system a node belongs to. Nodes of one group share a colour, and the diagram has a legend for them.
- `edges`: `{ "from", "to", "label", "kind" }`, or the short form `["from", "to", "label", "kind"]`. `label` is optional and short (up to 40 characters). `kind` is `"new"` (this change adds the connection), `"removed"` (it removes it) or omitted. Up to 80 per view. The arrow points from `from` to `to`; cycles are fine.

## What the server does with it

Git is the authority, so the visual is reconciled, not trusted. `gr visualize` prints each correction:

- **A node's status is never yours to state.** The server reads it from the diff: `new` (the file was added), `changed` (the file changed and, when you gave lines, a line was added in them or removed in or right next to them), `deleted`, `unchanged` (the code exists and this change does not touch it), `none` (no code named). A `status` field in your JSON is ignored. A directory is judged by the changed files inside it and the files the change moved out of it: `new` when it did not exist before, `deleted` when nothing is left in it, otherwise `changed`.
- a path git does not have on the compare side is removed from its node (the box stays, as "not code"). Only git is asked: a file git ignores, an untracked file left out of the review, or anything reached through a link does not count;
- a first line beyond the end of its file is removed (the node keeps the file); a range that runs past the end is cut to the file's last line; a range that ends before it starts keeps its first line;
- an edge to an id that is not a node of that view, a self-loop and a repeated edge are dropped;
- a node without a label, a second node with the same id, and a view left with fewer than two nodes are dropped;
- an unknown `kind` is shown as `architecture`;
- nodes beyond 40 and edges beyond 80 in a view, and views beyond 6, are dropped.

After 40 corrections the rest are counted, not listed.

A visual with no usable view is refused and the stored one is left alone. Storing a visual replaces the previous one. It is kept apart from the walkthrough: `gr annotate` does not touch it. When the code changes afterwards the page says the diagrams are out of date and offers "Ask Claude Code to redraw them", which arrives as a `visualize` request with `"update": true`; the current visual is in `gr state --json` under `state.visual` (with the commit it was drawn at in `endSha`, and `visualStale` beside `state`). `gr drift` does not help here: it measures from the walkthrough or the approval, not from the drawing. Read `gr diff` again.

Edge `kind` is the one thing the server cannot check. The page labels such edges as your reading of the change. Mark an edge `new` or `removed` only when you have read both sides of the diff and seen the call or dependency appear or disappear.

## Drawing a good one

- Read the code before drawing: the changed files in full, their callers and what they call. A connection you did not see in the code does not go in the diagram.
- One idea per view. A view that needs more than about 15 boxes is two views.
- Include the unchanged neighbours that make the change understandable (the caller of a changed function, the store a new module writes to). The reviewer sees at a glance which boxes are changed and which are context.
- `architecture`: boxes are modules, directories, processes or outside systems, not functions. `flow`: boxes are steps, in the order data moves; label the edges with what is passed. `calls`: boxes are functions with their line ranges; an edge means "calls".
- Label a box with the name the code uses (`reconcile()`, `RetryBudget`), so the reviewer can search for it.
- If the reviewer gave a steer with the request, draw that first.
