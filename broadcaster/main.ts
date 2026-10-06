// Manual end-to-end harness entry point (Task 11).
//
// Wires the DOM controls in index.html to the Broadcaster orchestrator so the
// broadcast can be driven from Chrome/Chromium for the Milestone-1 exit criterion.
// This is a dev/test driver, not application code — it is excluded from the vitest
// suite and is only loaded by the Vite dev server.

import { Broadcaster, type BroadcasterStatus } from './publish.ts'

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

const relayInput = $<HTMLInputElement>('relay')
const namespaceInput = $<HTMLInputElement>('namespace')
const startBtn = $<HTMLButtonElement>('start')
const stopBtn = $<HTMLButtonElement>('stop')
const statusEl = $<HTMLDivElement>('status')

let broadcaster: Broadcaster | null = null

function report(status: BroadcasterStatus, detail?: string): void {
  const line = detail ? `${status} — ${detail}` : status
  statusEl.textContent = line
  // Also log to the console so the full history (and any errors) is visible.
  console.log(`[broadcaster] ${line}`)
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true
  const namespace = namespaceInput.value
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  broadcaster = new Broadcaster({
    relayUrl: relayInput.value.trim(),
    namespace,
    onStatus: report,
  })

  try {
    await broadcaster.start()
    stopBtn.disabled = false
  } catch (err) {
    // start() already reported 'error' via onStatus; surface it here too.
    console.error('[broadcaster] start failed:', err)
    broadcaster = null
    startBtn.disabled = false
  }
})

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true
  try {
    await broadcaster?.stop()
  } catch (err) {
    console.error('[broadcaster] stop failed:', err)
  } finally {
    broadcaster = null
    startBtn.disabled = false
  }
})
