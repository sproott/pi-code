import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { initTheme } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import todoExtension, { type LegacyTodo, layoutOverlay, normalizeTodo, type Todo } from '../extensions/todo.ts'

type ToolResult = { content: Array<{ type: string; text: string }>; details: { action: string; todos: Todo[]; nextId: number; error?: string } }
type Execute = (id: string, params: Record<string, unknown>, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<ToolResult>

/** Fresh extension instance so module-level todo state is isolated per test. */
const setup = (): { call: (params: Record<string, unknown>) => Promise<ToolResult> } => {
  let execute: Execute | undefined
  todoExtension({
    appendEntry: () => {},
    on: () => {},
    registerCommand: () => {},
    registerTool: (tool: { name: string; execute: Execute }) => {
      if (tool.name === 'todo') execute = tool.execute
    },
  } as never)
  if (!execute) throw new Error('todo tool was not registered')
  const run = execute
  return { call: (params) => run('call-1', params) }
}

const pending = (id: number, text: string): Todo => ({ id, text, status: 'pending' })
const completed = (id: number, text: string): Todo => ({ id, text, status: 'completed' })

describe('normalizeTodo', () => {
  it('passes through a todo that already has a status', () => {
    const todo: LegacyTodo = { id: 3, text: 'ship', status: 'in_progress', activeForm: 'Shipping' }
    expect(normalizeTodo(todo)).toEqual({ id: 3, text: 'ship', status: 'in_progress', activeForm: 'Shipping' })
  })

  it('migrates the legacy done boolean to a status', () => {
    expect(normalizeTodo({ id: 1, text: 'a', done: true })).toEqual({ id: 1, text: 'a', status: 'completed' })
    expect(normalizeTodo({ id: 2, text: 'b', done: false })).toEqual({ id: 2, text: 'b', status: 'pending' })
    expect(normalizeTodo({ id: 4, text: 'c' })).toEqual({ id: 4, text: 'c', status: 'pending' })
  })
})

describe('layoutOverlay', () => {
  it('shows every todo when the list fits the budget', () => {
    const todos = [pending(1, 'a'), pending(2, 'b')]
    expect(layoutOverlay(todos, 5)).toEqual({ visible: todos, hiddenCompleted: 0, truncatedTail: 0 })
  })

  it('drops completed todos first on overflow, reserving a row for the summary', () => {
    const todos = [pending(1, 'a'), pending(2, 'b'), completed(3, 'c'), completed(4, 'd')]
    const layout = layoutOverlay(todos, 3)
    // innerBudget = 2 rows, both pending kept, both completed hidden
    expect(layout.visible).toEqual([pending(1, 'a'), pending(2, 'b')])
    expect(layout.hiddenCompleted).toBe(2)
    expect(layout.truncatedTail).toBe(0)
  })

  it('keeps completed rows interleaved in order when they still fit', () => {
    const todos = [completed(1, 'a'), pending(2, 'b'), completed(3, 'c'), completed(4, 'd'), completed(5, 'e')]
    const layout = layoutOverlay(todos, 4)
    // innerBudget = 3: the single pending plus the first two completed, in original order
    expect(layout.visible).toEqual([completed(1, 'a'), pending(2, 'b'), completed(3, 'c')])
    expect(layout.hiddenCompleted).toBe(2)
    expect(layout.truncatedTail).toBe(0)
  })

  it('truncates the non-completed tail when the pending list alone overflows', () => {
    const todos = [pending(1, 'a'), pending(2, 'b'), pending(3, 'c'), pending(4, 'd')]
    const layout = layoutOverlay(todos, 3)
    expect(layout.visible).toEqual([pending(1, 'a'), pending(2, 'b')])
    expect(layout.hiddenCompleted).toBe(0)
    expect(layout.truncatedTail).toBe(2)
  })
})

describe('todo tool status machine', () => {
  let call: (params: Record<string, unknown>) => Promise<ToolResult>

  beforeEach(() => {
    call = setup().call
  })

  it('adds todos as pending with incrementing ids', async () => {
    const first = await call({ action: 'add', text: 'write tests' })
    const second = await call({ action: 'add', text: 'ship it' })
    expect(first.details.todos).toEqual([{ id: 1, text: 'write tests', status: 'pending', activeForm: undefined }])
    expect(second.details.todos.map((t) => t.id)).toEqual([1, 2])
    expect(second.details.nextId).toBe(3)
    expect(second.content[0].text).toContain('Added todo #2')
  })

  it('keeps the statuses a result was created with when later calls change the list', async () => {
    // pi stores a tool result's details by reference, so a result must hold its own
    // snapshot: start/complete mutate the live todo objects.
    const { call } = setup()
    const added = await call({ action: 'add', text: 'a' })
    await call({ action: 'start', id: 1 })
    await call({ action: 'complete', id: 1 })
    expect(added.details.todos).toEqual([{ id: 1, text: 'a', status: 'pending', activeForm: undefined }])
  })

  it('rejects add without text', async () => {
    const result = await call({ action: 'add' })
    expect(result.details.error).toBe('text required for add')
    expect(result.details.todos).toEqual([])
  })

  it('starts a todo and demotes any other in_progress todo back to pending', async () => {
    await call({ action: 'add', text: 'one' })
    await call({ action: 'add', text: 'two' })
    await call({ action: 'start', id: 1, activeForm: 'Doing one' })
    const result = await call({ action: 'start', id: 2 })

    const byId = new Map(result.details.todos.map((t) => [t.id, t]))
    expect(byId.get(1)?.status).toBe('pending')
    expect(byId.get(2)?.status).toBe('in_progress')
    expect(result.content[0].text).toContain('moved #1 back to pending')
  })

  it('keeps the activeForm label set on start', async () => {
    await call({ action: 'add', text: 'one' })
    const result = await call({ action: 'start', id: 1, activeForm: 'Doing one' })
    expect(result.details.todos[0].activeForm).toBe('Doing one')
  })

  it('errors when starting an unknown id', async () => {
    const result = await call({ action: 'start', id: 99 })
    expect(result.details.error).toBe('#99 not found')
  })

  it('completes a todo', async () => {
    await call({ action: 'add', text: 'one' })
    const result = await call({ action: 'complete', id: 1 })
    expect(result.details.todos[0].status).toBe('completed')
  })

  it('errors when completing an unknown id', async () => {
    const result = await call({ action: 'complete', id: 99 })
    expect(result.details.error).toBe('#99 not found')
  })

  it('deletes a todo by id', async () => {
    await call({ action: 'add', text: 'one' })
    await call({ action: 'add', text: 'two' })
    const result = await call({ action: 'delete', id: 1 })
    expect(result.details.todos.map((t) => t.id)).toEqual([2])
    expect(result.content[0].text).toContain('Deleted #1')
  })

  it('errors when deleting an unknown id', async () => {
    const result = await call({ action: 'delete', id: 99 })
    expect(result.details.error).toBe('#99 not found')
  })

  it('clears all todos and resets the id counter', async () => {
    await call({ action: 'add', text: 'one' })
    await call({ action: 'add', text: 'two' })
    const cleared = await call({ action: 'clear' })
    expect(cleared.details.todos).toEqual([])
    expect(cleared.content[0].text).toContain('Cleared 2 todos')

    const readded = await call({ action: 'add', text: 'fresh' })
    expect(readded.details.todos[0].id).toBe(1)
  })

  it('lists todos with a status mark per row', async () => {
    await call({ action: 'add', text: 'one' })
    await call({ action: 'add', text: 'two' })
    await call({ action: 'complete', id: 1 })
    const result = await call({ action: 'list' })
    expect(result.content[0].text).toBe('[x] #1: one\n[ ] #2: two')
  })

  it('reports an empty list', async () => {
    const result = await call({ action: 'list' })
    expect(result.content[0].text).toBe('No todos')
  })

  it('fails on an unknown action', async () => {
    const result = await call({ action: 'explode' })
    expect(result.details.error).toBe('unknown action: explode')
  })
})

type RegisteredTool = { name: string; description: string; promptGuidelines?: string[] }
type Handler = (event: unknown, ctx?: unknown) => unknown

/** Extension wired to a pi mock with the given settings and active tools, exposing its handlers. */
const setupSession = (settings: unknown, activeTools = ['todo']) => {
  const handlers = new Map<string, Handler>()
  let tool: RegisteredTool | undefined
  todoExtension({
    appendEntry: () => {},
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: () => {},
    registerTool: (t: RegisteredTool) => {
      tool = t
    },
    getSettings: () => settings,
    getActiveTools: () => activeTools,
  } as never)
  const fire = (name: string, event: unknown = {}) => handlers.get(name)?.(event, { hasUI: false, sessionManager: { getBranch: () => [] } })
  fire('session_start')
  return { tool: () => tool as RegisteredTool, fire }
}

const PROACTIVE_GUIDELINE = /3\+ steps/

describe('todo guidance setting', () => {
  it('should register the tool without usage guidelines when the setting is missing', () => {
    const { tool } = setupSession({})
    expect(tool().promptGuidelines, 'default level adds no guidelines').toEqual([])
  })

  it('should register the strong guidelines when todoGuidance is strong', () => {
    const { tool } = setupSession({ piCode: { todoGuidance: 'strong' } })
    expect(tool().promptGuidelines?.[0], 'first guideline pushes multi-step tracking').toMatch(PROACTIVE_GUIDELINE)
  })

  it('should fall back to the light level when todoGuidance is unknown', () => {
    const { tool } = setupSession({ piCode: { todoGuidance: 'always' } })
    expect(tool().promptGuidelines, 'unknown value adds no guidelines').toEqual([])
  })
})

describe('todo reminder', () => {
  const runTurns = (fire: (name: string, event?: unknown) => unknown, turns: number) => {
    for (let i = 0; i < turns; i++) fire('turn_end')
  }
  const lastText = (result: unknown) => (result as { messages: Array<{ content: string }> } | undefined)?.messages.at(-1)?.content

  it('should leave the request unchanged when fewer than ten turns passed without the todo tool', () => {
    const { fire } = setupSession({})
    runTurns(fire, 9)
    expect(fire('context', { messages: [] }), 'no reminder before ten turns').toBeUndefined()
  })

  it('should append the reminder to the request when ten turns passed without the todo tool', () => {
    const { fire } = setupSession({})
    runTurns(fire, 10)
    expect(lastText(fire('context', { messages: [] })), 'reminder is the last message').toMatch(/todo tool has not been used/)
  })

  it('should restart the count when the reminder was sent', () => {
    const { fire } = setupSession({})
    runTurns(fire, 10)
    fire('context', { messages: [] })
    expect(fire('context', { messages: [] }), 'next request carries no reminder').toBeUndefined()
  })

  it('should restart the count when the todo tool was called', () => {
    const { fire } = setupSession({})
    runTurns(fire, 9)
    fire('tool_execution_end', { toolName: 'todo', isError: false })
    runTurns(fire, 1)
    expect(fire('context', { messages: [] }), 'a todo call resets the count').toBeUndefined()
  })

  it('should not remind when the todo tool is inactive', () => {
    const { fire } = setupSession({}, ['read'])
    runTurns(fire, 10)
    expect(fire('context', { messages: [] }), 'inactive tool gets no reminder').toBeUndefined()
  })
})

describe('/todos settings', () => {
  type Component = { handleInput: (data: string) => void; render: (width: number) => string[] }
  type Factory = (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => Component

  let savedAgentDir: string | undefined
  let agentDir = ''
  beforeEach(() => {
    savedAgentDir = process.env.PI_CODING_AGENT_DIR
    agentDir = mkdtempSync(join(tmpdir(), 'todo-agentdir-'))
    process.env.PI_CODING_AGENT_DIR = agentDir
    writeFileSync(join(agentDir, 'settings.json'), '{"theme":"dark"}')
  })
  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir
  })

  /** The extension with a pi mock whose settings snapshot stays `{}`, as pi's does until /reload. */
  const setup = () => {
    const handlers = new Map<string, Handler>()
    let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined
    let tool: RegisteredTool | undefined
    todoExtension({
      appendEntry: () => {},
      on: (name: string, handler: Handler) => handlers.set(name, handler),
      registerCommand: (_name: string, spec: typeof command) => {
        command = spec
      },
      registerTool: (t: RegisteredTool) => {
        tool = t
      },
      getSettings: () => ({}),
      getActiveTools: () => ['todo'],
    } as never)
    const run = async (keys: string[], project?: object, mode = 'tui') => {
      const cwd = mkdtempSync(join(tmpdir(), 'todo-project-'))
      if (project) {
        mkdirSync(join(cwd, '.pi'))
        writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify(project))
      }
      const notices: string[] = []
      let screen = ''
      const ctx = {
        mode,
        cwd,
        hasUI: true,
        isProjectTrusted: () => true,
        ui: {
          notify: (message: string) => notices.push(message),
          custom: (factory: Factory) =>
            new Promise<void>((resolve) => {
              const component = factory({ requestRender: () => {} }, {}, {}, resolve)
              for (const key of keys) component.handleInput(key)
              screen = stripVTControlCharacters(component.render(120).join('\n'))
            }),
        },
      }
      await command?.handler('settings', ctx)
      return { notices, screen }
    }
    const startSession = () => handlers.get('session_start')?.({}, { hasUI: false, sessionManager: { getBranch: () => [] } })
    return { run, tool: () => tool as RegisteredTool, startSession }
  }
  const savedSettings = () => JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf-8'))

  it('should save the strong level and apply it at once when Space changes the row', async () => {
    initTheme()
    const { run, tool } = setup()
    await run([' ', '\x1b'])
    expect(savedSettings(), 'saved under piCode, other keys kept').toEqual({ theme: 'dark', piCode: { todoGuidance: 'strong' } })
    expect(tool().promptGuidelines?.[0], 'tool registered again with the strong guidelines').toMatch(PROACTIVE_GUIDELINE)
  })

  it('should keep the saved level when a session starts before pi reloads its settings', async () => {
    initTheme()
    const { run, tool, startSession } = setup()
    await run([' ', '\x1b'])
    startSession()
    expect(tool().promptGuidelines?.[0], 'stale settings snapshot does not undo the change').toMatch(PROACTIVE_GUIDELINE)
  })

  it('should leave the row unchanged when the trusted project sets the level', async () => {
    initTheme()
    const { run } = setup()
    const { screen } = await run([' ', '\x1b'], { piCode: { todoGuidance: 'strong' } })
    expect(savedSettings().piCode, 'nothing saved over a project value').toBeUndefined()
    expect(screen, 'row says where the value comes from').toContain('.pi/settings.json; change it there')
  })

  it('should report the current level when the session has no TUI', async () => {
    const { run } = setup()
    const { notices } = await run([], undefined, 'rpc')
    expect(notices[0], 'level shown as text').toMatch(/^Todo guidance: light\./)
  })
})
