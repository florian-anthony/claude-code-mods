import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// A prompt typed at the prompt box during turn t1
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const }, turnId: 't1' })
const done = (turnId: string) => ({ turnId, answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' as const, usage: null })

// What Claude Code passes to the pane /queue opens, apart from the app
const PANE = {
  plugin: 'prompt-queue',
  component: 'Pane',
  requestId: 'prompt-queue',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Prompt queue', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

const BAND = {
  plugin: 'prompt-queue',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: true, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

// Lets the prompt the mod submits without waiting reach the stub
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('a prompt sent while Claude is idle goes through unchanged', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  const out = await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  expect(out).toEqual({ text: 'hello' })
})

test('prompts sent during a turn wait, then go one per finished turn', async ($, on) => {
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin') sent.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  await $.turn.start({ text: 'a long task', turnId: 't1' })
  expect(await $.prompt.submit(typed('second'))).toEqual({ drop: 'queued as #1, sent when Claude finishes' })
  expect(await $.prompt.submit(typed('third'))).toEqual({ drop: 'queued as #2, sent when Claude finishes' })
  expect(sent).toEqual([])

  await $.turn.complete(done('t1'))
  await settle()
  expect(sent).toEqual(['second'])

  await $.turn.start({ text: 'second', turnId: 't2' })
  await $.turn.complete(done('t2'))
  await settle()
  expect(sent).toEqual(['second', 'third'])
})

test('a subagent finishing does not send the next prompt', async ($, on) => {
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin') sent.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  await $.turn.start({ text: 'a long task', turnId: 't1' })
  await $.prompt.submit(typed('later'))
  await $.turn.complete({ ...done('sub'), agentId: 'agent-1' })
  await settle()
  expect(sent).toEqual([])
})

test('other senders and commands are not held', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))

  await $.turn.start({ text: 'a long task', turnId: 't1' })
  const peer = await $.prompt.submit({ text: 'from a peer', wait: false, origin: { kind: 'peer' }, turnId: 't1' })
  const command = await $.prompt.submit(typed('/compact'))
  expect(peer).toEqual({ text: 'from a peer' })
  expect(command).toEqual({ text: '/compact' })
})

test('an interrupted turn pauses the queue until /queue resume', async ($, on) => {
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin') sent.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  const logs: string[] = []
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  const clock = mock.clock(on)
  await $.turn.start({ text: 'a long task', turnId: 't1' })
  await $.prompt.submit(typed('next one'))
  await $.turn.complete({ ...done('t1'), isAborted: true, reason: 'aborted' })
  await settle()
  expect(sent).toEqual([])

  await $.command.run({ command: 'queue', args: 'resume' })
  await clock.settle()
  await settle()
  expect(logs).toEqual([])
  expect(sent).toEqual(['next one'])
})

test('the pane edits, moves and removes a waiting prompt', async ($, on) => {
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin') sent.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  await $.turn.start({ text: 'a long task', turnId: 't1' })
  await $.prompt.submit(typed('first'))
  await $.prompt.submit(typed('second'))

  const ui = await $.ui.mount(PANE)
  await ui.input({ key: 'edit-2', text: 'second, edited' })
  await ui.press({ key: 'up-2' })
  await ui.press({ key: 'remove-1' })
  await ui.unmount()

  await $.turn.complete(done('t1'))
  await settle()
  expect(sent).toEqual(['second, edited'])
})

// Closes the pane the way the person's Escape does, from a plugin loaded beside this one
const closer = {
  name: 'closer',
  register: (on: On) => {
    on('command.run', { command: 'close-queue' }, async ($) => {
      await $.ui.close({ id: 'prompt-queue' })
      return {}
    })
  },
}

test('nothing is sent while the pane is open, and closing it sends', { plugins: [closer] }, async ($, on) => {
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin') sent.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))

  const clock = mock.clock(on)
  await $.turn.start({ text: 'a long task', turnId: 't1' })
  await $.prompt.submit(typed('being edited'))
  await $.command.run({ command: 'queue', args: '' })
  // Claude finishes while the list is being edited
  await $.turn.complete(done('t1'))
  await clock.settle()
  await settle()
  expect(sent).toEqual([])

  await $.command.run({ command: 'close-queue' })
  await clock.settle()
  await settle()
  expect(sent).toEqual(['being edited'])
})

test('the band shows what waits and keeps what other mods draw', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by another mod'] }))

  await $.turn.start({ text: 'a long task', turnId: 't1' })
  await $.prompt.submit(typed('write the tests'))
  await $.prompt.submit(typed('then the README'))

  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /2 prompts waiting/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'then the README' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'drawn by another mod' })).toBeDefined()
})
