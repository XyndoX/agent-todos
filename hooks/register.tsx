import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Row, SessionFile } from '../types'
import { VIEWS, inView, isHumanOwner, matches, parseScan, parseTitle, rank, rowKey } from './board'

const PANE = 'agent-todos'
const rowsAtom = atom({ plugin: 'agent-todos', key: 'rows' } as const, [] as Row[])
const queryAtom = atom({ plugin: 'agent-todos', key: 'query' } as const, '')
const rootAtom = atom({ plugin: 'agent-todos', key: 'root' } as const, '')
const viewAtom = atom({ plugin: 'agent-todos', key: 'view' } as const, 'all')
const selAtom = atom({ plugin: 'agent-todos', key: 'selected' } as const, '')

const GUIDE = `## Agent todo board
The person sees one board of every agent's todos in this project. When something can only be done by the person (a login, a secret, a purchase, a decision, a physical action, an approval), call \`mcp__agent-todos__human_todo\` with a short imperative title and a priority (0 urgent … 3 someday) instead of only mentioning it in prose. Mark a task as the person's with TaskUpdate owner "user", or prefix its subject with "[you]". "P0".."P3" in a subject sets its priority.`

type $ = EngineInterface

async function paths($: $) {
  const home = (await $.env.get('HOME')) ?? ''
  return { dir: `${home}/.claude/agent-todos`, sessions: `${home}/.claude/sessions` }
}

async function readJson<T>($: $, path: string): Promise<T | undefined> {
  try { return JSON.parse(await $.fs.read(path)) as T } catch { return undefined }
}

// This session's own file: read, change, write. Serialized so parallel tool calls don't clobber each other.
let chain: Promise<unknown> = Promise.resolve()
function editMine($: $, fn: (items: Item[]) => Item[]) {
  chain = chain.then(async () => {
    const { dir } = await paths($)
    const sessionId = await $.session.id()
    const path = `${dir}/${sessionId}.json`
    const old = await readJson<SessionFile>($, path)
    const file: SessionFile = {
      sessionId,
      cwd: await $.session.root(),
      updatedAt: await $.clock.now(),
      items: fn(old?.items ?? []),
    }
    await $.fs.write(path, JSON.stringify(file, null, 1))
  }).then(() => refresh($)).catch(() => undefined)
  return chain
}

async function refresh($: $) {
  const { dir, sessions } = await paths($)
  const root = await $.session.root()
  const live = new Set<string>()
  for (const f of await $.fs.list(sessions).catch(() => [])) {
    if (!f.name.endsWith('.json')) continue
    const s = await readJson<{ sessionId?: string }>($, `${sessions}/${f.name}`)
    if (s?.sessionId) live.add(s.sessionId)
  }
  const files: SessionFile[] = []
  for (const f of await $.fs.list(dir).catch(() => [])) {
    if (!f.name.endsWith('.json')) continue
    const s = await readJson<SessionFile>($, `${dir}/${f.name}`)
    if (s?.items) files.push(s)
  }
  const done = new Set(((await $.store.get('done')) as string[] | undefined) ?? [])
  const prio = ((await $.store.get('prio')) as Record<string, number> | undefined) ?? {}
  const rows = rank(files, root, live, done, prio)
  await update($, rowsAtom, () => rows)
  await update($, rootAtom, () => root)
  const mine = rows.filter(r => r.isHuman).length
  await $.ui.status(mine ? `★ ${mine} on you` : undefined)
}

async function tickDone($: $, row: Row) {
  const done = ((await $.store.get('done')) as string[] | undefined) ?? []
  // ponytail: done-list grows forever; prune by age if it ever matters
  await $.store.set('done', [...done, rowKey(row)].slice(-2000))
  await update($, selAtom, () => '')
  await refresh($)
  await $.ui.toast(`✓ ${row.title}`)
}

async function setPrio($: $, row: Row, priority: number) {
  const prio = ((await $.store.get('prio')) as Record<string, number> | undefined) ?? {}
  await $.store.set('prio', { ...prio, [rowKey(row)]: priority })
  await refresh($)
}

