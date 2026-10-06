// prompt-queue: holds the prompts you send while Claude works, then sends
// them one at a time, each after Claude has finished the turn before it.
//
// On its own, Claude Code hands a prompt typed mid-turn to the running turn:
// Claude reads it between two tool calls and may leave its task unfinished.

import type { Engine, On } from 'claude-code'

type Item = { id: number; text: string }

const PANE = 'prompt-queue'
// Wide enough to read a prompt in the pane docked beside the transcript
const PANE_COLUMNS = 60
// The band lists this many prompts, then sums up the rest
const BAND_ROWS = 3
// How a line break shows in a one-line field, and turns back on save
const BREAK = ' ⏎ '

let queue: Item[] = []
let nextId = 1
// True from a main-loop turn.start to its turn.complete
let isWorking = false
// Why the queue holds its prompts back, or null while it sends them
let pauseReason: string | null = null
// True while the /queue pane is open: a prompt sent then would leave the
// list under the edit in progress, so nothing goes until the pane closes
let isEditing = false

function redraw($: Engine) {
  $.ui.invalidate('ui.render')
}

function add($: Engine, text: string) {
  queue = [...queue, { id: nextId++, text }]
  redraw($)
}

// Submits the first prompt as if typed, unless a turn runs or the queue is paused
function sendNext($: Engine) {
  if (isWorking || isEditing || pauseReason || queue.length === 0) return
  const [first, ...rest] = queue
  queue = rest
  // turn.start sets this too; setting it now keeps a second call from
  // sending another prompt before that turn has started
  isWorking = true
  redraw($)
  // Resolves only once the turn starts, so no hook waits on it
  $.prompt.submit({ text: first.text, asUser: true }).catch((error: unknown) => {
    queue = [first, ...queue]
    isWorking = false
    pauseReason = 'the last prompt could not be sent'
    $.ui.log('prompt-queue could not send a prompt: ' + String(error))
    redraw($)
  })
}

// A command, a press or a field holds the turn slot that submitting waits on,
// so they send from a timer instead, once their own event has finished
function sendSoon($: Engine) {
  $.clock.after(0, () => sendNext($))
}

const oneLine = (text: string) => text.replace(/\r?\n/g, BREAK)

function title() {
  if (queue.length === 0) return pauseReason ? 'Queue paused: ' + pauseReason : 'No prompts waiting'
  const count = queue.length === 1 ? '1 prompt waiting' : queue.length + ' prompts waiting'
  return pauseReason ? 'Queue paused: ' + pauseReason + ' · ' + count : 'Queue · ' + count
}

function hint() {
  if (pauseReason) return '/queue resume sends again'
  return isEditing ? 'held while the /queue pane is open' : 'sent one at a time when Claude finishes · /queue to edit'
}

function paneHint() {
  return pauseReason ? 'Held until you press p or run /queue resume' : 'Nothing is sent while this pane is open'
}

