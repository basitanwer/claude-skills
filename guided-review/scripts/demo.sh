#!/bin/sh
# End-to-end demonstration on a throwaway repository. No model is involved: this
# script plays the Claude Code session (every `gr` call below is what the session
# would run, with `gr listen` in the background as its Monitor), and the reviewer's
# clicks in the UI are simulated with `gr rpc`.
# The review UI opens in your browser so you can watch it follow along; the demo
# server keeps running until you stop it with the command printed at the end.
set -e
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
GR="$SKILL/scripts/gr"
# GUIDED_REVIEW_DEMO_HOME and GUIDED_REVIEW_PORT let several demos run side by side.
export GUIDED_REVIEW_HOME="${GUIDED_REVIEW_DEMO_HOME:-${TMPDIR:-/tmp}/guided-review-demo}"
export GUIDED_REVIEW_PORT="${GUIDED_REVIEW_PORT:-8799}" GUIDED_REVIEW_OS_NOTIFY=0
"$GR" stop --force >/dev/null 2>&1 || true
rm -rf "$GUIDED_REVIEW_HOME"
FX="$(cd "$SKILL/app" && node -e "import('./tests/helpers.mjs').then((m) => console.log(m.makeFixture().dir))")"
cd "$FX"
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
field() { node -e "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>console.log(JSON.parse(s)['$1']))"; }
pick() { node -e "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log($1)})"; }
# The session's Monitor: `gr listen` prints one JSON line per event. Here its output
# goes to a file and `event` waits for the next line, as a Monitor would deliver it.
LISTEN="$GUIDED_REVIEW_HOME/listen.jsonl"; SEEN=0; LPID=""
listen_start() { : > "$LISTEN"; SEEN=0; "$GR" listen >> "$LISTEN" 2>/dev/null & LPID=$!; }
listen_stop() { if [ -n "$LPID" ]; then kill "$LPID" 2>/dev/null || true; wait "$LPID" 2>/dev/null || true; fi; LPID=""; }
trap listen_stop EXIT
event() {
  i=0
  while [ "$(wc -l < "$LISTEN" | tr -d ' ')" -le "$SEEN" ]; do
    i=$((i + 1)); [ "$i" -gt 150 ] && { echo "(no line from gr listen)"; return 1; }
    sleep 0.1
  done
  SEEN=$((SEEN + 1)); printf 'gr listen > '; sed -n "${SEEN}p" "$LISTEN"
}
pause() { [ -n "$GUIDED_REVIEW_DEMO_FAST" ] || sleep "${1:-2}"; }

step "1. open a comparison (main..feature) — the browser opens here"
"$GR" review main..feature
SID="$("$GR" state --json | field sessionId)"
listen_start
event   # {"type":"ready",…}: the UI now shows Claude Code as listening
pause 3

step "2. write the walkthrough and store it (it is reconciled against git)"
cat > "$GUIDED_REVIEW_HOME/walkthrough.json" <<'JSON'
{
  "title": "a() returns 2; b and c are new",
  "summary": "The behaviour change is one line in `src/a.ts`. Two modules are added and one is removed.",
  "sections": [
    { "id": "core", "name": "Behaviour change", "desc": "The only change callers can observe.",
      "what": "`a()` now returns **2** instead of 1, and a new constant `J` is exported.", "files": ["src/a.ts"],
      "diagram": [ { "label": "callers", "kind": "", "sub": "unchanged" }, { "label": "a()", "kind": "hi", "sub": "returns 2" }, { "label": "J", "kind": "new", "sub": "= 20" } ],
      "insight": { "caption": "Callers that compare against 1 break." } },
    { "id": "modules", "name": "New modules", "desc": "Added without tests.", "what": "`b()` returns 43 and `c` is a constant.", "files": ["src/b.ts", "src/c.ts", "src/not-in-the-diff.ts"] }
  ],
  "questions": [ { "id": "q1", "text": "Is returning 2 intended, or a leftover from debugging?", "options": ["Intended", "Leftover"] } ],
  "planMap": { "acceptance": [ { "text": "criterion one", "met": "partial" }, { "text": "criterion two", "met": false } ],
               "steps": [ { "n": 1, "text": "change a()", "sectionId": "core", "status": "done" }, { "n": 2, "text": "add b()", "sectionId": "modules", "status": "done" } ],
               "deviations": [ { "text": "The plan does not mention removing old.ts.", "sectionId": "" } ] }
}
JSON
"$GR" annotate --file "$GUIDED_REVIEW_HOME/walkthrough.json"
pause

