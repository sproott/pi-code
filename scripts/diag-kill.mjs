// Temporary: which stop paths leave part of a Git Bash command alive on Windows?
// Usage: node scripts/diag-kill.mjs <variant>
import { execFileSync, spawn } from 'node:child_process'
import * as path from 'node:path'
import { createLocalBashOperations, getShellConfig } from '@earendil-works/pi-coding-agent'
import { killProcessTree } from '../extensions/internal/process-tree.ts'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const pwsh = (script) => execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
// The odd durations mark this script's processes.
const mine = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '31\\.7|0\\.0517' -and $_.ProcessId -ne $PID }"
const survivors = () =>
  pwsh(`${mine} | ForEach-Object { "$($_.ProcessId) ppid=$($_.ParentProcessId) $($_.Name) $($_.CommandLine)" }`)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/powershell/i.test(l))
const sweep = () => {
  try {
    pwsh(`${mine} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`)
  } catch {}
}

const shell = getShellConfig()
const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
// detached: false as extensions/monitor.ts execSplit on win32, true as extensions/hooks/runners.ts.
const spawnShell = (command, detached = false) => {
  const child = spawn(shell.shell, [...shell.args, command], { detached, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.resume()
  child.stderr.resume()
  return child
}
const exited = (child) => new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r)))

// Each variant starts the command, stops it after `delay` ms, and resolves once the stop path reports the command finished.
const variants = {
  'taskkill-async': async (command, delay) => {
    const child = spawnShell(command)
    await wait(delay)
    spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    await exited(child)
  },
  'taskkill-sync': async (command, delay) => {
    const child = spawnShell(command)
    await wait(delay)
    try {
      execFileSync(taskkill, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {}
    await exited(child)
  },
  'pi-code-killProcessTree': async (command, delay) => {
    const child = spawnShell(command)
    await wait(delay)
    killProcessTree(child, 'SIGKILL')
    await exited(child)
  },
  'pi-code-killProcessTree-detached': async (command, delay) => {
    const child = spawnShell(command, true)
    await wait(delay)
    killProcessTree(child, 'SIGKILL')
    await exited(child)
  },
  'pi-bash-abort': async (command, delay) => {
    const ac = new AbortController()
    const run = createLocalBashOperations().exec(command, process.cwd(), { onData: () => {}, signal: ac.signal }).catch(() => {})
    await wait(delay)
    ac.abort()
    await run
  },
}

const variant = process.argv[2]
if (!variants[variant]) throw new Error(`variant must be one of: ${Object.keys(variants).join(', ')}`)
console.log(`shell: ${shell.shell} ${shell.args.join(' ')}`)
console.log(execFileSync(shell.shell, ['--version'], { encoding: 'utf8' }).split('\n')[0])

const allCommands = {
  sleep: 'sleep 31.7',
  tick: 'while true; do echo tick; sleep 0.0517; done',
  bg: 'sleep 31.7 & sleep 31.7',
  pipe: 'sleep 31.7 | cat',
  // Shapes used in tests/monitor.test.ts and tests/background-bash.test.ts.
  'echo;sleep': 'echo hi; sleep 31.7',
  'stderr;sleep': 'printf "%2000s" x >&2; sleep 31.7',
  'echo;sleep;echo': 'echo started; sleep 31.7; echo late',
  'seq;sleep': 'seq 1 20000; sleep 31.7',
}
const picked = process.argv.slice(3)
const commands = picked.length ? Object.fromEntries(picked.map((k) => [k, allCommands[k]])) : allCommands
const trials = 15
sweep()
for (const [name, command] of Object.entries(commands)) {
  for (const delay of [150, 1500]) {
    let leaked = 0
    const samples = []
    for (let i = 0; i < trials; i++) {
      await variants[variant](command, delay)
      await wait(1500)
      const left = survivors()
      if (left.length) {
        leaked++
        if (samples.length < 2) samples.push(left.join(' | '))
      }
      sweep()
    }
    console.log(`RESULT ${variant} ${name} stop@${delay}ms: leaked ${leaked}/${trials}${samples.length ? `\n    ${samples.join('\n    ')}` : ''}`)
  }
}