const SCAN_RE = '(TODO|FIXME|HACK|XXX)|^[[:space:]]*([-*+]|[0-9]+\\.)[[:space:]]+\\[ \\]'

/** Find TODO/FIXME/HACK/XXX comments and open `- [ ]` checkboxes in the project; they replace the last scan. */
async function scanRepo($: $) {
  const root = await $.session.root()
  await $.ui.toast('⟳ Scanning repo for todos…')
  try {
    const git = await $.process.run(['git', 'grep', '-n', '-I', '-E', SCAN_RE, '--', '.', ':!*.lock', ':!*.min.*', ':!*.map'], { cwd: root, timeoutMs: 60_000 })
    const out = git.exitCode <= 1 && !git.stderr.includes('not a git repository')
      ? git.stdout
      : (await $.process.run(['grep', '-rnI', '-E', SCAN_RE, '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist', '--exclude-dir=build', '.'], { cwd: root, timeoutMs: 60_000 })).stdout
    const name = (await $.process.run(['git', 'config', 'user.name'], { cwd: root }).catch(() => undefined))?.stdout.trim() ?? ''
    const home = ((await $.env.get('HOME')) ?? '').split('/').pop() ?? ''
    const found = parseScan(out, { me: [...name.split(/\s+/), home] })
    await editMine($, items => [...items.filter(i => !i.id.startsWith('scan:')), ...found])
    await update($, viewAtom, () => 'all')
    await $.ui.toast(found.length ? `⟳ Found ${found.length} todo${found.length > 1 ? 's' : ''} in the repo` : '⟳ No TODOs or open checkboxes found')
  } catch (err) {
    await $.ui.toast(`Scan failed: ${String(err).slice(0, 120)}`)
  }
}

/** Hand the task to the agent that owns it: a turn here, or a message to the other session. */
async function kickOff($: $, row: Row) {
  const where = row.agent === 'repo' ? `\n\nFound at ${row.note} — remove the TODO / tick the checkbox when done.` : row.note ? `\n\n${row.note}` : ''
  const text = `Start on this task now${row.priority <= 1 ? ' (high priority)' : ''}: "${row.title}"${where}`
  try {
    if (row.agent === 'repo' || row.sessionId === (await $.session.id())) await $.prompt.submit({ text })
    else await $.session.send({ to: { sessionId: row.sessionId }, text })
    await $.ui.toast(`▶ Kicked off: ${row.title}`)
  } catch (err) {
    await $.ui.toast(`Could not reach that agent: ${String(err).slice(0, 120)}`)
  }
}

