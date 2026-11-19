/**
 * pi's own settings.json, where pi-code keeps its `piCode.*` keys. pi exposes no settings
 * writer to extensions, so pi-code edits the file itself.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { atomicWriteFile } from './atomic-write.ts'
import { isRecord } from './values.ts'

export function piSettingsFile(): string {
  return path.join(getAgentDir(), 'settings.json')
}

/** pi's settings reader strips a leading UTF-8 byte order mark before it parses, so a
 * settings.json pi accepts can begin with one. */
export function stripBom(raw: string): string {
  return raw.startsWith('\uFEFF') ? raw.slice(1) : raw
}

/** Replace the `piCode` object of pi's global settings.json with `update(current)`, keeping
 * every other key. Throws on a settings file that cannot be read or does not parse, which a
 * rewrite would destroy. */
export function updatePiCodeSettings(update: (piCode: Record<string, unknown>) => Record<string, unknown>): void {
  const file = piSettingsFile()
  let raw: string | undefined
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const parsed: unknown = raw === undefined ? {} : JSON.parse(stripBom(raw))
  if (!isRecord(parsed)) throw new Error(`${file} is not a JSON object`)
  parsed.piCode = update(isRecord(parsed.piCode) ? parsed.piCode : {})
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // No lock is shared with pi's own settings writer, so a pi write that lands between the read above and this rename is lost.
  atomicWriteFile(file, `${JSON.stringify(parsed, null, 2)}\n`)
}
