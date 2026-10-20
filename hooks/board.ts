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
export const rowKey = (r: { sessionId: string; id: string }) => `${r.sessionId}:${r.id}`

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
  for (const f of files) {
    if (!isRelevant(f.cwd, root)) continue
    const isLive = live.has(f.sessionId)
    const items = f.items.filter(i => open(i) && !done.has(`${f.sessionId}:${i.id}`))
    const openIds = new Set(items.map(i => i.id))
    for (const i of items) {
      if (!isLive && !i.isHuman) continue
      rows.push({
        ...i,
        priority: prio[`${f.sessionId}:${i.id}`] ?? i.priority,
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
