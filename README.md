# agent-todos

A Claude Code mod that puts the todos of **every agent working in this project** on one board: your main session, its subagents, and any other Claude Code session open in the same folder tree. Todos that **only you can do** are pinned to the top.

```
☑ Agent Todos                       AiSetup · 6 open
 ◆ You 2  ⚑ Urgent 3  ◐ Active 1  ⊘ Blocked 1  ≡ All 6
⌕: search titles, notes, agents, p0…
◆ Waiting on you  2
 ◆ Add STRIPE_KEY to Vercel env ⚑ P0
 ◆ Approve the new pricing copy P2
● main agent  session 8c2209 · 2
 ◐ Wire checkout webhook ⚑ P1  ⇢1
 ⊘ Deploy preview build ⚑ P0
╭──────────────────────────────────────────╮
│ ◐ Wire checkout webhook                  │
│ Status    in progress                    │
│ Priority  P1 · high                      │
│ [ ▶ Kick off ] [ ✓ Done ] [ Close ]      │
│ Change to   P0   P1   P2   P3            │
╰──────────────────────────────────────────╯
```

Inspired by OmniFocus 4: perspectives, todos grouped by agent like projects, a colored bullet per kind of todo, and an inspector for the selected todo.

| Bullet | Meaning |
| --- | --- |
| ◆ purple | only you can do it |
| ◐ green | an agent is working on it |
| ⊘ gray | blocked by another task |
| ◉ red / ○ orange·blue / ◌ gray | P0 / P1·P2 / P3 |
| ⚑ | P0 or P1 |
| ⇢n | finishing it unblocks n other tasks |
| ✝ | its session has ended |

## Install

```
/plugin install agent-todos --marketplace XyndoX/agent-todos
```

Answer `y` to add the marketplace, then pick a scope. User scope puts it in every session.

## Use

- `/todos` opens the board. `/todos stripe p0` opens it with a search already filled in.
- While something is waiting on you, the status line shows `★ N on you`.
- A row matches the search only if it contains every word you typed. Words are checked against the title, notes and agent name. You can also type `p0`–`p3`, `you`, `blocked` or `in_progress`.
- Click a todo to open the inspector, then:
  - **▶ Kick off** asks the agent that owns the todo to start on it now. A todo of this session starts a turn here. A todo of another session is sent to that session as a message.
  - **✓ Done** ticks it off.
  - **P0–P3** changes its priority (stored per todo on your machine).
- The tabs at the top (You, Urgent, Active, Blocked, All) switch between perspectives.

## How items get on the board

Each session running the mod copies its agents' `TaskCreate`, `TaskUpdate` and `TodoWrite` calls into `~/.claude/agent-todos/<sessionId>.json`. Every session reads all of those files. It shows the ones whose folder is inside its project root, or contains it.

**Yours (◆)**: any of
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
