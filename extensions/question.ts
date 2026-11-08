/**
 * Question Tool - 1-4 questions with options, single- or multi-select.
 * On the TUI the questions share one form: an inline "Type something." text row, a
 * "Chat about this" row and, for several questions, tabs and a final review. Escape
 * on a non-empty text row stops typing and keeps the draft; Escape anywhere else
 * cancels. Claude's Escape wipes the draft (anthropics/claude-code#10621), which is
 * not mirrored. Each question is also offered to a remote responder over pi.events
 * (REMOTE_QUESTION_CHANNEL); the first answer, local or remote, wins.
 */

import { randomUUID } from 'node:crypto'
import * as os from 'node:os'
import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { Input, Key, matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import { readManagedSettings } from './internal/managed-settings.ts'
import { readUserSetting } from './internal/settings-chain.ts'

interface OptionWithDesc {
  label: string
  description?: string
}

interface QuestionDetails {
  question: string
  header?: string
  options: string[]
  answer: string | null
  wasCustom?: boolean
  skipped?: boolean
  questions?: QuestionDetails[]
  multiSelect?: boolean
  /** Auto-continued on askUserQuestionTimeout rather than answered or cancelled. */
  timedOut?: boolean
  /** The user chose "Chat about this" to clarify the questions. */
  chat?: boolean
}

type QuestionResult = { content: Array<{ type: 'text'; text: string }>; details: QuestionDetails }

// Options with labels and optional descriptions
const OptionSchema = Type.Object({
  label: Type.String({ description: 'Display label for the option' }),
  description: Type.Optional(Type.String({ description: 'Optional description shown below label' })),
})

const SingleQuestion = Type.Object({
  question: Type.String({ description: 'The question to ask the user' }),
  header: Type.Optional(Type.String({ description: 'Short label for the question, shown above it, kept to 12 characters' })),
  options: Type.Array(OptionSchema, { description: 'Options for the user to choose from (2-4)', minItems: 2, maxItems: 4 }),
  multiSelect: Type.Optional(Type.Boolean({ description: 'Allow selecting several options (space toggles, enter confirms)' })),
})

/** One question in the flat form, plus an optional batch for Claude's 1-4 questions.
 * The flat fields stay the documented path: a schema offering two equally optional
 * shapes gave smaller models nothing to follow, and they produced neither. */
export const QuestionParams = Type.Object({
  question: Type.Optional(Type.String({ description: 'The question to ask. Required, unless asking several via questions.' })),
  options: Type.Optional(Type.Array(OptionSchema, { description: 'The 2-4 choices for this question, each {label, description?}. Required with question.', minItems: 2, maxItems: 4 })),
  header: Type.Optional(Type.String({ description: 'Optional short label shown above the question, kept to 12 characters' })),
  multiSelect: Type.Optional(Type.Boolean({ description: 'Optional: allow selecting several options (space toggles, enter confirms)' })),
  questions: Type.Optional(Type.Array(SingleQuestion, { description: 'Only to ask 2-4 questions in one call: each entry takes the same fields as above. Leave unset for a single question.', minItems: 1, maxItems: 4 })),
})

export interface QuestionSpec {
  question: string
  header?: string
  options: OptionWithDesc[]
  multiSelect?: boolean
}

/** In-process, question-owned offer; arbitrary custom TUI components are not sent. */
export const REMOTE_QUESTION_CHANNEL = 'pi-code:question:v1'
export type RemoteQuestionOutcome = { action: 'answer'; indices: number[] } | { action: 'text'; text: string } | { action: 'cancel' } | { action: 'pass' }

export interface RemoteQuestionOffer {
  version: 1
  requestId: string
  sessionId: string
  question: string
  header?: string
  options: OptionWithDesc[]
  multiSelect: boolean
  allowFreeText: boolean
  signal: AbortSignal
  /** Must be called during event emission; only one listener receives a settle handle. */
  claim: () => ((outcome: RemoteQuestionOutcome) => boolean) | undefined
  /** The claimed responder reports input activity to reset a configured idle timer. */
  touch: () => boolean
}

/** Normalize either accepted shape into the list of questions to ask, headers shortened. */
function questionList(params: Partial<QuestionSpec> & { questions?: QuestionSpec[] }): QuestionSpec[] {
  if (params.questions && params.questions.length > 0) return params.questions.map((spec) => ({ ...spec, header: shortHeader(spec.header) }))
  if (typeof params.question === 'string') return [{ question: params.question, header: shortHeader(params.header), options: params.options ?? [], multiSelect: params.multiSelect }]
  return []
}

/** Claude keeps a header short for the label slot. Truncating is the forgiving read:
 * rejecting the call costs a turn while the model recovers from a validation error,
 * which is a poor trade for a display detail. */
const HEADER_MAX = 12
export const shortHeader = (header: string | undefined): string | undefined => (header === undefined ? undefined : header.slice(0, HEADER_MAX))

/** Claude's three accepted askUserQuestionTimeout spellings (`60s`, `5m`, `10m`), as
 * milliseconds. Anything else, including unset, means no auto-continue. */
export function parseAskUserQuestionTimeout(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d+)([sm])$/.exec(value.trim())
  if (!match) return undefined
  const amount = Number(match[1])
  return match[2] === 's' ? amount * 1000 : amount * 60 * 1000
}

