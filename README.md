# agent-todos

A Claude Code mod that puts the todos of **every agent working in this project** on one board: your main session, its subagents, and any other Claude Code session open in the same folder tree. Items that **only you can do** are pinned to the top.

```
Search: deploy p0_
aisetup · 7 open · 2 on you · 3 match
★ P0 Add STRIPE_KEY to Vercel env  you · 8c2209 · unblocks 2 · press to tick off
▶ P1 Wire checkout webhook         main · 8c2209
⧗ P0 Deploy preview                a3f9 · 4d11e0 · blocked
```

## Install

```
/plugin install agent-todos --marketplace XyndoX/agent-todos
```

Answer `y` to add the marketplace, then pick a scope. User scope puts it in every session.

## Use

- `/todos` opens the board. `/todos stripe p0` opens it with a search already filled in.
- While something is waiting on you, the status line shows `★ N on you`.
- A row matches the search only if it contains every word you typed. Words are checked against the title, notes and agent name. You can also type `p0`–`p3`, `you`, `blocked` or `in_progress`.
- Press a ★ row to tick it off.

## How items get on the board

Each session running the mod copies its agents' `TaskCreate`, `TaskUpdate` and `TodoWrite` calls into `~/.claude/agent-todos/<sessionId>.json`. Every session reads all of those files. It shows the ones whose folder is inside its project root, or contains it.

**Yours (★)**: any of
- the model calls the `human_todo` tool (the mod tells every agent to do this for logins, secrets, purchases, decisions and approvals)
- a task subject starts with `[you]`, `you:`, `@me`, …
- `TaskUpdate` sets `owner` to `user` / `you` / `me` / `human`
- `TaskCreate` with `metadata: { human: true }`

**Priority**: `P0`…`P3` in a subject, or `metadata: { priority: 0..3 }`. The default is P2.

**Order**: yours first, then unblocked before blocked, then by priority, then in-progress items, then by how many other items each one unblocks.

An agent's items disappear when its session ends. Yours stay until you tick them off.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## Current limits

- Ticking off one of your items doesn't tell the agent that asked for it. Tell the agent yourself, or it will still see the task as pending.
- A session without this mod installed doesn't share its todos.

MIT