const label = (e: { agentId?: string }) => e.agentId ?? 'main'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'todos', description: 'Open the agent todo board (a search query, or "scan" to collect TODOs from the repo)' })
    await $.tool.register({
      name: 'human_todo',
      description:
        'Put a todo on the person\'s board that only they can complete (login, secret, purchase, decision, approval, physical action). Short imperative title.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'What the person must do, imperative, < 80 chars' },
          priority: { type: 'integer', minimum: 0, maximum: 3, description: '0 urgent, 1 high, 2 normal, 3 someday' },
          why: { type: 'string', description: 'What it unblocks / extra context' },
        },
        required: ['title'],
      },
      isDeferred: false,
    })
    await editMine($, items => items) // announce this session
    await $.clock.every(5000, () => refresh($))
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { sections: [...r.sections, { id: 'agent-todos:guide', text: GUIDE, scope: 'session' }] }
  })

  on('command.run', { command: 'todos' }, async ($, e) => {
    const isScan = e.args.trim() === 'scan'
    await $.state.set({ plugin: 'agent-todos', key: 'query' }, isScan ? '' : e.args.trim())
    if (isScan) await scanRepo($)
    else await refresh($)
    await $.ui.open({ id: PANE, title: 'Agent todos' })
    return { text: 'Agent todo board opened.' }
  })

  on('tool.call', { tool: 'mcp__agent-todos__human_todo' }, async ($, e) => {
    const args = e as unknown as { title?: unknown; priority?: unknown; why?: unknown; agentId?: string }
    if (typeof args.title !== 'string' || !args.title.trim()) return { deny: 'title is required' }
    const p = Number(args.priority)
    const id = `human:${await $.clock.now()}`
    await editMine($, items => [...items, {
      id,
      title: args.title as string,
      status: 'pending',
      priority: Number.isInteger(p) && p >= 0 && p <= 3 ? p : 2,
      isHuman: true,
      blockedBy: [],
      agent: label(args),
      note: typeof args.why === 'string' ? args.why : undefined,
    }])
    return { result: `Added to the person's board (${id}). They tick it off there.` }
  }).catch(() => ({ deny: 'agent-todos could not save the item' }))

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const r = await next(e)
    if ('deny' in r && r.deny) return r
    const id = (r.result as { task?: { id?: string } } | undefined)?.task?.id
    if (!id) return r
    const parsed = parseTitle(e.subject)
    const meta = (e.metadata ?? {}) as { priority?: unknown; human?: unknown }
    const p = Number(meta.priority)
    await editMine($, items => [...items.filter(i => i.id !== `task:${id}`), {
      id: `task:${id}`,
      title: parsed.title,
      status: 'pending',
      priority: Number.isInteger(p) && p >= 0 && p <= 3 ? p : parsed.priority,
      isHuman: parsed.isHuman || meta.human === true,
      blockedBy: [],
      agent: label(e),
      note: e.description,
    }])
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const r = await next(e)
    if ('deny' in r && r.deny) return r
    const id = `task:${e.taskId}`
    await editMine($, items => {
      if (e.status === 'deleted') return items.filter(i => i.id !== id)
      return items.map(i => {
        if (i.id !== id) return i
        const parsed = e.subject ? parseTitle(e.subject) : undefined
        return {
          ...i,
          ...(parsed && { title: parsed.title, priority: parsed.priority, isHuman: i.isHuman || parsed.isHuman }),
          ...(e.status && e.status !== 'deleted' && { status: e.status }),
          ...(e.description && { note: e.description }),
          ...(e.owner !== undefined && { isHuman: isHumanOwner(e.owner) }),
          blockedBy: [...new Set([...i.blockedBy, ...(e.addBlockedBy ?? []).map(b => `task:${b}`)])],
        }
      })
    })
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const r = await next(e)
    if ('deny' in r && r.deny) return r
    const agent = label(e)
    await editMine($, items => [
      ...items.filter(i => !(i.agent === agent && i.id.startsWith('todo:'))),
      ...e.todos.map((t, n) => {
        const parsed = parseTitle(t.content)
        return { id: `todo:${agent}:${n}`, ...parsed, status: t.status, blockedBy: [], agent }
      }),
    ])
    return r
  }).catch(($, e, next) => next(e))


  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Input = 'Input' in ui ? ui.Input : undefined // mobile has no Input
    const all = await read($, rowsAtom)
    const query = await read($, queryAtom)
    const view = await read($, viewAtom)
    const selected = await read($, selAtom)
    const root = await read($, rootAtom)
    const me = await $.session.id()
    const width = Math.max(30, (e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 80)
    const rows = all.filter(r => inView(r, view) && matches(r, query))
    const sel = all.find(r => rowKey(r) === selected)
    const project = root.split('/').filter(Boolean).pop() ?? root
    let room = Math.max(3, (e.viewport?.rows ?? 30) - 8 - (sel ? 11 : 0))

    // Agent groups, OmniFocus-project style; your items first as their own group.
    const groups = new Map<string, Row[]>()
    for (const r of rows) {
      const g = r.isHuman ? 'you' : r.agent === 'repo' ? 'repo' : `${r.sessionId}|${r.agent}`
      groups.set(g, [...(groups.get(g) ?? []), r])
    }

    const tab = (v: string) => {
      const n = all.filter(r => inView(r, v)).length
      const isOn = v === view
      const { glyph, name, color } = TABS[v as keyof typeof TABS]
      return (
        <Button key={`view:${v}`} plain onPress={() => void update($, viewAtom, () => v)}>
          <Text color={isOn ? '#1c1c1e' : color} backgroundColor={isOn ? color : undefined} bold={isOn}>{` ${glyph} ${name} ${n} `}</Text>
        </Button>
      )
    }

    const row = (r: Row) => {
      const b = bullet(r)
      const pc = PRIO[r.priority] ?? PRIO[2]!
      const isSel = rowKey(r) === selected
      const tail = `${r.priority <= 1 ? ' ⚑' : ''} P${r.priority}${r.blocks ? ` ⇢${r.blocks}` : ''}${r.isLive ? '' : ' ✝'}`
      const title = cut(r.title, width - tail.length - 5)
      return (
        <Button key={`row:${rowKey(r)}`} plain onPress={() => void update($, selAtom, s => (s === rowKey(r) ? '' : rowKey(r)))}>
          <Text color={b.color} bold>{` ${b.glyph} `}</Text>
          <Text bold={isSel} inverse={isSel} strikethrough={false} dimColor={r.isBlocked && !isSel}>{title}</Text>
          {r.priority <= 1 && <Text color={pc.color}>{' ⚑'}</Text>}
          <Text color="#1c1c1e" backgroundColor={pc.color}>{` P${r.priority} `}</Text>
          {r.blocks > 0 && <Text color="#64d2ff">{` ⇢${r.blocks}`}</Text>}
          {!r.isLive && <Text dimColor>{' ✝'}</Text>}
        </Button>
      )
    }

    const header = (g: string, list: Row[]) => {
      if (g === 'you') return <Text key="h:you" color={TABS.you.color} bold>{`◆ Waiting on you  ${list.length}`}</Text>
      if (g === 'repo') return <Text key="h:repo"><Text color={REPO_COLOR} bold>▤ Found in repo</Text><Text dimColor>{`  TODO comments & open checkboxes · ${list.length}`}</Text></Text>
      const r = list[0]!
      const c = agentColor(`${r.sessionId}${r.agent}`)
      const where = r.sessionId === me ? 'this session' : `session ${r.sessionId.slice(0, 6)}`
      return (
        <Text key={`h:${g}`}>
          <Text color={c} bold>{`● ${r.agent === 'main' ? 'main agent' : `agent ${r.agent.slice(0, 8)}`}`}</Text>
          <Text dimColor>{`  ${where}${r.isLive ? '' : ' · ended'} · ${list.length}`}</Text>
        </Text>
      )
    }

    const inspector = (r: Row) => {
      const pc = PRIO[r.priority] ?? PRIO[2]!
      const blockers = r.blockedBy.map(id => all.find(o => o.sessionId === r.sessionId && o.id === id)?.title).filter(Boolean)
      const field = (k: string, v: string, color?: string) => (
        <Text key={`f:${k}`}><Text dimColor>{k.padEnd(10)}</Text><Text color={color}>{v}</Text></Text>
      )
      return (
        <Box key="inspector" flexDirection="column" borderStyle="round" borderColor={bullet(r).color} paddingX={1} marginTop={1}>
          <Text bold color={bullet(r).color}>{`${bullet(r).glyph} ${r.title}`}</Text>
          {r.note && r.agent !== 'repo' ? <Text dimColor wrap="wrap">{r.note}</Text> : null}
          {field('Status', r.isBlocked ? 'blocked' : r.status.replace('_', ' '), bullet(r).color)}
          {field('Priority', `P${r.priority} · ${pc.name}`, pc.color)}
          {r.agent === 'repo' && field('Found at', r.note ?? '', REPO_COLOR)}
          {field('Owner', r.isHuman ? 'you' : r.agent === 'repo' ? 'repo · kick off assigns it here' : r.agent, r.isHuman ? TABS.you.color : agentColor(`${r.sessionId}${r.agent}`))}
          {field('Session', `${r.sessionId.slice(0, 8)}${r.sessionId === me ? ' (this one)' : ''}${r.isLive ? '' : ' · ended'}`)}
          {blockers.length > 0 && field('Waits on', blockers.join(', '), '#8e8e93')}
          {r.blocks > 0 && field('Unblocks', `${r.blocks} task${r.blocks > 1 ? 's' : ''}`, '#64d2ff')}
          <Box flexDirection="row" gap={1} marginTop={1}>
            {!r.isHuman && (r.isLive || r.agent === 'repo') && <Button key="act:kick" hotkey="k" variant="primary" label="▶ Kick off" onPress={() => void kickOff($, r)} />}
            <Button key="act:done" hotkey="d" label="✓ Done" onPress={() => void tickDone($, r)} />
            <Button key="act:close" hotkey="x" role="dismiss" label="Close" onPress={() => void update($, selAtom, () => '')} />
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text dimColor>{'Change to'.padEnd(10)}</Text>
            {PRIO.map((p, n) => (
              <Button key={`act:p${n}`} plain onPress={() => void setPrio($, r, n)}>
                <Text color={n === r.priority ? '#1c1c1e' : p.color} backgroundColor={n === r.priority ? p.color : undefined} bold={n === r.priority}>{` P${n} `}</Text>
              </Button>
            ))}
          </Box>
        </Box>
      )
    }

    const body: unknown[] = []
    for (const [g, list] of groups) {
      if (room <= 1) break
      body.push(header(g, list))
      room--
      for (const r of list.slice(0, room)) body.push(row(r))
      room -= Math.min(list.length, room)
    }
    const shown = body.length - groups.size

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color={TABS.you.color}>☑ Agent Todos</Text>
          <Box flexDirection="row" gap={1}>
            <Text dimColor>{`${project} · ${all.length} open`}</Text>
            <Button key="scan" plain onPress={() => void scanRepo($)}>
              <Text color="#1c1c1e" backgroundColor={REPO_COLOR}>{' ⟳ Scan repo '}</Text>
            </Button>
          </Box>
        </Box>
        <Box flexDirection="row" flexWrap="wrap">{VIEWS.map(tab)}</Box>
        {Input && (
          <Input key="q" label="⌕" placeholder="search titles, notes, agents, p0…" value={query} submitLabel="filter"
            onInput={v => void update($, queryAtom, () => v)} onSubmit={v => void update($, queryAtom, () => v)} />
        )}
        {rows.length === 0 && (
          <Text dimColor>{all.length ? '  Nothing in this perspective.' : '  All clear — agents add todos with TaskCreate / human_todo.'}</Text>
        )}
        {body as never}
        {rows.length > shown && shown >= 0 && <Text dimColor>{`  +${rows.length - Math.max(0, shown)} more — search or switch perspective`}</Text>}
        {sel && inspector(sel)}
      </Box>
    )
  })
}