/** Claude scopes askUserQuestionTimeout to "User or managed": a project's own
 * settings.json cannot set it, so a checked-out repository can never make the
 * user's own dialogs auto-answer themselves. Managed wins over the user's file, as
 * every managed setting does. `home` defaults to the real one and is a parameter
 * only so a test can point it at a fixture without mocking node:os. */
export function askUserQuestionTimeoutMs(home: string = os.homedir()): number | undefined {
  const managed = readManagedSettings() as { askUserQuestionTimeout?: unknown }
  const fromManaged = parseAskUserQuestionTimeout(managed.askUserQuestionTimeout)
  if (fromManaged !== undefined) return fromManaged
  return parseAskUserQuestionTimeout(readUserSetting(home, 'askUserQuestionTimeout'))
}

function checkbox(checked: boolean): string {
  return checked ? '[x] ' : '[ ] '
}

/** `field` is a pre-rendered text field appended after the label. */
function optionLine(label: string, index: number, selected: boolean, theme: Theme, field = ''): string {
  return (selected ? theme.fg('accent', '❯ ') : '  ') + theme.fg(selected ? 'accent' : 'text', `${index + 1}. ${label}`) + field
}

type DisplayOption = OptionWithDesc & { field?: string }

interface QuestionView {
  width: number
  question: string
  header?: string
  /** The options, then the free-text row, then "Chat about this". */
  options: DisplayOption[]
  optionIndex: number
  multiSelect: boolean
  checked: boolean[]
  theme: Theme
}

/** The top border, question and rows; the caller adds the tab bar and footer. */
function buildQuestionLines(view: QuestionView): string[] {
  const { width, question, header, options, optionIndex, multiSelect, checked, theme } = view
  const lines: string[] = []
  const add = (s: string) => lines.push(truncateToWidth(s, width))

  add(theme.fg('accent', '─'.repeat(width)))
  if (header) add(theme.fg('muted', ` [${header}]`))
  add(theme.fg('text', ` ${question}`))
  lines.push('')

  for (let i = 0; i < options.length; i++) {
    const opt = options[i]
    const chat = i === options.length - 1
    if (chat) add(theme.fg('dim', '─'.repeat(width)))
    add(optionLine((multiSelect && !chat ? checkbox(checked[i]) : '') + opt.label, i, i === optionIndex, theme, opt.field))
    if (opt.description) {
      add(`     ${theme.fg('muted', opt.description)}`)
    }
  }
  return lines
}

function navHint(editMode: boolean, multiSelect: boolean, tabs: boolean): string {
  if (editMode) return ' Enter to submit · Esc to stop typing'
  if (tabs) return ` ${multiSelect ? 'Space to toggle · Enter to confirm' : 'Enter to select'} · Tab/Arrow keys to navigate · Esc to cancel`
  return multiSelect ? ' Space to toggle · Enter to confirm · Esc to cancel' : ' Enter to select · ↑/↓ to navigate · Esc to cancel'
}

function selectedLabels(options: OptionWithDesc[], checked: boolean[]): string {
  return options
    .filter((_, i) => checked[i])
    .map((o) => o.label)
    .join(', ')
}

/** The result line for a question that was not cancelled. */
function renderAnswered(details: QuestionDetails, answer: string, theme: Theme): string {
  if (details.skipped) return theme.fg('warning', 'User skipped this question')
  if (details.timedOut) {
    const already = answer ? theme.fg('muted', ` (already selected: ${answer})`) : ''
    return theme.fg('warning', '⏱ Auto-continued (no response)') + already
  }

  if (details.wasCustom) {
    return theme.fg('success', '✓ ') + theme.fg('muted', '(wrote) ') + theme.fg('accent', answer)
  }
  if (details.multiSelect) {
    return theme.fg('success', '✓ ') + theme.fg('accent', answer || '(none)')
  }
  const idx = details.options.indexOf(answer) + 1
  const display = idx > 0 ? `${idx}. ${answer}` : answer
  return theme.fg('success', '✓ ') + theme.fg('accent', display)
}

/** Arguments stream in partially, so any field may still be missing. */
function renderOptions(args: Partial<QuestionSpec>, theme: Theme): string {
  const multi = args.multiSelect === true
  const opts = Array.isArray(args.options) ? args.options : []
  if (!opts.length) return ''
  const labels = opts.map((o: OptionWithDesc) => o.label)
  const shown = multi ? labels : [...labels, 'Type something.']
  const numbered = shown.map((o, i) => `${i + 1}. ${o}`)
  return `\n${theme.fg('dim', `  Options${multi ? ' (multi)' : ''}: ${numbered.join(', ')}`)}`
}

