// viewer/main.ts — product-style player UI over the Viewer orchestrator.
//
// This is a dev/presentation driver (excluded from the vitest suite, loaded only by the
// Vite dev server). It is intentionally styled like a real low-latency streaming product
// rather than an engineer's harness: a dark player stage with an on-video HUD (LIVE badge
// + latency), a gear-menu quality picker with human labels, toasts for status, a tucked-
// away connection panel, and an optional "Stats for nerds" overlay. All of it is a thin
// presentation layer over the unchanged Viewer class (subscribe.ts / quality.ts), which
// still owns connect / discovery / join-late subscribe / render / the group-boundary
// quality switch (Req 6.1–6.4).

import { Viewer } from './subscribe.ts'
import type { ViewerConfig, ViewerStatus, ViewerError } from './subscribe.ts'
import type { QualityName } from './quality.ts'

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

// --- DOM refs ---------------------------------------------------------------
const video = $<HTMLVideoElement>('video')
const stopBtn = $<HTMLButtonElement>('stop')
const settingsBtn = $<HTMLButtonElement>('settings-btn')
const statsToggle = $<HTMLButtonElement>('stats-toggle')

const livePill = $<HTMLSpanElement>('live-pill')
const liveText = $<HTMLSpanElement>('live-text')
const latPill = $<HTMLSpanElement>('lat-pill')
const latNum = $<HTMLSpanElement>('lat-num')
const viewersPill = $<HTMLSpanElement>('viewers-pill')
const goLiveBtn = $<HTMLButtonElement>('golive')

const gearBtn = $<HTMLButtonElement>('gear')
const menu = $<HTMLDivElement>('menu')
const menuItems = $<HTMLDivElement>('menu-items')

const overlay = $<HTMLDivElement>('overlay')
const overlayConnect = $<HTMLDivElement>('overlay-connect')
const overlayLoading = $<HTMLDivElement>('overlay-loading')
const overlayError = $<HTMLDivElement>('overlay-error')
const loadingText = $<HTMLDivElement>('loading-text')
const errorText = $<HTMLDivElement>('error-text')
const connectBtn = $<HTMLButtonElement>('connect')
const retryBtn = $<HTMLButtonElement>('retry')

const statsEl = $<HTMLDivElement>('stats')
const statResEl = $<HTMLSpanElement>('stat-res')
const statLatEl = $<HTMLSpanElement>('stat-lat')
const statBufEl = $<HTMLSpanElement>('stat-buf')
const statFpsEl = $<HTMLSpanElement>('stat-fps')
const statDropEl = $<HTMLSpanElement>('stat-drop')
const statTrackEl = $<HTMLSpanElement>('stat-track')

const settingsModal = $<HTMLDivElement>('settings-modal')
const settingsClose = $<HTMLButtonElement>('settings-close')
const relayInput = $<HTMLInputElement>('relay')
const namespaceInput = $<HTMLInputElement>('namespace')
const qualityInput = $<HTMLInputElement>('quality')

// --- Human-friendly quality labels -----------------------------------------
// The catalog track names are hd/med/low; a product shows resolutions, not internal
// track ids. Fall back to the raw name for anything unmapped.
const QUALITY_LABELS: Record<string, string> = {
  hd: '720p HD',
  med: '480p',
  low: '360p',
}
const label = (name: QualityName): string => QUALITY_LABELS[name] ?? name

// --- Config defaults (overridable via URL query params) ---------------------
const params = new URLSearchParams(window.location.search)
const paramRelay = params.get('relay')
const paramNs = params.get('ns') ?? params.get('namespace')
const paramQuality = params.get('quality')
if (paramRelay) relayInput.value = paramRelay
if (paramNs) namespaceInput.value = paramNs
if (paramQuality) qualityInput.value = paramQuality

let viewer: Viewer | null = null
let lastStatus: ViewerStatus | null = null

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
// Overlay states (pre-roll connect / loading / error)
// ---------------------------------------------------------------------------
type OverlayState = 'connect' | 'loading' | 'error' | 'hidden'
function setOverlay(state: OverlayState, detail?: string): void {
  overlay.hidden = state === 'hidden'
  overlayConnect.hidden = state !== 'connect'
  overlayLoading.hidden = state !== 'loading'
  overlayError.hidden = state !== 'error'
  if (state === 'loading' && detail) loadingText.textContent = detail
  if (state === 'error' && detail) errorText.textContent = detail
}

