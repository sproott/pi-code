// Temporary: when does taskkill /T /F leave part of a Git Bash command alive?
import { execFileSync, spawn } from 'node:child_process'
import * as path from 'node:path'
import { getShellConfig } from '@earendil-works/pi-coding-agent'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const ps = () => {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'sleep.exe','bash.exe' -and $_.CommandLine -match '31\\.7|0\\.0517' } | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.Name) $($_.CommandLine)\" }"], { encoding: 'utf8' })
  return out.split('\n').map((l) => l.trim()).filter(Boolean)
}
const sweep = () => {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '31\\.7|0\\.0517' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"])
  } catch {}
}
const shell = getShellConfig()
const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
// The odd durations mark this script's processes.
const commands = { sleep: 'sleep 31.7', tick: 'while true; do echo tick; sleep 0.0517; done', bg: 'sleep 31.7 & sleep 31.7' }
const delays = [0, 50, 150, 400, 1500]
for (const [name, command] of Object.entries(commands)) {
  for (const delay of delays) {
    let leaked = 0
    const samples = []
    for (let i = 0; i < 15; i++) {
      const child = spawn(shell.shell, [...shell.args, command], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      child.stdout.resume()
      child.stderr.resume()
      await wait(delay)
      // As killProcessTree does: spawned, not awaited.
      spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      await new Promise((r) => child.once('exit', r))
      await wait(1500)
      const left = ps()
      if (left.length) {
        leaked++
        if (samples.length < 2) samples.push(left.join(' | '))
      }
      sweep()
    }
    console.log(`${name} kill@${delay}ms: leaked ${leaked}/15${samples.length ? `\n    ${samples.join('\n    ')}` : ''}`)
  }
}