const accent = () => (pauseReason ? 'warning' : 'suggestion')

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'queue',
        description: 'Show and edit the prompts waiting for Claude to finish',
        argumentHint: '[prompt | pause | resume | clear]',
        immediate: true,
      })
    } catch (error) {
      $.ui.log('prompt-queue could not add /queue: ' + String(error))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isWorking = true
    redraw($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent's turn ends inside the main one, which keeps running
    if (e.agentId) return next(e)
    isWorking = false
    // After an interruption or an error, sending on would surprise you
    if (e.reason !== 'answer' && queue.length > 0) {
      pauseReason = e.isAborted ? 'you interrupted Claude' : 'the last turn ended with ' + (e.reason === 'refusal' ? 'a refusal' : 'an error')
    }
    sendNext($)
    redraw($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Only what you send during a turn waits, from the prompt box or from your
    // phone through Remote Control; notifications and other senders go through
    const isYours = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!e.turnId || !isYours) return next(e)
    const text = e.text.trim()
    // A command acts at once, and pasted images would be lost on the way
    if (!text || text.startsWith('/') || (e.attachments?.length ?? 0) > 0) return next(e)
    add($, e.text)
    return { drop: 'queued as #' + queue.length + ', sent when Claude finishes' }
  }).catch(async ($, e, next) => {
    // If the queue fails, the prompt reaches Claude the usual way rather than vanish
    return next(e)
  })

  on('command.run', { command: 'queue' }, async ($, e) => {
    const args = e.args.trim()
    const word = args.toLowerCase()
    if (word === '') {
      await $.ui.open({
        id: PANE,
        title: 'Prompt queue',
        focus: true,
        closeOnEscape: true,
        rows: Math.min(9 + Math.max(queue.length, 1), 20),
        columns: PANE_COLUMNS,
      })
      isEditing = true
      redraw($)
    } else if (word === 'pause') {
      pauseReason = 'you paused it'
      redraw($)
    } else if (word === 'resume') {
      pauseReason = null
      sendSoon($)
      redraw($)
    } else if (word === 'clear') {
      queue = []
      pauseReason = null
      redraw($)
    } else {
      // /queue followed by a prompt adds it, and sends it now if Claude is idle
      add($, args)
      sendSoon($)
    }
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      isEditing = false
      sendSoon($)
      redraw($)
    }
    return next(e)
  })

  // The band above the prompt: what waits, while something waits
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (queue.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const rows = queue.slice(0, BAND_ROWS).map((item, i) =>
      Box({
        key: 'band-' + item.id,
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Text({ bold: true, color: accent(), children: [String(i + 1)] }),
          Text({ wrap: 'truncate-end', children: [oneLine(item.text)] }),
        ],
      }),
    )
    const more = queue.length - BAND_ROWS
    const ours = Box({
      borderStyle: 'round',
      borderColor: accent(),
      paddingX: 1,
      flexDirection: 'column',
      children: [
        // One line, cut at the edge rather than wrapped in a narrow window
        Box({
          flexDirection: 'row',
          children: [
            Text({ bold: true, color: accent(), wrap: 'truncate-end', children: [title()] }),
            Text({ color: 'subtle', wrap: 'truncate-end', children: [' · ' + hint()] }),
          ],
        }),
        ...rows,
        ...(more > 0 ? [Text({ color: 'subtle', children: ['+' + more + ' more in /queue'] })] : []),
      ],
    })
    // Keep what the mods after this one draw in the band
    const theirs = await next(e)
    return theirs ? Box({ flexDirection: 'column', children: [ours, theirs] }) : ours
  })

  // The pane /queue opens: every waiting prompt, editable in place
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const controls = Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Button({
          key: 'toggle',
          label: pauseReason ? 'Resume' : 'Pause',
          hotkey: 'p',
          plain: true,
          onPress: async () => {
            pauseReason = pauseReason ? null : 'you paused it'
            sendSoon($)
            redraw($)
          },
        }),
        Button({
          key: 'clear',
          label: 'Clear',
          hotkey: 'c',
          plain: true,
          onPress: async () => {
            queue = []
            redraw($)
          },
        }),
      ],
    })
    const rows = queue.map((item, i) =>
      Box({
        key: 'row-' + item.id,
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Text({ bold: true, color: accent(), children: [String(i + 1)] }),
          Box({
            flexGrow: 1,
            children: [
              Input({
                key: 'edit-' + item.id,
                value: oneLine(item.text),
                // Only the return symbol, so a long prompt keeps its width
                submitLabel: '',
                // An emptied field removes the prompt
                onSubmit: async (value: string) => {
                  const text = value.split(BREAK).join('\n').trim()
                  queue = text ? queue.map((it) => (it.id === item.id ? { ...it, text } : it)) : queue.filter((it) => it.id !== item.id)
                  redraw($)
                },
              }),
            ],
          }),
          // The first prompt cannot move up: a blank keeps the columns aligned
          i === 0
            ? Text({ children: [' '] })
            : Button({
                key: 'up-' + item.id,
                label: '↑',
                plain: true,
                onPress: async () => {
                  const at = queue.findIndex((it) => it.id === item.id)
                  if (at > 0) {
                    const moved = [...queue]
                    ;[moved[at - 1], moved[at]] = [moved[at], moved[at - 1]]
                    queue = moved
                  }
                  redraw($)
                },
              }),
          Button({
            key: 'remove-' + item.id,
            label: '✕',
            plain: true,
            onPress: async () => {
              queue = queue.filter((it) => it.id !== item.id)
              redraw($)
            },
          }),
        ],
      }),
    )
    return Box({
      flexDirection: 'column',
      rowGap: 1,
      children: [
        Box({
          flexDirection: 'column',
          children: [Text({ bold: true, color: accent(), children: [title()] }), Text({ color: 'subtle', children: [paneHint()] })],
        }),
        controls,
        ...(rows.length > 0 ? [Box({ flexDirection: 'column', children: rows })] : [Text({ color: 'subtle', children: ['Nothing waiting. What you send while Claude works will wait here.'] })]),
        Input({
          key: 'add',
          label: 'Add',
          placeholder: 'Type a prompt and press Enter',
          value: '',
          submitLabel: 'add',
          autoFocus: true,
          onSubmit: async (value: string) => {
            if (!value.trim()) return
            add($, value.split(BREAK).join('\n').trim())
            sendSoon($)
          },
        }),
        Text({ color: 'subtle', children: ['↑ ↓ or Tab to move · Enter saves · Esc closes'] }),
      ],
    })
  })
}