function renderBatchCall(specs: Array<Partial<QuestionSpec> | null>, theme: Theme): Text {
  const lines = specs.map((entry, index) => {
    const spec = entry ?? {}
    const heading = shortHeader(spec.header) ?? `Q${index + 1}`
    return theme.fg('toolTitle', theme.bold(`question [${heading}] `)) + String(spec.question ?? '') + renderOptions(spec, theme)
  })
  return new Text(lines.join('\n\n'), 0, 0)
}

function renderSingleCall(args: Partial<QuestionSpec>, theme: Theme): Text {
  const heading = args.header ? `[${shortHeader(String(args.header))}] ` : ''
  const text = theme.fg('toolTitle', theme.bold('question ')) + theme.fg('muted', heading + String(args.question ?? ''))
  return new Text(text + renderOptions(args, theme), 0, 0)
}

export default function question(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'question',
    label: 'Question',
    description:
      'Ask the user a question and let them pick from options. Use when you need user input to proceed. Pass question and options, for example {"question": "Which one?", "options": [{"label": "alpha"}, {"label": "beta"}]}. To ask 2-4 questions at once, pass questions instead, with the same fields per entry.',
    parameters: QuestionParams,
    // The host shows a custom dialog in one editor slot, so two questions running in
    // parallel leave the first unanswerable and the run unable to finish.
    executionMode: 'sequential',

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const specs = questionList(rawParams as Partial<QuestionSpec> & { questions?: QuestionSpec[] })
      if (specs.length === 0) {
        return { content: [{ type: 'text', text: 'Error: No question provided' }], details: { question: '', options: [], answer: null } as QuestionDetails }
      }
      if (ctx.hasUI && ctx.mode === 'tui' && specs.every((spec) => spec.options.length > 0)) {
        return overlayResult(specs, await askViaOverlay(specs, ctx, askUserQuestionTimeoutMs(), pi.events, signal))
      }

      const results: QuestionResult[] = []
      for (const spec of specs) {
        const result = await askOne(spec, ctx, pi.events, signal)
        results.push(result)
        if (result.details.answer === null) {
          // Only the user's cancel declines the call; an error (no UI, no options) keeps its own text.
          if (ctx.hasUI && spec.options.length > 0) return cancelled(specs)
          break
        }
      }
      return combine(specs, results)
    },

    renderCall(args, theme, _context) {
      if (Array.isArray(args.questions) && args.questions.length > 0) {
        return renderBatchCall(args.questions, theme)
      }
      return renderSingleCall(args, theme)
    },
    renderResult(result, _options, theme, _context) {
      const details = result.details as QuestionDetails | undefined
      if (!details) {
        const text = result.content[0]
        return new Text(text?.type === 'text' ? text.text : '', 0, 0)
      }

      if (details.chat) return new Text(theme.fg('warning', 'User wants to clarify these questions'), 0, 0)

      if (details.questions && details.answer !== null) {
        return new Text(
          details.questions
            .map((detail) => {
              const rendered = detail.answer === null ? theme.fg('warning', 'Cancelled') : renderAnswered(detail, detail.answer, theme)
              return `${detail.header ? `[${detail.header}] ` : ''}${detail.question}\n${rendered}`
            })
            .join('\n\n'),
          0,
          0,
        )
      }

      if (details.answer === null) {
        return new Text(theme.fg('warning', 'Cancelled'), 0, 0)
      }

      return new Text(renderAnswered(details, details.answer, theme), 0, 0)
    },
  })
}

type QuestionAnswer = OverlayAnswer | null

/** A claimed offer raced against the open overlay: whichever answers first wins. */
interface RemoteQuestion {
  /** Routes remote answers into the overlay and remote activity into its idle timer. */
  attach: (answer: (value: QuestionAnswer) => void, touch: () => void) => void
  /** Ends the offer; the responder's settle handle and touch are rejected from then on. */
  close: () => void
}
type RemoteOffer = { kind: 'settled'; value: QuestionAnswer } | { kind: 'claimed'; remote: RemoteQuestion }

function validIndices(indices: unknown, count: number, multiSelect: boolean): indices is number[] {
  if (!Array.isArray(indices) || (!multiSelect && indices.length !== 1)) return false
  return new Set(indices).size === indices.length && indices.every((index) => Number.isInteger(index) && index >= 1 && index <= count)
}

/** A remote outcome as the answer it stands for: null is a cancel, undefined is a
 * pass or anything this question cannot accept, which must never become an answer. */
