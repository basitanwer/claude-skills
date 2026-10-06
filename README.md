# Claude Code skills

Skills for [Claude Code](https://claude.com/claude-code). Each top-level folder is one skill.

| Skill | What it does |
|---|---|
| [guided-review](guided-review/) | Opens a local, GitHub-style review page for any commit, range, branch or working tree. The Claude Code session writes the walkthrough, comments beside the code, answers questions asked in the page, and applies feedback on request. |

## Install

Link a skill into your skills folder, then start a new Claude Code session:

```bash
git clone https://github.com/basitanwer/claude-skills ~/claude-skills
ln -s ~/claude-skills/guided-review ~/.claude/skills/guided-review
~/.claude/skills/guided-review/scripts/gr doctor
```

`guided-review` needs Node 20 or newer and git. Its web UI ships built (`app/web/dist`), so there is nothing to install; `scripts/install.sh --rebuild` rebuilds it after changing `app/web`.