// ---------------------------------------------------------------------------
// Viewer callbacks
// ---------------------------------------------------------------------------
function report(status: ViewerStatus, detail?: string): void {
  console.log(`[viewer] ${detail ? `${status} — ${detail}` : status}`)

  // Drive the pre-roll/loading overlay from the lifecycle phases.
  if (status === 'connecting') setOverlay('loading', 'Connecting to relay…')
  else if (status === 'discovering') setOverlay('loading', 'Discovering stream…')
  else if (status === 'subscribing') setOverlay('loading', 'Joining live…')
  else if (status === 'buffering') setOverlay('loading', 'Buffering…')
  else if (status === 'playing') setOverlay('hidden')

  // Toast the user-facing transitions (not every internal phase).
  if (status === 'switching' && detail) toast(`Switching to ${label(detail)}…`)
  if (status === 'playing' && lastStatus === 'switching') {
    const cur = viewer?.currentQuality
    if (cur) toast(`Now playing ${label(cur)}`)
  }

  lastStatus = status
  renderQualityMenu()
  renderLiveBadge()
}

function reportError(error: ViewerError): void {
  console.error('[viewer]', error)
  toast(error.message, true)
  // Fatal start-phase errors surface in the center overlay; mid-playback errors
  // (switch rejected, transient render) just toast and keep the current view.
  if (lastStatus === 'connecting' || lastStatus === 'discovering' || lastStatus === 'subscribing') {
    setOverlay('error', error.message)
  }
  renderQualityMenu()
  renderLiveBadge()
}

// ---------------------------------------------------------------------------
// Quality gear menu (Req 6.1–6.4)
// ---------------------------------------------------------------------------
function renderQualityMenu(): void {
  if (!viewer) {
    menuItems.replaceChildren()
    gearBtn.hidden = true
    return
  }
  gearBtn.hidden = false

  const qualities = viewer.availableQualities
  const current = viewer.currentQuality
  const pending = viewer.pendingQuality
  const switching = pending !== null

  menuItems.replaceChildren()
  for (const name of qualities) {
    const item = document.createElement('button')
    item.className = 'menu-item'
    const isActive = name === current && !switching
    const isPending = name === pending

    const left = document.createElement('span')
    left.textContent = label(name)
    item.appendChild(left)

    const right = document.createElement('span')
    if (isPending) {
      right.className = 'mini-spin'
    } else if (isActive) {
      right.className = 'check'
      right.textContent = '✓'
    }
    item.appendChild(right)

    // Req 6.4: while a switch is in flight the whole menu is inert — the authoritative
    // no-overlap guard is the QualityController's `busy` state; the UI just reflects it.
    item.disabled = switching
    item.addEventListener('click', () => void onPick(name))
    menuItems.appendChild(item)
  }
}

async function onPick(name: QualityName): Promise<void> {
  if (!viewer) return
  // Close the menu for a product feel; the switch resolves at the next group boundary.
  menu.hidden = true
  await viewer.selectQuality(name)
  renderQualityMenu()
}

// Gear menu open/close
gearBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  menu.hidden = !menu.hidden
})
document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target as Node) && e.target !== gearBtn) {
    menu.hidden = true
  }
})

// ---------------------------------------------------------------------------
// LIVE badge + GO LIVE pill (behind-live detection)
// ---------------------------------------------------------------------------
// How far behind the buffered live edge counts as "behind" (scrubbed back).
const BEHIND_LIVE_SECONDS = 2.0

function liveEdge(): number | null {
  const b = video.buffered
  if (b.length === 0) return null
  return b.end(b.length - 1)
}

function behindBy(): number {
  const edge = liveEdge()
  if (edge === null) return 0
  return Math.max(0, edge - video.currentTime)
}

function renderLiveBadge(): void {
  if (!viewer || lastStatus === null || lastStatus === 'stopped' || lastStatus === 'error') {
    livePill.hidden = true
    latPill.hidden = true
    viewersPill.hidden = true
    goLiveBtn.hidden = true
    return
  }
  livePill.hidden = false
  latPill.hidden = false
  viewersPill.hidden = false

  const behind = behindBy()
  const isBehind = behind > BEHIND_LIVE_SECONDS
  livePill.classList.toggle('live', !isBehind)
  livePill.classList.toggle('behind', isBehind)
  liveText.textContent = isBehind ? `BEHIND ${behind.toFixed(0)}s` : 'LIVE'
  goLiveBtn.hidden = !isBehind
}

