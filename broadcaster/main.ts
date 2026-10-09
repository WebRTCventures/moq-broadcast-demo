// broadcaster/main.ts — product-style "studio" UI over the Broadcaster orchestrator.
//
// A dev/presentation driver (excluded from the vitest suite, loaded only by the Vite
// dev server). Styled like a real "go live" studio to match the viewer: a dark stage
// with a live camera monitor, an OFFLINE/● LIVE badge + uptime, the published quality
// ladder, toasts for status, and a tucked-away connection panel. It is a thin layer over
// the unchanged Broadcaster class (publish.ts), which still owns connect / announce /
// camera capture / 3-track encode+publish / teardown.

import { Broadcaster, type BroadcasterStatus } from './publish.ts'

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

// --- DOM refs ---------------------------------------------------------------
const preview = $<HTMLVideoElement>('preview')
const goLiveBtn = $<HTMLButtonElement>('go-live')
const settingsBtn = $<HTMLButtonElement>('settings-btn')

const livePill = $<HTMLSpanElement>('live-pill')
const liveText = $<HTMLSpanElement>('live-text')
const uptimePill = $<HTMLSpanElement>('uptime-pill')
const uptimeEl = $<HTMLSpanElement>('uptime')
const phasePill = $<HTMLSpanElement>('phase-pill')
const ladder = $<HTMLDivElement>('ladder')

const overlay = $<HTMLDivElement>('overlay')
const overlayIdle = $<HTMLDivElement>('overlay-idle')
const overlayLoading = $<HTMLDivElement>('overlay-loading')
const overlayError = $<HTMLDivElement>('overlay-error')
const loadingText = $<HTMLDivElement>('loading-text')
const errorText = $<HTMLDivElement>('error-text')

const infoCard = $<HTMLDivElement>('info')
const infoStatus = $<HTMLDivElement>('info-status')
const infoNs = $<HTMLDivElement>('info-ns')
const infoRelay = $<HTMLDivElement>('info-relay')

const settingsModal = $<HTMLDivElement>('settings-modal')
const settingsClose = $<HTMLButtonElement>('settings-close')
const relayInput = $<HTMLInputElement>('relay')
const namespaceInput = $<HTMLInputElement>('namespace')

// --- Config defaults (overridable via URL query params) ---------------------
const params = new URLSearchParams(window.location.search)
const paramRelay = params.get('relay')
const paramNs = params.get('ns') ?? params.get('namespace')
if (paramRelay) relayInput.value = paramRelay
if (paramNs) namespaceInput.value = paramNs

let broadcaster: Broadcaster | null = null
let live = false
let startedAtMs = 0
let uptimeTimer: number | null = null

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
const toastsEl = $<HTMLDivElement>('toasts')
function toast(message: string, isError = false): void {
  const el = document.createElement('div')
  el.className = isError ? 'toast err' : 'toast'
  el.textContent = message
  toastsEl.appendChild(el)
  window.setTimeout(() => {
    el.style.transition = 'opacity 0.3s'
    el.style.opacity = '0'
    window.setTimeout(() => el.remove(), 300)
  }, 2600)
}

// ---------------------------------------------------------------------------
// Overlay states
// ---------------------------------------------------------------------------
type OverlayState = 'idle' | 'loading' | 'error' | 'hidden'
function setOverlay(state: OverlayState, detail?: string): void {
  overlay.hidden = state === 'hidden'
  overlayIdle.hidden = state !== 'idle'
  overlayLoading.hidden = state !== 'loading'
  overlayError.hidden = state !== 'error'
  if (state === 'loading' && detail) loadingText.textContent = detail
  if (state === 'error' && detail) errorText.textContent = detail
}