function remoteAnswer(outcome: RemoteQuestionOutcome, options: OptionWithDesc[], multiSelect: boolean): QuestionAnswer | undefined {
  if (outcome === null || typeof outcome !== 'object') return undefined
  if (outcome.action === 'cancel') return null
  if (outcome.action === 'text') {
    const text = typeof outcome.text === 'string' ? outcome.text.trim() : ''
    return !multiSelect && text ? { answer: text, wasCustom: true } : undefined
  }
  if (outcome.action !== 'answer') return undefined
  // Read once and copied, so a getter or Proxy cannot answer with other indices
  // than the ones that passed validation.
  const raw: unknown = outcome.indices
  const indices: unknown = Array.isArray(raw) ? [...raw] : undefined
  if (!validIndices(indices, options.length, multiSelect)) return undefined
  const checked = options.map((_, index) => indices.includes(index + 1))
  return { answer: selectedLabels(options, checked), wasCustom: false, ...(multiSelect ? { checked } : { index: indices[0] }) }
}

/** Undefined when nobody claims synchronously, so the overlay opens with no async gap. */
function offerRemoteQuestion(params: QuestionSpec, ctx: ExtensionContext, events: ExtensionAPI['events'] | undefined, signal: AbortSignal | undefined): RemoteOffer | undefined {
  if (!events) return undefined
  if (signal?.aborted) return { kind: 'settled', value: null }

  const multiSelect = params.multiSelect === true
  const controller = new AbortController()
  let claimed = false
  let early: { value: QuestionAnswer } | undefined
  let deliver: ((value: QuestionAnswer) => void) | undefined
  let touchOverlay: (() => void) | undefined
  const close = (): void => controller.abort()
  const settle = (value: QuestionAnswer): void => {
    close()
    if (deliver) deliver(value)
    else early = { value }
  }
  // Pi aborts the turn before a session replacement invalidates ctx, so this is
  // also the session-replacement path; ctx is never read after emission.
  const abort = (): void => settle(null)
  signal?.addEventListener('abort', abort, { once: true })

  const offer: RemoteQuestionOffer = {
    version: 1,
    requestId: randomUUID(),
    sessionId: ctx.sessionManager.getSessionId(),
    question: params.question,
    header: params.header,
    options: params.options.map(({ label, description }) => ({ label, ...(description === undefined ? {} : { description }) })),
    multiSelect,
    allowFreeText: !multiSelect,
    signal: controller.signal,
    claim: () => {
      if (claimed || controller.signal.aborted) return undefined
      claimed = true
      return (outcome) => {
        if (controller.signal.aborted) return false
        const value = remoteAnswer(outcome, params.options, multiSelect)
        if (value !== undefined) {
          settle(value)
          return true
        }
        // A pass or invalid reply only withdraws the remote side; the overlay stays
        // open, and a turn abort must still cancel it.
        controller.abort()
        return outcome?.action === 'pass'
      }
    },
    touch: () => {
      if (!claimed || controller.signal.aborted) return false
      touchOverlay?.()
      return true
    },
  }

  events.emit(REMOTE_QUESTION_CHANNEL, offer)
  // From here on the overlay's own abort listener cancels the question.
  signal?.removeEventListener('abort', abort)
  if (early) return { kind: 'settled', value: early.value }
  if (!claimed || controller.signal.aborted) {
    close()
    return undefined
  }
  return {
    kind: 'claimed',
    remote: {
      attach: (answer, touch) => {
        deliver = answer
        touchOverlay = touch
      },
      close,
    },
  }
}

async function askOne(spec: QuestionSpec, ctx: ExtensionContext, events: ExtensionAPI['events'] | undefined, signal: AbortSignal | undefined): Promise<QuestionResult> {
  if (!ctx.hasUI) {
    return {
      content: [{ type: 'text', text: 'Error: UI not available (running in non-interactive mode)' }],
      details: { question: spec.question, options: spec.options.map((o) => o.label), answer: null },
    }
  }
  if (spec.options.length === 0) {
    return { content: [{ type: 'text', text: 'Error: No options provided' }], details: { question: spec.question, options: [], answer: null } }
  }
  // ui.custom() is terminal-only: in RPC mode it resolves undefined without asking.
  // askUserQuestionTimeout needs a keyboard and a visible countdown, so dialogs do not apply it.
  if (ctx.mode === 'tui') return overlayResult([spec], await askViaOverlay([spec], ctx, askUserQuestionTimeoutMs(), events, signal))
  return answerToResult(spec, await askViaDialogs(spec, ctx))
}

/** A lone question's own result, or several joined under their questions. */
function combine(specs: QuestionSpec[], results: QuestionResult[], text = results.map((result, index) => `${specs[index].question}\n${result.content[0].text}`).join('\n\n')): QuestionResult {
  if (specs.length === 1) return results[0]
  const collected = results.map((result) => result.details)
  return { content: [{ type: 'text', text }], details: { ...collected[0], questions: collected } }
}

/** As in Claude, a cancel declines the whole call and discards answers already given. */
function cancelled(specs: QuestionSpec[]): QuestionResult {
  return combine(
    specs,
    specs.map((spec) => answerToResult(spec, null)),
    'User cancelled the selection',
  )
}

