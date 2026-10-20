import type { Item, Row, SessionFile } from '../types'

const HUMAN_RE = /^\s*(\[(you|human|me|user)\]|@(you|me|human|user)\b|(you|human|user):)\s*/i
const PRIO_RE = /\bP([0-3])\b/i
const HUMAN_OWNER_RE = /^(you|me|human|user)$/i

/** "[you] P0 rotate the API key" → human, priority 0, "rotate the API key" */
export function parseTitle(raw: string) {
  const isHuman = HUMAN_RE.test(raw)
  const m = raw.match(PRIO_RE)
  const title = raw.replace(HUMAN_RE, '').replace(PRIO_RE, '').replace(/\s+/g, ' ').trim()
  return { title: title || raw.trim(), priority: m ? Number(m[1]) : 2, isHuman }
}

export const isHumanOwner = (owner: unknown) => typeof owner === 'string' && HUMAN_OWNER_RE.test(owner)

const isUnder = (a: string, b: string) => a === b || a.startsWith(b.endsWith('/') ? b : b + '/')

/** Relevant = same project tree, either direction. */
export const isRelevant = (cwd: string, root: string) => isUnder(cwd, root) || isUnder(root, cwd)

export function matches(row: Row, query: string) {
  const hay = [
    row.title, row.note ?? '', row.agent, `p${row.priority}`, row.status,
    row.isHuman ? 'you human me' : '', row.isBlocked ? 'blocked' : '',
  ].join(' ').toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(t => hay.includes(t))
}

const open = (i: Item) => i.status !== 'completed'

/**
 * Open items of relevant sessions, ranked: yours first, then unblocked before
 * blocked, priority, in-progress, how much each one unblocks.
 * Agent items die with their session; your items stay until you tick them.
 */
/** Scan items belong to the repo, not the session that found them: ticking one off sticks across sessions. */
export const rowKey = (r: { sessionId: string; id: string }) => (r.id.startsWith('scan:') ? r.id : `${r.sessionId}:${r.id}`)

// The marker must open the line or a comment, so prose like "closes the INTEGRATION TODO in x" is skipped.
const MARK_RE = /(?:^|\/\/|\/\*|<!--|#|--|;|\*|\{)\s*(TODO|FIXME|HACK|XXX)\b\s*(?:\([^)]*\))?\s*[:\-]?\s*(.*)$/
const BOX_RE = /^\s*(?:[-*+]|\d+\.)\s+\[ \]\s+(.*)$/
const CLOSER_RE = /\s*(\*\/|-->|#\}|%>|\}\}|\*\/\})\s*$/

const ROADMAP_RE = /(^|\/)(ROADMAP|NEXT[-_]?TASKS|TODOS?|BACKLOG|TASKS|CHANGELOG-TODO)\.(md|txt)$/i

/**
 * `git grep -n` output → items: open markdown checkboxes and TODO/FIXME/HACK/XXX comments.
 * Roadmap-type files keep their priority; checkboxes in other docs (plans, notes) drop to P3.
 * A line that starts with one of `me` ("Chris:") is the person's.
 */
export function parseScan(out: string, opts: { max?: number; me?: string[] } = {}): Item[] {
  const max = opts.max ?? 300
  const me = (opts.me ?? []).filter(n => n.length > 1).map(n => n.toLowerCase())
  const items = new Map<string, Item>()
  for (const line of out.split('\n')) {
    const m = line.match(/^(.+?):(\d+):(.*)$/)
    if (!m) continue
    const [, rawPath, ln, text] = m as unknown as [string, string, string, string]
    const path = rawPath.replace(/^\.\//, '')
    const isMd = /\.(md|markdown|txt)$/i.test(path)
    const box = isMd ? text.match(BOX_RE) : null
    const mark = isMd ? null : text.match(MARK_RE) // in prose only checkboxes count
    const raw = (box?.[1] ?? mark?.[2] ?? '').replace(CLOSER_RE, '').replace(/\*\*|__|`/g, '').trim()
    if (raw.length < 3 || raw.startsWith('~~')) continue // struck through = done
    const owner = raw.match(/^([\p{L}][\p{L}'-]*)\s*:\s*/u)
    const isMine = !!owner && me.includes(owner[1]!.toLowerCase().split(/[-']/)[0]!) // "Chris:", "Chris-only:"
    const parsed = parseTitle(isMine ? raw.slice(owner![0].length) : raw)
    if (isMine) parsed.isHuman = true
    if (box && !ROADMAP_RE.test(path) && parsed.priority === 2) parsed.priority = 3
    const kind = box ? 'md' : 'code'
    const id = `scan:${kind}:${path}:${raw.slice(0, 80)}`
    if (items.has(id)) continue
    items.set(id, {
      id,
      ...parsed,
      priority: mark?.[1] === 'FIXME' && parsed.priority === 2 ? 1 : parsed.priority,
      status: 'pending',
      blockedBy: [],
      agent: 'repo',
      note: `${path}:${ln}`,
    })
  }
  // Cap after sorting so a docs/ folder full of plan checkboxes can't crowd out the roadmap and the code.
  const tier = (i: Item) => (ROADMAP_RE.test(i.note!.replace(/:\d+$/, '')) ? 0 : i.id.startsWith('scan:code:') ? 1 : 2)
  return [...items.values()].map((i, n) => ({ i, n })).sort((a, b) => tier(a.i) - tier(b.i) || a.n - b.n).slice(0, max).map(x => x.i)
}

export const VIEWS = ['you', 'urgent', 'active', 'blocked', 'all'] as const
export type View = (typeof VIEWS)[number]

/** OmniFocus-style perspectives. */
export function inView(r: Row, view: string) {
  if (view === 'you') return r.isHuman
  if (view === 'urgent') return r.priority <= 1
  if (view === 'active') return r.status === 'in_progress'
  if (view === 'blocked') return r.isBlocked
  return true
}

export function rank(
  files: SessionFile[], root: string, live: Set<string>, done: Set<string>, prio: Record<string, number> = {},
): Row[] {
  const rows: Row[] = []
  const seen = new Set<string>()
  for (const f of files) {
    if (!isRelevant(f.cwd, root)) continue
    const isLive = live.has(f.sessionId)
    const items = f.items.filter(i => open(i) && !done.has(rowKey({ sessionId: f.sessionId, id: i.id })))
    const openIds = new Set(items.map(i => i.id))
    for (const i of items) {
      if (!isLive && !i.isHuman) continue
      const k = rowKey({ sessionId: f.sessionId, id: i.id })
      if (seen.has(k)) continue // the same repo scanned from two sessions
      seen.add(k)
      rows.push({
        ...i,
        priority: prio[k] ?? i.priority,
        sessionId: f.sessionId,
        cwd: f.cwd,
        isLive,
        isBlocked: i.blockedBy.some(id => openIds.has(id)),
        blocks: items.filter(o => o.blockedBy.includes(i.id)).length,
      })
    }
  }
  const key = (r: Row) => [
    r.isHuman ? 0 : 1, r.isBlocked ? 1 : 0, r.priority, r.status === 'in_progress' ? 0 : 1, -r.blocks,
  ]
  return rows.sort((a, b) => {
    const ka = key(a), kb = key(b)
    for (let n = 0; n < ka.length; n++) if (ka[n] !== kb[n]) return (ka[n] ?? 0) - (kb[n] ?? 0)
    return a.title.localeCompare(b.title)
  })
}