// ---------------------------------------------------------------------------
// Live badge + uptime
// ---------------------------------------------------------------------------
function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}
function setLive(on: boolean): void {
  live = on
  livePill.classList.toggle('live', on)
  liveText.textContent = on ? 'LIVE' : 'OFFLINE'
  uptimePill.hidden = !on
  ladder.hidden = !on
  infoCard.hidden = !on
  goLiveBtn.classList.toggle('ending', on)
  goLiveBtn.textContent = on ? '■ End broadcast' : '● Go Live'
  if (on) {
    startedAtMs = performance.now()
    uptimeTimer = window.setInterval(() => {
      uptimeEl.textContent = fmtUptime(performance.now() - startedAtMs)
    }, 500)
  } else if (uptimeTimer !== null) {
    clearInterval(uptimeTimer)
    uptimeTimer = null
    uptimeEl.textContent = '00:00'
  }
}

// ---------------------------------------------------------------------------
// Broadcaster status → UI
// ---------------------------------------------------------------------------
// Phases: connecting → announced → capturing → publishing → (error|stopped).
const PHASE_LABEL: Record<BroadcasterStatus, string> = {
  connecting: 'Connecting to relay…',
  announced: 'Namespace announced',
  capturing: 'Camera live',
  publishing: 'Publishing',
  error: 'Error',
  stopped: 'Stopped',
}

function report(status: BroadcasterStatus, detail?: string): void {
  console.log(`[broadcaster] ${detail ? `${status} — ${detail}` : status}`)
  phasePill.hidden = false
  phasePill.textContent = PHASE_LABEL[status] ?? status
  infoStatus.textContent = PHASE_LABEL[status] ?? status

  if (status === 'connecting') setOverlay('loading', 'Connecting to relay…')
  else if (status === 'announced') setOverlay('loading', 'Announcing stream…')
  else if (status === 'capturing') setOverlay('loading', 'Camera starting…')
  else if (status === 'publishing') {
    // Fully live: hide the overlay so the camera monitor is clean, flip the badge.
    setOverlay('hidden')
    if (!live) {
      setLive(true)
      toast('You are live — publishing 720p / 480p / 360p')
    }
  } else if (status === 'error') {
    setOverlay('error', detail ?? 'Broadcast error')
    phasePill.hidden = true
    if (detail) toast(detail, true)
  } else if (status === 'stopped') {
    phasePill.hidden = true
  }
}

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------
settingsBtn.addEventListener('click', () => {
  settingsModal.hidden = false
})
settingsClose.addEventListener('click', () => {
  settingsModal.hidden = true
})
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.hidden = true
})

// ---------------------------------------------------------------------------
// Go Live / End broadcast
// ---------------------------------------------------------------------------
async function goLive(): Promise<void> {
  const namespace = namespaceInput.value
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  infoNs.textContent = namespace.join('/')
  infoRelay.textContent = relayInput.value.trim()

  broadcaster = new Broadcaster({
    relayUrl: relayInput.value.trim(),
    namespace,
    onStatus: report,
    previewElement: preview,
  })

  goLiveBtn.disabled = true
  setOverlay('loading', 'Starting…')
  try {
    await broadcaster.start()
    // 'publishing' status flips the badge; this covers the case where start resolves
    // without a later publishing callback.
    if (!live) setLive(true)
  } catch (err) {
    console.error('[broadcaster] start failed:', err)
    const message = err instanceof Error ? err.message : 'Failed to go live'
    setOverlay('error', message)
    toast(message, true)
    broadcaster = null
    setLive(false)
  } finally {
    goLiveBtn.disabled = false
  }
}

async function endBroadcast(): Promise<void> {
  goLiveBtn.disabled = true
  try {
    await broadcaster?.stop()
  } catch (err) {
    console.error('[broadcaster] stop failed:', err)
  } finally {
    broadcaster = null
    setLive(false)
    preview.srcObject = null
    phasePill.hidden = true
    setOverlay('idle')
    toast('Broadcast ended')
    goLiveBtn.disabled = false
  }
}

goLiveBtn.addEventListener('click', () => {
  if (live) void endBroadcast()
  else void goLive()
})