function overlayResult(specs: QuestionSpec[], answers: BatchAnswers | null): QuestionResult {
  if (answers === null) return cancelled(specs)
  if (answers.chat) return chatResult(specs, answers)
  const lone = specs.length === 1
  const results = specs.map((spec, index) => answerToResult(spec, answers[index], lone || !answers.timedOut))
  const result = combine(specs, results)
  if (lone || !answers.timedOut) return result
  // Claude tells the model the user may be away on every timeout, even a fully answered one.
  return { ...result, content: [{ type: 'text', text: `${result.content[0].text}\n\n${AWAY_NOTICE} ${PROCEED_NOTICE}` }] }
}

/** Claude Code's text for "Chat about this", followed by each question and its confirmed answer. */
function chatResult(specs: QuestionSpec[], answers: BatchAnswers): QuestionResult {
  const asked = specs.map((spec, index) => `- "${spec.question}"\n  ${answers[index] ? `Answer: ${answerText(answers[index])}` : '(No answer provided)'}`)
  const text = `The user wants to clarify these questions.
    This means they may have additional information, context or questions for you.
    Take their response into account and then reformulate the questions if appropriate.
    Start by asking them what they would like to clarify.
    Questions asked:
${asked.join('\n')}`
  const collected = specs.map((spec, index) => answerToResult(spec, answers[index]).details)
  return { content: [{ type: 'text', text }], details: { ...collected[0], ...(specs.length > 1 ? { questions: collected } : {}), chat: true } }
}

function answerText(answer: OverlayAnswer): string {
  return [answer.answer, answer.written].filter(Boolean).join(', ')
}

const AWAY_NOTICE = 'No response after the configured idle timeout; the user may be away from the keyboard.'
const PROCEED_NOTICE = 'Proceed on your own judgment; you can ask again later if needed.'

/** `awayNotice` false leaves the timeout notice to the caller, which sends it once per call. */
function answerToResult(params: QuestionSpec, result: QuestionAnswer | undefined, awayNotice = true): QuestionResult {
  const multiSelect = params.multiSelect === true
  const simpleOptions = params.options.map((o) => o.label)
  const base = { question: params.question, options: simpleOptions, ...(params.header ? { header: params.header } : {}), ...(multiSelect ? { multiSelect: true } : {}) }

  if (result === undefined) {
    return { content: [{ type: 'text', text: 'User skipped this question' }], details: { ...base, answer: '', skipped: true } }
  }

  if (result === null) {
    return { content: [{ type: 'text', text: 'User cancelled the selection' }], details: { ...base, answer: null } }
  }

  if (result.timedOut) {
    // Claude: "tells Claude you may be away from your keyboard, so Claude proceeds
    // on its own judgment and can re-ask later." Not framed as a cancel: `answer` is
    // '' rather than null, so renderResult and a batch's own null-check both read it
    // as "answered nothing, but not declined" rather than the user having said no.
    const already = answerText(result) ? ` Already selected: ${answerText(result)}.` : ''
    return {
      content: [{ type: 'text', text: awayNotice ? `${AWAY_NOTICE}${already} ${PROCEED_NOTICE}` : `No response.${already}` }],
      details: { ...base, answer: answerText(result), timedOut: true },
    }
  }

  if (result.wasCustom) {
    return { content: [{ type: 'text', text: `User wrote: ${result.answer}` }], details: { ...base, answer: result.answer, wasCustom: true } }
  }
  const selected = result.answer || !result.written ? [`User selected: ${multiSelect ? result.answer || '(none)' : `${result.index}. ${result.answer}`}`] : []
  const selectionText = [...selected, ...(result.written ? [`User wrote: ${result.written}`] : [])].join('\n')
  return { content: [{ type: 'text', text: selectionText }], details: { ...base, answer: answerText(result), wasCustom: false } }
}

/** Claude: "You see a countdown for the last 20 seconds." */
const COUNTDOWN_WINDOW_MS = 20_000
/** Granularity of the idle-timer tick: fine enough that the countdown's displayed
 * second changes on time, coarse enough not to re-render needlessly often. */
const IDLE_TICK_MS = 250

/** `written` is the free-text row typed alongside a multiSelect question's checked labels in `answer`. */
type OverlayAnswer = { answer: string; written?: string; wasCustom: boolean; index?: number; timedOut?: boolean; checked?: boolean[] }
type BatchAnswers = Array<OverlayAnswer | undefined> & { timedOut?: boolean; chat?: boolean }

