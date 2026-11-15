import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent'
import type { TUI } from '@earendil-works/pi-tui'

/** pi's own choice of editor: its externalEditor setting, then VISUAL, EDITOR. */
export function externalEditorCommand(cwd: string): string {
  return SettingsManager.create(cwd, getAgentDir()).getExternalEditorCommand()
}

/**
 * Runs `command` on `file` with the terminal handed over: pi's TUI is stopped and restarted
 * around it, as pi's own external editor does. Resolves with the exit code, or null when the
 * editor could not start.
 */
export function runExternalEditor(tui: Pick<TUI, 'start' | 'stop' | 'requestRender'>, command: string, file: string): Promise<number | null> {
  tui.stop()
  return new Promise((resolve) => {
    let finished = false
    const finish = (exit: number | null): void => {
      if (finished) return
      finished = true
      tui.start()
      tui.requestRender(true)
      resolve(exit)
    }
    const [editor, ...editorArgs] = command.split(' ')
    const child = spawn(editor, [...editorArgs, file], { stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('error', () => finish(null))
    child.on('close', (exit) => finish(exit))
  })
}

/** Edits `text` in the external editor through a temp file. Undefined when the editor failed. */
export async function editTextExternally(tui: Pick<TUI, 'start' | 'stop' | 'requestRender'>, command: string, text: string): Promise<string | undefined> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-code-edit-'))
  const file = path.join(dir, 'text.md')
  try {
    fs.writeFileSync(file, text)
    if ((await runExternalEditor(tui, command, file)) !== 0) return undefined
    // Editors end a saved file with a newline the text never had.
    return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
