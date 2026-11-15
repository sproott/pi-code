/**
 * Global test hygiene: the suite must be immune to the host environment.
 *
 * pi-code's own dev loop runs the tests inside Claude Code and inside pi
 * subagents, so the host env carries the very variables the source reads
 * (CLAUDECODE, PI_CODE_SUBAGENT, CLAUDE_CONFIG_DIR, the MCP timeout family).
 * They are deleted at module load, before any test file imports source that
 * could read them at import time, and again before each test so a leaky
 * earlier test cannot reintroduce them.
 *
 * Each test also runs against a snapshot of process.env: whatever a test sets
 * and forgets to restore is rolled back afterwards. The global afterEach is
 * registered first, so vitest runs it after every file-local afterEach.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeEach } from 'vitest'

const HOST_LEAK_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CONFIG_DIR',
  'PI_CODE_SUBAGENT',
  'PI_CODE_AGENT_HOOKS',
  'MCP_TIMEOUT',
  'MCP_TOOL_TIMEOUT',
  'CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'CLAUDE_CODE_REMOTE_MEMORY_DIR',
  'CLAUDE_CODE_PROJECT_DIR_NAME',
  'CLAUDE_CODE_STOP_HOOK_BLOCK_CAP',
  'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD',
  'WT_SESSION',
  'KITTY_WINDOW_ID',
  'PI_CODE_SETTINGS_WATCH_INTERVAL_MS',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_GOAL_CHECKIN_MINUTES',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
  'CLAUDE_CODE_DISABLE_TERMINAL_TITLE',
  'CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING',
  'CLAUDE_CODE_DISABLE_POLICY_SKILLS',
  'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'MCP_OAUTH_CALLBACK_PORT',
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
]

function quarantine(): void {
  for (const name of HOST_LEAK_VARS) delete process.env[name]
}

quarantine()

// Every temp fixture in the suite goes through os.tmpdir(), which resolves from
// TMPDIR (TEMP/TMP on Windows). Pointing it at a per-file root at setup load,
// before any test module runs, funnels every mkdtempSync in the file under one
// directory that afterAll removes wholesale, so no fixture can outlive its file
// regardless of whether the test cleans up.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-code-tests-'))
process.env.TMPDIR = tmpRoot
process.env.TEMP = tmpRoot
// Windows keeps the host TMP. Git Bash mounts /tmp on the directory GetTempPath reports
// (TMP before TEMP) when its first process starts, and every msys process running at the
// same time shares that mount table, across test files. A shell still alive after its
// file's root is removed would leave /tmp dangling for the other workers' shells, which
// then print "could not find /tmp" on stderr. os.tmpdir() reads TEMP first.
if (process.platform !== 'win32') process.env.TMP = tmpRoot
// pi's agent directory (memory, checkpoints, mcp.json, trust decisions, OAuth tokens)
// resolves through the SDK's getAgentDir(), which a node:os mock in a test file does
// not reach. Pointed at the per-file root unconditionally, so no suite can write into
// the developer's real ~/.pi/agent whichever home it fakes.
process.env.PI_CODING_AGENT_DIR = path.join(tmpRoot, 'pi-agent')

afterAll(async () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch (error) {
    if (process.platform === 'win32') await diagnoseBusyRoot(error)
    throw error
  }
}, 120_000)

// Temporary diagnostics for the Windows EBUSY on removing tmpRoot.
async function diagnoseBusyRoot(error: unknown): Promise<void> {
  const { execFileSync } = await import('node:child_process')
  const run = (file: string, args: string[]): string => {
    try {
      return execFileSync(file, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    } catch (e) {
      return `(${file} failed: ${String(e)})`
    }
  }
  const note = (text: string): void => {
    if (process.env.EBUSY_DIAG_FILE) fs.appendFileSync(process.env.EBUSY_DIAG_FILE, `${text}\n`)
    console.error(text)
  }
  note(`=== EBUSY ${new Date().toISOString()} pid=${process.pid} root=${tmpRoot}\nerror: ${String(error)}`)
  const left: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      left.push(full + (entry.isDirectory() ? '\\' : ''))
      if (entry.isDirectory()) walk(full)
    }
  }
  try {
    walk(tmpRoot)
  } catch (e) {
    left.push(`(walk failed: ${String(e)})`)
  }
  note(['--- left in root:', ...left].join('\n'))
  const handles = process.env.HANDLE_EXE ? run(process.env.HANDLE_EXE, ['-accepteula', '-nobanner', '-u', tmpRoot]) : '(no HANDLE_EXE)'
  note(`--- handle:\n${handles}`)
  const procs = run('powershell', [
    '-NoProfile',
    '-Command',
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -notmatch '^(svchost|System|Idle|Registry|smss|csrss|wininit|services|lsass|winlogon|dwm|fontdrvhost|WmiPrvSE|conhost|RuntimeBroker|sihost|taskhostw|explorer|ctfmon|MsMpEng|NisSrv|SearchIndexer|spoolsv|dllhost|Runner.Listener|Runner.Worker|provisioner)' } | Format-Table -AutoSize -Wrap ProcessId,ParentProcessId,Name,CreationDate,CommandLine | Out-String -Width 400",
  ])
  note(`--- processes:\n${procs}`)
  await new Promise((resolve) => setTimeout(resolve, 3000))
  let later = 'removed after 3 s'
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch (e) {
    later = `still failing after 3 s: ${String(e)}`
  }
  note(`retry: ${later}\n`)
}

let snapshot: NodeJS.ProcessEnv

beforeEach(() => {
  quarantine()
  snapshot = { ...process.env }
})

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (process.env[key] !== value) process.env[key] = value
  }
  // A session mailbox outlives sessions on purpose (internal/session-mailbox), so a result
  // one test leaves held would be delivered into the next test's session start.
  const holder = globalThis as Record<symbol, unknown>
  for (const key of Object.getOwnPropertySymbols(holder)) {
    if (key.description?.startsWith('pi-code.session-mailbox.')) delete holder[key]
  }
})