goLiveBtn.addEventListener('click', () => {
  viewer?.jumpToLive()
  renderLiveBadge()
})

// ---------------------------------------------------------------------------
// Stats (HUD latency pill + optional "Stats for nerds" panel)
// ---------------------------------------------------------------------------
let statsTimer: number | null = null
let lastResolution = ''
let lastDecoded = 0
let lastSampleMs = 0
let statsVisible = false

// Glass-to-glass latency (seconds). Prefer the REAL capture→display latency the Viewer
// derives from the Broadcaster's wall-clock capture-epoch extension header; fall back to
// the buffered-ahead proxy (how far behind the live edge the playhead sits) when the
// header isn't present yet or the broadcast doesn't carry it.
function latencySeconds(): number {
  const real = viewer?.lastLatencyMs
  if (real !== null && real !== undefined) return real / 1000
  return behindBy()
}
function latencyIsReal(): boolean {
  return viewer?.lastLatencyMs != null
}

function tick(): void {
  // HUD latency pill (always, while playing).
  const lat = latencySeconds()
  latNum.textContent = `${lat.toFixed(1)}s`
  renderLiveBadge()

  if (!statsVisible) return

  // Resolution (decoded frame size) — flips the instant a switch commits.
  const w = video.videoWidth
  const h = video.videoHeight
  const res = w > 0 && h > 0 ? `${w}×${h}` : '—'
  statResEl.textContent = res
  if (res !== lastResolution && lastResolution !== '' && res !== '—') {
    statResEl.classList.remove('changed')
    void statResEl.offsetWidth
    statResEl.classList.add('changed')
  }
  lastResolution = res

  statLatEl.textContent = latencyIsReal() ? `${lat.toFixed(2)} s` : `~${lat.toFixed(2)} s (buffer)`
  statBufEl.textContent = `${behindBy().toFixed(2)} s`

  const q = video.getVideoPlaybackQuality?.()
  if (q) {
    statDropEl.textContent = `${q.droppedVideoFrames} / ${q.totalVideoFrames}`
    const now = performance.now()
    const decoded = q.totalVideoFrames
    if (lastSampleMs > 0) {
      const dt = (now - lastSampleMs) / 1000
      const df = decoded - lastDecoded
      statFpsEl.textContent = dt > 0 ? `${(df / dt).toFixed(0)} fps` : '—'
    }
    lastDecoded = decoded
    lastSampleMs = now
  } else {
    statDropEl.textContent = 'n/a'
    statFpsEl.textContent = 'n/a'
  }

  statTrackEl.textContent = viewer?.currentQuality ? label(viewer.currentQuality) : '—'
}

function startTicker(): void {
  lastResolution = ''
  lastDecoded = 0
  lastSampleMs = 0
  tick()
  statsTimer = window.setInterval(tick, 500)
}
function stopTicker(): void {
  if (statsTimer !== null) {
    clearInterval(statsTimer)
    statsTimer = null
  }
}

statsToggle.addEventListener('click', () => {
  statsVisible = !statsVisible
  statsEl.hidden = !statsVisible
})

// ---------------------------------------------------------------------------
// Settings (connection) modal
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
// Connect / stop
// ---------------------------------------------------------------------------
async function connect(): Promise<void> {
  const namespace = namespaceInput.value
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const quality = qualityInput.value.trim()

  const config: ViewerConfig = {
    relayUrl: relayInput.value.trim(),
    namespace,
    videoElement: video,
    onStatus: report,
    onError: reportError,
  }
  if (quality.length > 0) config.initialQuality = quality

  viewer = new Viewer(config)
  setOverlay('loading', 'Connecting…')
  stopBtn.disabled = false

  try {
    await viewer.start()
    renderQualityMenu()
    renderLiveBadge()
    startTicker()
  } catch (err) {
    console.error('[viewer] start failed:', err)
    const message = err instanceof Error ? err.message : 'Failed to connect'
    setOverlay('error', message)
    viewer = null
    stopBtn.disabled = true
    stopTicker()
    renderQualityMenu()
    renderLiveBadge()
  }
}

connectBtn.addEventListener('click', () => void connect())
retryBtn.addEventListener('click', () => void connect())

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true
  try {
    await viewer?.stop()
  } catch (err) {
    console.error('[viewer] stop failed:', err)
  } finally {
    viewer = null
    lastStatus = 'stopped'
    stopTicker()
    renderQualityMenu()
    renderLiveBadge()
    setOverlay('connect')
    toast('Stream stopped')
  }
})
