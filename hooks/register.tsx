import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Row, SessionFile } from '../types'
import { isHumanOwner, matches, parseTitle, rank } from './board'

const PANE = 'agent-todos'
const rowsAtom = atom({ plugin: 'agent-todos', key: 'rows' } as const, [] as Row[])
const queryAtom = atom({ plugin: 'agent-todos', key: 'query' } as const, '')
const rootAtom = atom({ plugin: 'agent-todos', key: 'root' } as const, '')

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
  const rows = rank(files, root, live, done)
  await update($, rowsAtom, () => rows)
  await update($, rootAtom, () => root)
  const mine = rows.filter(r => r.isHuman).length
  await $.ui.status(mine ? `★ ${mine} on you` : undefined)
}

async function tickDone($: $, row: Row) {
  const done = ((await $.store.get('done')) as string[] | undefined) ?? []
  // ponytail: done-list grows forever; prune by age if it ever matters
  await $.store.set('done', [...done, `${row.sessionId}:${row.id}`].slice(-2000))
  await refresh($)
}

const label = (e: { agentId?: string }) => e.agentId ?? 'main'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'todos', description: 'Open the agent todo board (optional: a search query)' })
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
    await $.state.set({ plugin: 'agent-todos', key: 'query' }, e.args.trim())
    await refresh($)
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
    const root = await read($, rootAtom)
    const rows = all.filter(r => matches(r, query))
    const yours = all.filter(r => r.isHuman).length
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 6)
    const project = root.split('/').filter(Boolean).pop() ?? root

    const line = (r: Row) => {
      const mark = r.isHuman ? '★' : r.status === 'in_progress' ? '▶' : r.isBlocked ? '⧗' : '○'
      const meta = [
        r.isHuman ? 'you' : r.agent,
        r.sessionId.slice(0, 6),
        r.isBlocked ? 'blocked' : '',
        r.blocks ? `unblocks ${r.blocks}` : '',
        r.isLive ? '' : 'session ended',
      ].filter(Boolean).join(' · ')
      return [`${mark} P${r.priority} ${r.title} `, meta] as const
    }

    return (
      <Box flexDirection="column">
        {Input && (
          <Input
            key="q"
            label="Search"
            placeholder="words, p0, you, blocked, agent…"
            value={query}
            submitLabel="filter"
            onInput={v => void update($, queryAtom, () => v)}
            onSubmit={v => void update($, queryAtom, () => v)}
          />
        )}
        <Text dimColor>
          {project} · {all.length} open · {yours} on you{query ? ` · ${rows.length} match` : ''}
        </Text>
        {rows.length === 0 && <Text dimColor>{all.length ? 'Nothing matches.' : 'No open todos. Agents add them with TaskCreate / human_todo.'}</Text>}
        {rows.slice(0, room).map(r => {
          const [text, meta] = line(r)
          return r.isHuman ? (
            <Button key={`${r.sessionId}:${r.id}`} plain onPress={() => void tickDone($, r)}>
              <Text color="yellow" bold>{text}</Text>
              <Text dimColor>{meta} · press to tick off</Text>
            </Button>
          ) : (
            <Text key={`${r.sessionId}:${r.id}`} dimColor={r.isBlocked}>
              {text}
              <Text dimColor>{meta}</Text>
            </Text>
          )
        })}
        {rows.length > room && <Text dimColor>+{rows.length - room} more — narrow the search</Text>}
      </Box>
    )
  })
}