const TABS = {
  you: { glyph: '◆', name: 'You', color: '#bf5af2' },
  urgent: { glyph: '⚑', name: 'Urgent', color: '#ff9f0a' },
  active: { glyph: '◐', name: 'Active', color: '#30d158' },
  blocked: { glyph: '⊘', name: 'Blocked', color: '#8e8e93' },
  all: { glyph: '≡', name: 'All', color: '#0a84ff' },
}

const PRIO = [
  { name: 'urgent', color: '#ff453a' },
  { name: 'high', color: '#ff9f0a' },
  { name: 'normal', color: '#0a84ff' },
  { name: 'someday', color: '#8e8e93' },
]

/** Each kind of todo gets its own bullet: yours, running, blocked, then by priority. */
function bullet(r: Row) {
  if (r.isHuman) return { glyph: '◆', color: TABS.you.color }
  if (r.status === 'in_progress') return { glyph: '◐', color: TABS.active.color }
  if (r.isBlocked) return { glyph: '⊘', color: TABS.blocked.color }
  const p = PRIO[r.priority] ?? PRIO[2]!
  if (r.agent === 'repo') return { glyph: r.id.startsWith('scan:md:') ? '☐' : '✎', color: p.color }
  return { glyph: r.priority === 0 ? '◉' : r.priority === 3 ? '◌' : '○', color: p.color }
}

const REPO_COLOR = '#ac8e68'

const AGENT_COLORS = ['#64d2ff', '#ffd60a', '#ff375f', '#66d4cf', '#5e5ce6', '#ac8e68', '#30d158']
function agentColor(s: string) {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0
  return AGENT_COLORS[Math.abs(h) % AGENT_COLORS.length]!
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)