/** Terminal path: the form for one or several questions. Each row is an option, then
 * the free-text row, then "Chat about this"; several questions add tabs and a review.
 *
 * `timeoutMs`, when set, is Claude's askUserQuestionTimeout: "After a question sits
 * that long with no input, the dialog closes on its own: it submits any options
 * you'd already selected and tells Claude you may be away from your keyboard, so
 * Claude proceeds on its own judgment and can re-ask later. You see a countdown for
 * the last 20 seconds. Press any key to restart the timer." Terminal focus-in
 * restarting the timer, the other documented reset trigger, is not implemented:
 * pi's TUI input stream is not confirmed to carry the terminal's own focus-report
 * escape sequences, and guessing at that risks misreading ordinary input as a
 * focus event on a terminal that reports it differently.
 */
export async function askViaOverlay(specs: QuestionSpec[], ctx: ExtensionContext, timeoutMs?: number, events?: ExtensionAPI['events'], signal?: AbortSignal): Promise<BatchAnswers | null> {
  const saved: BatchAnswers = specs.map(() => undefined)
  let active = 0
  let initialRemote: RemoteQuestion | undefined
  // Questions answered remotely during emission need no terminal.
  for (; active < specs.length; active++) {
    if (signal?.aborted) return null
    const offer = offerRemoteQuestion(specs[active], ctx, events, signal)
    if (offer?.kind !== 'settled') {
      initialRemote = offer?.remote
      break
    }
    if (offer.value === null) return null
    saved[active] = offer.value
  }
  if (active === specs.length) return saved

  const lone = specs.length === 1
  let dispose = () => initialRemote?.close()
  try {
    return await ctx.ui.custom<BatchAnswers | null>((tui, theme, _kb, done) => {
      const states = specs.map((spec) => ({
        optionIndex: 0,
        editMode: false,
        checked: spec.options.map(() => false),
        editor: new Input({ prompt: '', placeholder: 'Type something.', placeholderStyle: (text) => theme.fg('dim', text) }),
        answer: undefined as OverlayAnswer | undefined,
        remotelyAnswered: false,
      }))
      saved.forEach((value, index) => {
        if (value) restoreRemoteAnswer(index, value)
      })
      let reviewIndex = 0
      // One offer per question, live until that question is settled, whichever tab has focus.
      const remotes = specs.map((_, index) => (index === active ? initialRemote : undefined))
      const offered = specs.map((_, index) => index <= active)
      let finished = false
      let deadline = 0
      let countdown: number | undefined
      resetIdleTimer()
      const timer = timeoutMs === undefined ? undefined : setInterval(idleTick, IDLE_TICK_MS)

      function refresh(): void {
        tui.requestRender()
      }
      function resetIdleTimer(): void {
        deadline = Date.now() + (timeoutMs ?? 0)
      }
      dispose = () => {
        finished = true
        clearInterval(timer)
        for (const remote of remotes) remote?.close()
        signal?.removeEventListener('abort', abort)
      }
      function finish(value: BatchAnswers | null): void {
        if (finished) return
        dispose()
        done(value)
      }
      function abort(): void {
        finish(null)
      }
      function checkedAnswer(index: number): OverlayAnswer {
        const written = states[index].editor.getValue().trim()
        return { answer: selectedLabels(specs[index].options, states[index].checked), ...(written ? { written } : {}), wasCustom: false }
      }
      /** The confirmed answer, else whatever is filled in. */
      function draftAnswer(index: number): OverlayAnswer | undefined {
        const state = states[index]
        const draft = state.editor.getValue().trim()
        if (state.answer || (!state.checked.some(Boolean) && !draft)) return state.answer
        return specs[index].multiSelect ? checkedAnswer(index) : { answer: draft, wasCustom: true }
      }
      function answers(): BatchAnswers {
        return states.map((_, index) => draftAnswer(index))
      }
      /** The confirmed answer, else only the checked options and multiSelect text. */
      function timeoutAnswer(index: number): OverlayAnswer {
        return states[index].answer ?? { ...(specs[index].multiSelect ? checkedAnswer(index) : { answer: '', wasCustom: false }), timedOut: true }
      }
      function restoreRemoteAnswer(index: number, value: OverlayAnswer): void {
        const state = states[index]
        state.answer = value
        state.remotelyAnswered = true
        state.editMode = false
        if (value.checked) {
          state.checked = value.checked
          return
        }
        state.editor.setValue(value.wasCustom ? value.answer : '')
        state.optionIndex = value.wasCustom ? specs[index].options.length : (value.index ?? 1) - 1
      }
      function receive(index: number, value: QuestionAnswer): void {
        if (finished) return
        resetIdleTimer()
        if (value === null) finish(null)
        else {
          restoreRemoteAnswer(index, value)
          if (states.every((state) => state.remotelyAnswered)) finish(answers())
          else if (index === active) navigate(active + 1)
          else refresh()
        }
      }
      function attachRemote(index: number): void {
        remotes[index]?.attach((value) => receive(index, value), resetIdleTimer)
      }
      function navigate(index: number): void {
        active = index
        refresh()
        if (active === specs.length || offered[active]) return
        offered[active] = true
        const offer = offerRemoteQuestion(specs[active], ctx, events, signal)
        if (offer?.kind === 'settled') receive(active, offer.value)
        else {
          remotes[active] = offer?.remote
          attachRemote(active)
        }
      }
      function commit(value: OverlayAnswer): void {
        states[active].answer = value
        states[active].remotelyAnswered = false
        remotes[active]?.close()
        if (lone) finish([value])
        else navigate(active + 1)
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      attachRemote(active)
      function idleTick(): void {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          finish(
            Object.assign(
              states.map((_, index) => timeoutAnswer(index)),
              { timedOut: true },
            ),
          )
          return
        }
        const next = remaining <= COUNTDOWN_WINDOW_MS ? Math.ceil(remaining / 1000) : undefined
        if (next !== countdown) {
          countdown = next
          refresh()
        }
      }
      function confirmSelection(): void {
        const state = states[active]
        const spec = specs[active]
        if (state.optionIndex > spec.options.length) {
          finish(
            Object.assign(
              states.map((confirmed) => confirmed.answer),
              { chat: true },
            ),
          )
          return
        }
        const freeText = state.optionIndex === spec.options.length
        if (freeText && !state.editMode) {
          state.editMode = true
          return
        }
        const written = state.editor.getValue().trim()
        if (spec.multiSelect) {
          if (state.checked.some(Boolean) || written) commit(checkedAnswer(active))
          else if (!lone) {
            // Nothing filled in leaves the question unanswered; a lone question has nowhere to advance.
            state.answer = undefined
            state.remotelyAnswered = false
            navigate(active + 1)
          }
          return
        }
        if (freeText) {
          if (written) commit({ answer: written, wasCustom: true })
          return
        }
        state.editor.setValue('')
        commit({ answer: spec.options[state.optionIndex].label, wasCustom: false, index: state.optionIndex + 1 })
      }
      function moveFocus(data: string): boolean {
        const state = states[active]
        const freeTextRow = specs[active].options.length
        if (matchesKey(data, Key.up)) state.optionIndex = Math.max(0, state.optionIndex - 1)
        else if (matchesKey(data, Key.down)) state.optionIndex = Math.min(freeTextRow + 1, state.optionIndex + 1)
        else return false
        state.editMode = state.optionIndex === freeTextRow
        refresh()
        return true
      }
      function handleQuestionInput(state: (typeof states)[number], data: string): void {
        if (moveFocus(data)) return
        if (matchesKey(data, Key.escape)) {
          if (state.editMode && state.editor.getValue().trim()) state.editMode = false
          else finish(null)
        } else if (matchesKey(data, Key.enter)) {
          confirmSelection()
        } else if (state.editMode) {
          if (!matchesKey(data, Key.tab) && !matchesKey(data, Key.shift('tab'))) {
            state.remotelyAnswered = false
            state.editor.handleInput(data)
          }
        } else if (specs[active].multiSelect && data === ' ' && state.optionIndex < specs[active].options.length) {
          state.checked[state.optionIndex] = !state.checked[state.optionIndex]
          state.remotelyAnswered = false
        }
        refresh()
      }
      function navigateWithKey(data: string): boolean {
        if (states[active]?.editMode) return false
        const next = matchesKey(data, Key.tab) || matchesKey(data, Key.right)
        const previous = matchesKey(data, Key.shift('tab')) || matchesKey(data, Key.left)
        if (!next && !previous) return false
        navigate((active + (previous ? specs.length : 1)) % (specs.length + 1))
        return true
      }
      function handleReviewInput(data: string): void {
        if (matchesKey(data, Key.up)) reviewIndex = 0
        if (matchesKey(data, Key.down)) reviewIndex = 1
        if (matchesKey(data, Key.enter)) finish(reviewIndex === 0 ? answers() : null)
        if (matchesKey(data, Key.escape)) finish(null)
        refresh()
      }
      function handleInput(data: string): void {
        if (finished) return
        resetIdleTimer()
        if (!lone && navigateWithKey(data)) return
        const state = states[active]
        if (state) handleQuestionInput(state, data)
        else handleReviewInput(data)
      }

      function textField(state: (typeof states)[number], width: number): string {
        const draft = state.editor.getValue()
        state.editor.focused = state.editMode
        // The row's prefix and number take five columns, a checkbox four more.
        if (state.editMode) return state.editor.render(Math.max(1, width - (specs[active].multiSelect ? 9 : 5)))[0].trimEnd()
        return draft ? theme.fg('text', draft) : theme.fg('dim', 'Type something.')
      }
      function renderTabs(width: number, saved: BatchAnswers): string {
        const tabs = specs.map((spec, index) => ` ${saved[index] ? '☒' : '☐'} ${spec.header ?? `Q${index + 1}`} `)
        tabs.push(' ✔ Submit ')
        const arrows = tabs[active].length + 4 <= width
        const room = arrows ? width - 4 : width
        let first = active
        let last = active
        let used = tabs[active].length
        // Grow outward from the active tab so it always stays visible.
        for (let grew = true; grew; ) {
          grew = false
          if (first > 0 && used + 1 + tabs[first - 1].length <= room) {
            used += 1 + tabs[--first].length
            grew = true
          }
          if (last < tabs.length - 1 && used + 1 + tabs[last + 1].length <= room) {
            used += 1 + tabs[++last].length
            grew = true
          }
        }
        const shown = tabs.slice(first, last + 1).map((tab, offset) => (first + offset === active ? theme.bg('selectedBg', theme.fg('text', tab)) : theme.fg('text', tab)))
        return arrows ? `${theme.fg('dim', '←')} ${shown.join(' ')} ${theme.fg('dim', '→')}` : shown.join(' ')
      }
      function reviewBody(width: number, saved: BatchAnswers): string[] {
        const lines = [` ${theme.bold('Review your answers')}`, '']
        const item = (marker: string, text: string, color: 'text' | 'success') => {
          const lead = Math.min(marker.length, width - 1)
          wrapTextWithAnsi(text, Math.max(1, width - lead)).forEach((line, n) => {
            lines.push((n === 0 ? theme.fg(color, marker.slice(0, lead)) : ' '.repeat(lead)) + theme.fg(color, line))
          })
        }
        if (saved.includes(undefined)) lines.push(theme.fg('warning', ' ⚠ You have not answered all questions'), '')
        specs.forEach((spec, index) => {
          const answer = saved[index]
          if (!answer) return
          item(' ● ', spec.question, 'text')
          item('   → ', answerText(answer) || '(none)', 'success')
        })
        if (saved.some(Boolean)) lines.push('')
        lines.push(theme.fg('muted', ' Ready to submit your answers?'), '', optionLine('Submit answers', 0, reviewIndex === 0, theme), optionLine('Cancel', 1, reviewIndex === 1, theme))
        return lines
      }
      function render(width: number): string[] {
        width = Math.max(1, width)
        const state = states[active]
        const spec = specs[active]
        const saved = answers()
        const rule = theme.fg('accent', '─'.repeat(width))
        const lines = state
          ? buildQuestionLines({
              width,
              question: theme.bold(spec.question),
              options: [...spec.options, { label: '', field: textField(state, width) }, { label: 'Chat about this' }],
              optionIndex: state.optionIndex,
              multiSelect: spec.multiSelect === true,
              // A multiSelect free-text row is checked exactly when it has text; Space never toggles it.
              checked: [...state.checked, state.editor.getValue().trim() !== ''],
              theme,
            })
          : [rule, ...reviewBody(width, saved)]
        lines.push('', theme.fg('dim', navHint(state?.editMode === true, spec?.multiSelect === true, !lone)))
        if (countdown !== undefined) lines.push(theme.fg('warning', ` Auto-continuing in ${countdown}s if idle · press any key to stay`))
        lines.push(rule)
        // The tab bar sits inside the frame, under its top border.
        if (!lone) lines.splice(1, 0, renderTabs(width, saved), '')
        else if (spec.header) lines.splice(1, 0, theme.bg('selectedBg', theme.fg('text', ` ☐ ${spec.header} `)), '')
        return lines.map((line) => truncateToWidth(line, width))
      }
      return {
        render,
        handleInput,
        invalidate: () => {
          for (const state of states) state.editor.invalidate()
        },
        dispose,
      }
    })
  } finally {
    dispose()
  }
}

