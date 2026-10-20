import { expect, test } from 'claude-code/testing'

import type { Item, SessionFile } from '../types'
import { inView, matches, parseScan, parseTitle, rank } from './board'

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

test('parseScan: markdown checkboxes and code markers, deduped', () => {
  const out = [
    'ROADMAP.md:12:- [ ] Ship onboarding P1',
    'docs/plans/x.md:4:- [ ] **Step 1: Failing test**',
    'NEXT-TASKS.md:8:- [ ] **Chris:** check the phone build',
    'NEXT-TASKS.md:9:- [ ] Chris-only: grant select on prod',
    'NEXT-TASKS.md:10:- [ ] ~~Chris: apply 0096~~ (done 16:30)',
    'ROADMAP.md:13:- [x] Done already',
    'NEXT-TASKS.md:3:  * [ ] [you] Renew Apple dev account',
    'src/api.ts:40:  // FIXME: retry on 429',
    'src/api.ts:41:  // TODO(chris): cache the token */',
    'src/ui.tsx:9:  {/* HACK - flicker workaround */}',
    'src/api.ts:90:  // FIXME: retry on 429',
    'README.md:5:mentions a TODO list but is no checkbox',
    'src/x.ts:1:const TODO_LIST = []',
    'src/y.tsx:2:  battle-strip row closes the b15 INTEGRATION TODO in prefs.ts. */}',
  ].join('\n')
  const items = parseScan(out, { me: ['XyndoX', 'chris'] })
  expect(items.map(i => [i.title, i.priority, i.isHuman, i.note])).toEqual([
    ['Ship onboarding', 1, false, 'ROADMAP.md:12'],
    ['check the phone build', 2, true, 'NEXT-TASKS.md:8'],
    ['grant select on prod', 2, true, 'NEXT-TASKS.md:9'],
    ['Renew Apple dev account', 2, true, 'NEXT-TASKS.md:3'],
    ['retry on 429', 1, false, 'src/api.ts:40'],
    ['cache the token', 2, false, 'src/api.ts:41'],
    ['flicker workaround', 2, false, 'src/ui.tsx:9'],
    ['Step 1: Failing test', 3, false, 'docs/plans/x.md:4'],
  ])
})

test('parseScan caps after ranking: roadmap, then code, then other docs', () => {
  const out = ['docs/a.md:1:- [ ] plan step one', 'docs/a.md:2:- [ ] plan step two', 'src/x.ts:3:// TODO fix it', 'ROADMAP.md:4:- [ ] ship it'].join('\n')
  expect(parseScan(out, { max: 2 }).map(i => i.title)).toEqual(['ship it', 'fix it'])
})

test('scan items: one row across sessions, done sticks by repo', () => {
  const s = { id: 'scan:md:a.md:x', title: 'x', status: 'pending' as const, priority: 2, isHuman: false, blockedBy: [], agent: 'repo' }
  const files: SessionFile[] = [
    { sessionId: 'a', cwd: '/p', updatedAt: 0, items: [s] },
    { sessionId: 'b', cwd: '/p', updatedAt: 0, items: [s] },
  ]
  expect(rank(files, '/p', new Set(['a', 'b']), new Set()).length).toBe(1)
  expect(rank(files, '/p', new Set(['a', 'b']), new Set(['scan:md:a.md:x'])).length).toBe(0)
})
