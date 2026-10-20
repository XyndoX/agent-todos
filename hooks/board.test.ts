import { expect, test } from 'claude-code/testing'

import type { Item, SessionFile } from '../types'
import { inView, matches, parseTitle, rank } from './board'

const item = (id: string, over: Partial<Item> = {}): Item =>
  ({ id, title: id, status: 'pending', priority: 2, isHuman: false, blockedBy: [], agent: 'main', ...over })

test('parseTitle reads human marker and priority', () => {
  expect(parseTitle('[you] P0 rotate the key')).toEqual({ title: 'rotate the key', priority: 0, isHuman: true })
  expect(parseTitle('write tests')).toEqual({ title: 'write tests', priority: 2, isHuman: false })
})

test('rank: yours first, blocked last, priority, relevance, dead sessions', () => {
  const files: SessionFile[] = [
    { sessionId: 'a', cwd: '/p', updatedAt: 0, items: [
      item('low', { priority: 3 }),
      item('blocked', { priority: 0, blockedBy: ['urgent'] }),
      item('urgent', { priority: 0 }),
      item('mine', { priority: 3, isHuman: true }),
      item('finished', { status: 'completed' }),
    ] },
    { sessionId: 'dead', cwd: '/p/sub', updatedAt: 0, items: [item('gone'), item('still-yours', { isHuman: true })] },
    { sessionId: 'other', cwd: '/elsewhere', updatedAt: 0, items: [item('nope')] },
  ]
  const rows = rank(files, '/p', new Set(['a', 'other']), new Set())
  expect(rows.map(r => r.id)).toEqual(['still-yours', 'mine', 'urgent', 'low', 'blocked'])
  expect(rows.find(r => r.id === 'urgent')?.blocks).toBe(1)
  expect(rank(files, '/p', new Set(['a']), new Set(['a:mine'])).some(r => r.id === 'mine')).toBe(false)
})

test('matches: all terms, case-insensitive, tags', () => {
  const r = rank([{ sessionId: 's', cwd: '/p', updatedAt: 0, items: [item('x', { title: 'Deploy API', isHuman: true, priority: 1 })] }], '/p', new Set(['s']), new Set())[0]!
  expect(matches(r, 'deploy p1 you')).toBe(true)
  expect(matches(r, 'deploy p0')).toBe(false)
  expect(matches(r, '')).toBe(true)
})

test('priority override re-sorts and perspectives filter', () => {
  const files: SessionFile[] = [{ sessionId: 's', cwd: '/p', updatedAt: 0, items: [item('a', { priority: 0 }), item('b', { priority: 3 })] }]
  const rows = rank(files, '/p', new Set(['s']), new Set(), { 's:b': 0, 's:a': 2 })
  expect(rows.map(r => [r.id, r.priority])).toEqual([['b', 0], ['a', 2]])
  expect(rows.filter(r => inView(r, 'urgent')).map(r => r.id)).toEqual(['b'])
  expect(rows.filter(r => inView(r, 'you')).length).toBe(0)
})