step "3. comment beside the code, several at once with gr batch (anchors come from the real diff)"
cat > "$GUIDED_REVIEW_HOME/comments.json" <<'JSON'
[ { "op": "comment", "file": "src/a.ts", "line": 2, "expect": "return 2", "text": "Return value changed from 1 to 2: callers that compare against 1 will now fail." },
  { "op": "comment", "file": "src/old.ts", "side": "old", "line": 1, "text": "Removed without a deprecation note." },
  { "op": "comment", "section": "modules", "text": "Neither new module has a test." } ]
JSON
NOTE="$("$GR" batch --file "$GUIDED_REVIEW_HOME/comments.json" --json | pick 'j.results[0].id')"
"$GR" comments
echo '[{"op":"comment","file":"src/b.ts","line":2,"text":"fine"},{"op":"comment","file":"src/a.ts","line":400,"text":"this line does not exist"}]' | "$GR" batch - || echo "(refused as a whole: a batch is all or nothing)"
pause

step "4. the reviewer asks a question in the UI; it arrives as a line of gr listen, and the session answers"
Q="$("$GR" rpc requestCreate "[$SID, {\"kind\":\"question\",\"text\":\"What breaks if a() returns 2?\",\"anchor\":{\"kind\":\"diff\",\"file\":\"src/a.ts\",\"line\":2}}]" | field id)"
event
"$GR" progress "$Q" "looking for callers of a()"
pause
"$GR" answer "$Q" --text "Nothing in this repository calls \`a()\`, so nothing breaks here; external callers comparing against 1 would." --file src/a.ts --line 2
pause

step "5. close and resume"
listen_stop
"$GR" stop --force
"$GR" review --resume --session "$SID" --no-open | head -4
listen_start
event
pause

step "6. another commit lands; show only the delta"
printf '// header\nexport function a() {\n  return 3\n}\nexport const K = 10\nexport const L = 11\nexport const M = 12\nexport const J = 20\n' > src/a.ts
git commit -qam "return 3, add header"
"$GR" drift
pause

step "7. the reviewer replies in a thread, adds a comment, and sends both; the session edits (uncommitted) and reports in one batch"
"$GR" rpc commentUpdate "[$SID, \"$NOTE\", {\"reply\":{\"author\":\"user\",\"text\":\"It is 3 now. Is that the final value?\"}}]" > /dev/null
QUEUED="$("$GR" rpc commentAdd "[$SID, {\"anchor\":{\"kind\":\"diff\",\"file\":\"src/a.ts\",\"line\":8},\"text\":\"Why 20? Say what J is for.\",\"author\":\"user\"}]" | field id)"
"$GR" state | grep '^comments:'
A="$("$GR" rpc requestCreate "[$SID, {\"kind\":\"apply\",\"commentIds\":[\"$NOTE\",\"$QUEUED\"]}]" | field id)"
event
printf '// J is the retry budget\n' >> src/a.ts
cat > "$GUIDED_REVIEW_HOME/round.json" <<JSON
[ { "op": "reply", "id": "$NOTE", "text": "Yes: the latest commit settles on 3." },
  { "op": "resolve", "id": "$QUEUED", "verdict": "addressed", "note": "Added a comment saying what J is for." },
  { "op": "focus", "file": "src/a.ts", "line": 9 },
  { "op": "done", "request": "$A", "text": "one reply, one edit" } ]
JSON
"$GR" batch --file "$GUIDED_REVIEW_HOME/round.json"

step "done"
listen_stop
echo "repository: $FX"
echo "git status: $(git status --porcelain | tr '\n' ' ')(the review committed nothing)"
echo "review:     http://127.0.0.1:$GUIDED_REVIEW_PORT/#/review?session=$SID"
echo "stop the demo server: GUIDED_REVIEW_HOME=\"$GUIDED_REVIEW_HOME\" \"$GR\" stop --force"