/** Dialog-primitive fallback for UI without a terminal (RPC mode supports
 * select/input/notify but not custom components). A dismissed dialog reads as a
 * cancel, same as Escape in the overlay. */
async function askViaDialogs(params: QuestionSpec, ctx: ExtensionContext): Promise<QuestionAnswer> {
  const title = params.header ? `[${params.header}] ${params.question}` : params.question
  // Number the labels: ctx.ui.select returns the chosen label string, so duplicate
  // labels (or a model-supplied option named like the free-text entry) would be
  // ambiguous by text alone; the number is the unambiguous way back to the option.
  const labels = [...params.options.map((option) => option.label), ...(params.multiSelect ? [] : ['Type something.'])].map((label, i) => `${i + 1}. ${label}`)
  const choice = await ctx.ui.select(title, labels)
  if (choice === undefined) return null
  const index = labels.indexOf(choice)
  if (index === params.options.length) {
    const typed = await ctx.ui.input(params.question, 'Your answer')
    // A dismissed dialog cancels; a submitted empty answer is an (empty) answer, not a
    // cancel, so one accidental blank Enter does not abort the rest of a question batch.
    if (typed === undefined) return null
    return { answer: typed.trim(), wasCustom: true }
  }
  const answer = params.options[index]?.label ?? choice
  return params.multiSelect ? { answer, wasCustom: false } : { answer, wasCustom: false, index: index + 1 }
}
