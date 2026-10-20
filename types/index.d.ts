export type Status = 'pending' | 'in_progress' | 'completed'

export type Item = {
  id: string
  title: string
  status: Status
  /** 0 (urgent) … 3 (someday); 2 when unset */
  priority: number
  /** only the human can complete it */
  isHuman: boolean
  blockedBy: string[]
  /** 'main' or the subagent's id */
  agent: string
  note?: string
}

/** ~/.claude/agent-todos/<sessionId>.json — each session writes only its own */
export type SessionFile = { sessionId: string; cwd: string; updatedAt: number; items: Item[] }

export type Row = Item & {
  sessionId: string
  cwd: string
  isLive: boolean
  isBlocked: boolean
  /** open items in the same session waiting on this one */
  blocks: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-todos': { rows: Row[]; query: string; root: string; view: string; selected: string }
  }
}
