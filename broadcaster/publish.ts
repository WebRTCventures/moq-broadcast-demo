// Broadcaster orchestrator for the moq-broadcaster (see design.md "publish.ts").
//
// This file owns the broadcast session: it connects to the relay, announces the
// namespace, captures the webcam, drives three independent per-quality
// encoder+muxer pipelines, publishes each as a live MoQ track, and tears down on
// stop. Task 4 defines only the quality ladder and encoder configuration (the data
// models/config); the Broadcaster class skeleton and lifecycle methods are layered
// on in tasks 5.1 onward.

import {
  FullTrackName,
  LiveTrackSource,
  Location,
  MoqtObject,
  MOQtailClient,
  ObjectForwardingPreference,
  RequestError,
  Tuple,
} from 'moqtail'
import type { CMSF } from 'moqtail'
import { CMAFMuxer } from '../moqtail/apps/client-js/src/lib/cmaf-muxer.ts'
import { assignFrame, newGroupCounter, packageObject } from './grouping.ts'
import type { GroupCounter } from './grouping.ts'

/**
 * One of exactly three quality levels (Req 3.1). The broadcaster publishes no
 * fewer and no more than these three tracks.
 */
export type QualityName = 'hd' | 'med' | 'low'

/**
 * Fixed per-quality encoder settings. The resolution and bitrate values are the
 * ones specified in Req 3.4/3.5 and are never altered at runtime (Req 3.6).
 */
export interface QualityConfig {
  name: QualityName
  width: number
  height: number
  bitrate: number // bits per second
}

/** Broadcaster lifecycle status, reported via `BroadcasterConfig.onStatus`. */
export type BroadcasterStatus = 'connecting' | 'announced' | 'capturing' | 'publishing' | 'error' | 'stopped'

/** Configuration supplied when constructing a Broadcaster. */
export interface BroadcasterConfig {
  relayUrl: string // e.g. "https://localhost:4433"
  namespace: string[] // announced via Tuple.fromUtf8Path(namespace.join('/'))
  connectTimeoutMs?: number // default 10_000 (Req 1.2)
  onStatus?: (status: BroadcasterStatus, detail?: string) => void
  // Optional local monitor: if provided, the acquired camera MediaStream is attached to
  // this <video> so the operator sees exactly what is being published. UI-only; it does
  // not affect capture, encoding, or publish. The stream's tracks are stopped during
  // teardown as before, so the preview goes black on stop.
  previewElement?: HTMLVideoElement
}

/** Fixed capture/encode cadence shared by all three quality tracks. */
export const FRAMERATE = 30 // frames per second (Req 3.3)
export const GOP_FRAMES = 60 // keyframe every 2 s at 30 fps (Req 4.1)
export const CODEC = 'avc1.640028' // H.264 High Profile Level 4.0, reused across all three (disclosed shortcut, Req 3.2)

/** Catalog re-publish cadence (Req 12.4). The current CMSF document is enqueued once per interval. */
export const CATALOG_INTERVAL_MS = 1000

/**
 * Base64-encode a byte buffer for the Catalog's per-track `initData` (Req 12.3). The CMAF init
 * segment (`moov`) can be large, so the bytes are walked in 32 KiB chunks and converted via
 * `String.fromCharCode` before `btoa` — the chunked pattern from the reference `publisher.ts` that
 * avoids a call-stack overflow from spreading a very large buffer into `String.fromCharCode`.
 */
export function toBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}

/**
 * The fixed quality ladder (Req 3.1, 3.4–3.6). Exactly three entries: `hd`, `med`,
 * and `low`. Declared `readonly` with `as const` so it is never mutated at runtime
 * (Req 3.6) — the resolution and bitrate values are the same on every run.
 */
export const QUALITY_LADDER: readonly QualityConfig[] = [
  { name: 'hd', width: 1280, height: 720, bitrate: 2_500_000 },
  { name: 'med', width: 854, height: 480, bitrate: 1_000_000 },
  { name: 'low', width: 640, height: 360, bitrate: 500_000 },
] as const

/**
 * Distinct accent color per quality, burned into the frame by {@link Broadcaster.drawQualityOverlay}
 * so a switch is visually obvious. Traffic-light intuition: hd = green (best), med = amber,
 * low = red (lowest bitrate). A demo aid, not part of the protocol.
 */
export const QUALITY_COLORS: Readonly<Record<string, string>> = {
  hd: '#22c55e',
  med: '#f59e0b',
  low: '#ef4444',
} as const

/**
 * Build the WebCodecs encoder configuration for one quality level. All three share
 * the same codec string, framerate, realtime latency mode, and annexB-free `avc`
 * format; only the resolution and bitrate differ per quality (Req 3.2–3.5).
 */
export function encoderConfig(q: QualityConfig): VideoEncoderConfig {
  return {
    codec: CODEC,
    width: q.width,
    height: q.height,
    bitrate: q.bitrate,
    framerate: FRAMERATE,
    latencyMode: 'realtime',
    avc: { format: 'avc' },
  }
}

// ─── Error types ─────────────────────────────────────────────────────────────

/**
 * Thrown when the relay rejects the namespace announcement at the protocol level.
 * `publishNamespace` resolves with a `RequestError` (it does not throw) on a
 * protocol-level rejection, so `start()` wraps that returned error in this type to
 * drive the connection/announce error path (Req 1.4).
 */
export class AnnounceRejectedError extends Error {
  constructor(public readonly requestError: RequestError) {
    super(`namespace announce rejected: code=${requestError.errorCode} reason="${requestError.reasonPhrase.phrase}"`)
    this.name = 'AnnounceRejectedError'
  }
}

/**
 * Thrown when the camera cannot be acquired (permission denied or no device). Used
 * by the camera-capture step added in task 6.1 to stop the start sequence before
 * any track is announced (Req 2.4).
 */
export class CameraAcquisitionError extends Error {
  constructor(cause: unknown) {
    super(`camera acquisition failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'CameraAcquisitionError'
    this.cause = cause
  }
}

/**
 * Thrown when the relay rejects a track publish at the protocol level. Like
 * `publishNamespace`, `publish` returns a `RequestError` on protocol-level
 * rejection rather than throwing; the live-track registration step added in task
 * 7.1 wraps that returned error here, naming the affected Quality_Track (Req 9.3).
 * The track parameter is widened to also admit the `'catalog'` discovery track
 * (Req 12.1), which is registered through the same publish path.
 */
export class PublishRejectedError extends Error {
  constructor(
    public readonly track: QualityName | 'catalog',
    public readonly requestError: RequestError,
  ) {
    super(
      `publish rejected for track "${track}": code=${requestError.errorCode} reason="${requestError.reasonPhrase.phrase}"`,
    )
    this.name = 'PublishRejectedError'
  }
}

// ─── Per-track runtime state ──────────────────────────────────────────────────

/**
 * Per-track runtime state owned by the Broadcaster — one instance per
 * Quality_Track. The encoder/muxer/counter wiring is populated by the
 * live-registration and encode steps (tasks 7.1/8.1/8.2); this interface declares
 * the full shape so those tasks can slot in without re-declaring it.
 */
export interface TrackPipeline {
  name: QualityName
  ftn: FullTrackName
  controller: ReadableStreamDefaultController<MoqtObject>
  encoder: VideoEncoder
  muxer: CMAFMuxer
  counter: GroupCounter // from grouping.ts
  frameCount: number // drives the keyFrame cadence (Req 4)
  config: QualityConfig
  closed: boolean // set when the stream is closed (Req 11.2)
  /**
   * The base64-encoded CMAF init segment (`moov`) for this track, or `null` until the muxer emits
   * it. Captured once via `muxer.onInit` after the first keyframe encodes, then stamped into this
   * track's Catalog entry on the next catalog re-publish (Req 12.3).
   */
  initData: string | null
}

/**
 * Runtime state for the `catalog` discovery track (Req 12). Unlike a Quality_Track it has no
 * encoder/muxer/counter: it carries a single CMSF JSON Object per re-publish, built inline (not via
 * the Decision-1 grouping path), so it only needs its Full_Track_Name, its live-stream controller,
 * and a closed flag.
 */
export interface CatalogPipeline {
  ftn: FullTrackName
  controller: ReadableStreamDefaultController<MoqtObject>
  closed: boolean
}

// ─── Connect timeout helper ───────────────────────────────────────────────────

/**
 * Race a promise against a timeout. Resolves/rejects with the wrapped promise if it
 * settles first; otherwise rejects with a timeout error once `timeoutMs` elapses.
 *
 * Used to bound the relay connect (`MOQtailClient.new`) to the 10 s connect budget
 * (Req 1.2). The budget intentionally covers WebTransport readiness *and* the MoQ
 * SETUP exchange, because `MOQtailClient.new` awaits both before resolving. On
 * timeout the connect promise is abandoned and `start()` proceeds to the error path
 * without announcing (Req 1.4). The timer is always cleared so a settled promise
 * never leaves a dangling timeout.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

// ─── Broadcaster orchestrator ─────────────────────────────────────────────────

/**
 * Owns one broadcast session: connect → announce → acquire camera →
 * register+publish three tracks → run → teardown. Task 5.1 implements the connect
 * and announce lifecycle in `start()` (Req 1.1–1.4); camera capture, live track
 * registration, the encode/grouping wiring, and teardown are layered on in later
 * tasks (6.1/7.1/8.1/8.2/9.1).
 */
export class Broadcaster {
  private readonly config: BroadcasterConfig
  /** The relay client, set once `MOQtailClient.new` resolves within the budget. */
  private client: MOQtailClient | null = null
  /** True once the namespace has been announced (gates teardown behavior, Req 1.5/1.6). */
  private announced = false
  /** The acquired camera MediaStream; its video track is stopped during teardown (Req 2.1). */
  private cameraStream: MediaStream | null = null
  /** Handle to the MediaStreamTrackProcessor reader loop; `stop()` ends the loop (Req 2.1). */
  private reader: { processor: unknown; stop: () => void } | null = null
  /** True once teardown has begun; gates frame fan-out and enqueue (Req 11.4). */
  private stopped = false
  /**
   * The three per-quality pipelines, keyed by Quality_Track name (Req 3.1). One
   * entry per `QUALITY_LADDER` quality, populated by `setupTrack` during `start()`.
   * The counters are independent per track (Req 5.6).
   */
  private readonly tracks = new Map<QualityName, TrackPipeline>()
  /**
   * Per-track scaling canvases, created lazily on first frame and reused for every
   * subsequent frame (Req 3.4). Keyed by Quality_Track name; each canvas is sized to
   * that quality's resolution so the shared camera frame can be scaled independently
   * per encoder without re-allocating a canvas each frame.
   */
  private readonly scaleContexts = new Map<QualityName, OffscreenCanvasRenderingContext2D>()
  /**
   * The CMSF discovery document (Req 12.2), built once in `start()` with one entry per
   * Quality_Track. Each entry's `initData` is filled in asynchronously as that track's muxer emits
   * its init segment (Req 12.3), and the whole document is re-published periodically (Req 12.4).
   */
  private cmsf: CMSF = { version: 1, tracks: [] }
  /** The `catalog` track runtime state, set once it is registered+published in `start()` (Req 12.1). */
  private catalogPipe: CatalogPipeline | null = null
  /** Monotonic groupId for catalog Objects; each re-publish uses a fresh group at objectId 0 (Req 12.4). */
  private catalogGroupId = 0n
  /** Handle for the periodic catalog re-publish timer; cleared during teardown (Req 12.6). */
  private catalogInterval: ReturnType<typeof setInterval> | null = null

  constructor(config: BroadcasterConfig) {
    this.config = config
  }

  /** Report a lifecycle status change, if a listener was configured. */
  private onStatus(status: BroadcasterStatus, detail?: string): void {
    this.config.onStatus?.(status, detail)
  }

  /**
   * Connect to the relay and announce the namespace (Req 1.1–1.4).
   *
   * 1. Report `connecting`.
   * 2. `withTimeout(MOQtailClient.new({ url }), connectTimeoutMs ?? 10_000)` — a
   *    WebTransport/SETUP failure or a 10 s timeout rejects here and is routed to
   *    the error path with no announce (Req 1.1, 1.2, 1.4).
   * 3. `publishNamespace(Tuple.fromUtf8Path(namespace.join('/')))`; the return value
   *    is checked for `RequestError` because a protocol-level rejection is returned,
   *    not thrown — a `RequestError` becomes an `AnnounceRejectedError` (Req 1.3, 1.4).
   * 4. Report `announced` and set the `announced` flag.
   *
   * On any failure the error is reported via `onStatus('error', …)` and rethrown so
   * the caller can stop; the start sequence is aborted without announcing. Camera
   * acquisition, track registration, and running are added by later tasks.
   */
  async start(): Promise<void> {
    if (this.announced) {
      throw new Error('Broadcaster already started')
    }
    try {
      this.onStatus('connecting')
      this.client = await withTimeout(
        MOQtailClient.new({ url: this.config.relayUrl }),
        this.config.connectTimeoutMs ?? 10_000,
      )

      const ns = Tuple.fromUtf8Path(this.config.namespace.join('/'))
      const res = await this.client.publishNamespace(ns)
      if (res instanceof RequestError) {
        throw new AnnounceRejectedError(res)
      }

      this.onStatus('announced')
      this.announced = true

      // Acquire the camera (Req 2.1, 2.4). This runs after the namespace is
      // announced but before any track is registered/published, so a camera
      // failure aborts the start sequence before any `addOrUpdateTrack`/`publish`
      // (see design.md data-flow step 2).
      await this.acquireCamera()

      // Register and publish each of the three Quality_Tracks as a live content
      // source (Req 9.1–9.3). Each quality gets its own live ReadableStream,
      // client-assigned alias, VideoEncoder, and CMAFMuxer. The encode/grouping
      // wiring that feeds these streams is layered on in tasks 8.1/8.2.
      for (const quality of QUALITY_LADDER) {
        const pipeline = await this.setupTrack(quality)
        this.tracks.set(quality.name, pipeline)
      }

      // Build the CMSF discovery document, one entry per Quality_Track (Req 12.2). `initData` is
      // intentionally omitted here — it is filled in by each muxer's `onInit` once that track's first
      // keyframe encodes (Req 12.3), and converges across the periodic re-publishes (Req 12.4).
      this.cmsf = {
        version: 1,
        tracks: QUALITY_LADDER.map((q) => ({
          name: q.name,
          role: 'video',
          packaging: 'cmaf',
          codec: CODEC,
          width: q.width,
          height: q.height,
        })),
      }

      // Register and publish the `catalog` discovery track through the same live content-source path
      // as the Quality_Tracks, after all three are registered (Req 12.1). This makes the three tracks
      // discoverable by a stock, catalog-driven Subscriber (Req 10.1).
      this.catalogPipe = await this.setupCatalogTrack()

      this.onStatus('publishing')

      // Begin the periodic catalog re-publish (Req 12.4) and emit the first catalog immediately so an
      // early Subscriber sees it without waiting a full interval.
      this.catalogInterval = setInterval(() => this.publishCatalogOnce(), CATALOG_INTERVAL_MS)
      this.publishCatalogOnce()

      // The encode/grouping wiring (tasks 8.1/8.2) and running are layered on next.
    } catch (err) {
      this.onStatus('error', err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  /**
   * Acquire the single camera source and wire the frame reader (Req 2.1, 2.4, 2.5).
   *
   * - `getUserMedia({ video: true })` yields one `MediaStream`. A rejection
   *   (permission denied or no device) is wrapped in a `CameraAcquisitionError`,
   *   reported via `onStatus('error', …)`, and thrown so `start()` aborts before
   *   any track is announced (Req 2.4).
   * - On success a single `MediaStreamTrackProcessor` reader (via `makeTrackReader`)
   *   routes every `VideoFrame` to `onCameraFrame` as a continuous live stream
   *   (Req 2.1, 2.2).
   * - An `'ended'` listener on the camera track reports camera loss and begins
   *   teardown if the device is disconnected mid-broadcast (Req 2.5).
   */
  private async acquireCamera(): Promise<void> {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true }) // Req 2.1
    } catch (err) {
      // Req 2.4: report the camera acquisition failure and stop the start
      // sequence before any addOrUpdateTrack/publish.
      throw new CameraAcquisitionError(err)
    }

    this.cameraStream = stream
    const track = stream.getVideoTracks()[0]

    // Local monitor (UI-only): mirror the acquired stream into the optional preview
    // element so the operator sees the camera they are publishing. Muted autoplay avoids
    // feedback and autoplay-policy blocks. Does not affect the publish pipeline.
    if (this.config.previewElement) {
      const el = this.config.previewElement
      el.srcObject = stream
      el.muted = true
      void el.play().catch(() => {
        // Autoplay can reject on some policies; the operator can click the element to
        // start it. The publish pipeline is unaffected either way.
      })
    }

    // Req 2.5: if the source ends while active (e.g. device disconnected), report
    // the camera loss and begin teardown.
    track.addEventListener('ended', () => this.onCameraLost())

    // Req 2.1/2.2: read frames continuously via MediaStreamTrackProcessor and fan
    // each one out to the encoders. No looping or restart behavior.
    this.reader = this.makeTrackReader(track, (frame) => this.onCameraFrame(frame))

    this.onStatus('capturing')
  }

  /**
   * Register and publish one Quality_Track as a live content source — Decision 2,
   * the SUBSCRIBE (live) path, not FETCH (Req 9.1–9.3).
   *
   * 1. Build the Full_Track_Name `FullTrackName.tryNew(namespace, name)` (Req 9.1).
   * 2. Create a `ReadableStream<MoqtObject>` and capture its controller; the encode
   *    wiring (task 8.2) enqueues objects onto this stream.
   * 3. `addOrUpdateTrack({ fullTrackName, trackSource: { live: new LiveTrackSource(stream) },
   *    publisherPriority: 1 })` — supplying content via `trackSource.live` is what
   *    makes this the live (SUBSCRIBE-path) delivery mode (Req 9.2). The call is
   *    local and synchronous and assigns a client-side `random60bitId` alias when
   *    none is supplied, so the three tracks get distinct aliases (Req 9.3).
   * 4. Read the client-assigned alias back as a `bigint` from
   *    `client.trackSources.get(ftn.toString()).trackAlias`, then
   *    `await publish(ftn, true, trackAlias)` (forward=true). A protocol-level
   *    rejection is *returned* as a `RequestError` (not thrown), so the result is
   *    checked and wrapped in a `PublishRejectedError` naming the track (Req 9.3).
   * 5. Create the quality's `VideoEncoder` (via `encoderConfig`) and `CMAFMuxer`
   *    (the muxer fragments one encoded frame per emitted segment, Req 5.1/5.2) and
   *    initialize the pipeline's grouping counter, frame counter, and closed flag.
   *
   * The encoder `output` handler and `muxer.onSegment` wiring belong to tasks
   * 8.1/8.2; the encoder/muxer objects are created here, with the output/onSegment
   * hookup left as a placeholder for those tasks.
   */
  private async setupTrack(quality: QualityConfig): Promise<TrackPipeline> {
    const { name } = quality
    const ftn = FullTrackName.tryNew(this.config.namespace.join('/'), name) // Req 9.1

    // Capture the stream controller so the encode wiring (task 8.2) can enqueue
    // objects onto this track's live ReadableStream.
    let controller!: ReadableStreamDefaultController<MoqtObject>
    const stream = new ReadableStream<MoqtObject>({
      start: (c) => {
        controller = c
      },
    })

    // Register the track with a live content source (Req 9.2). Local + synchronous;
    // assigns a distinct client-side alias when none is supplied (Req 9.3).
    this.client!.addOrUpdateTrack({
      fullTrackName: ftn,
      trackSource: { live: new LiveTrackSource(stream) },
      publisherPriority: 1,
    })

    // Read the client-assigned alias back as a bigint and publish with forward=true
    // (Req 9.3). A protocol-level rejection is returned as a RequestError.
    const track = this.client!.trackSources.get(ftn.toString())!
    const pub = await this.client!.publish(ftn, true, track.trackAlias!)
    if (pub instanceof RequestError) {
      throw new PublishRejectedError(name, pub)
    }

    // Create this quality's own encoder and muxer (Req 3.7, 5.1, 5.2). The muxer is
    // configured internally with nbSamplesPerFragment=1, so each emitted segment
    // carries exactly one encoded frame.
    const muxer = new CMAFMuxer()

    // Each emitted CMAF segment becomes exactly one MoqtObject (Req 5.1, 5.2). This
    // is the single place a frame turns into an object: assign group/object/priority
    // from the *emitted* keyframe flag (Req 4.4, 5.6, 6.1, 7.1), package it (Req
    // 5.1/8.1), then enqueue onto the track's live stream in non-decreasing
    // (groupId, objectId) order (Req 9.4). Grouping follows `evt.isKey` (the actual
    // emitted chunk type), not the requested cadence (Req 4.4).
    muxer.onSegment = (evt) => {
      const pipe = this.tracks.get(name)
      // Skip once the track's stream is closed or teardown has begun — never
      // enqueue after teardown (Req 11.4). `pipe` is absent only before this
      // pipeline is registered, when no frames flow yet.
      if (!pipe || pipe.closed || this.stopped) return

      const assignment = assignFrame(pipe.counter, evt.isKey) // Req 4.4, 5.4–5.6, 6.1, 7.1
      // Stamp the wall-clock capture epoch (ms) at segment time, right before enqueue.
      // Encode→mux is synchronous and sub-frame, so Date.now() here is an accurate
      // "captured at" moment for the viewer's glass-to-glass latency readout.
      const obj = packageObject(pipe.ftn, assignment, evt.timestamp, evt.data, Date.now()) // Req 5.1, 5.2, 8.1
      try {
        pipe.controller.enqueue(obj) // Req 9.4 — (groupId, objectId) non-decreasing
      } catch {
        // The stream is closed: drop this object for the affected track only and
        // keep the other two tracks running (Req 11.2).
        pipe.closed = true
        this.onStatus('error', `${name}: stream closed, dropping object`)
      }
    }

    // The muxer defers its internal init until the first keyframe arrives with a
    // decoder-config description, and self-initializes at a default 1280x720 — wrong
    // for med/low. Supply this track's own resolution via `initVideo` on the first
    // keyframe (guarded to run once) before `addVideoChunk`, so each track's muxer
    // is sized correctly (Req 5.2). The init segment (onInit/moov) is intentionally
    // left as the muxer's default no-op: per design.md the object stream carries only
    // the per-frame CMAF segment payloads from `onSegment`, so the moov is not
    // enqueued as a MoqtObject.
    let muxerInitialized = false
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (this.stopped) return
        if (!muxerInitialized && chunk.type === 'key' && meta?.decoderConfig?.description) {
          muxerInitialized = true
          muxer.initVideo(quality.width, quality.height, meta.decoderConfig.description as ArrayBuffer)
        }
        muxer.addVideoChunk(chunk, meta)
      },
      error: (e) => {
        // Req 11.1: a VideoEncoder error faults only this Quality_Track. Report an
        // error naming the affected track and mark *only* this pipeline closed so
        // its onSegment enqueue path stops; the other two pipelines keep running
        // and the broadcaster is not torn down. Nothing is reported once teardown
        // has begun (Req 11.4).
        if (this.stopped) return
        this.onStatus('error', `${name} VideoEncoder error: ${e.message}`)
        const pipe = this.tracks.get(name)
        if (pipe) pipe.closed = true
      },
    })
    encoder.configure(encoderConfig(quality))

    const pipe: TrackPipeline = {
      name,
      ftn,
      controller,
      encoder,
      muxer,
      counter: newGroupCounter(),
      frameCount: 0,
      config: quality,
      closed: false,
      initData: null,
    }

    // Capture this track's CMAF init segment (`moov`) for the Catalog (Req 12.3). The muxer fires
    // `onInit` exactly once, after `initVideo` runs on the first keyframe; base64-encode the moov and
    // store it on the pipeline so the next catalog re-publish can stamp it into this track's entry.
    // The init segment is only ever carried inside the Catalog, never as a media Object.
    muxer.onInit = (moov) => {
      pipe.initData = toBase64(moov)
    }

    return pipe
  }

  /**
   * Register and publish the `catalog` discovery track (Req 12.1). Reuses the same live
   * content-source mechanics as `setupTrack` — build the Full_Track_Name, capture a
   * `ReadableStream<MoqtObject>` controller, `addOrUpdateTrack` with `trackSource.live`, read the
   * client-assigned alias back, and `publish` — but with Publisher_Priority `0` (higher priority than
   * any Quality_Track, which use `1`) and no encoder/muxer/counter: the catalog carries only the
   * periodically-rebuilt CMSF JSON Object (Req 12.4/12.5), not media frames.
   *
   * A protocol-level publish rejection is *returned* as a `RequestError` (not thrown), so the result
   * is checked and wrapped in a `PublishRejectedError` naming the `'catalog'` track.
   */
  private async setupCatalogTrack(): Promise<CatalogPipeline> {
    const ftn = FullTrackName.tryNew(this.config.namespace.join('/'), 'catalog') // Req 12.1

    let controller!: ReadableStreamDefaultController<MoqtObject>
    const stream = new ReadableStream<MoqtObject>({
      start: (c) => {
        controller = c
      },
    })

    // Priority 0 — higher priority than any Quality_Track so discovery metadata is favored (Req 12.1).
    this.client!.addOrUpdateTrack({
      fullTrackName: ftn,
      trackSource: { live: new LiveTrackSource(stream) },
      publisherPriority: 0,
    })

    const track = this.client!.trackSources.get(ftn.toString())!
    const pub = await this.client!.publish(ftn, true, track.trackAlias!)
    if (pub instanceof RequestError) {
      throw new PublishRejectedError('catalog', pub)
    }

    return { ftn, controller, closed: false }
  }

  /**
   * Enqueue the current CMSF document as a single Catalog Object (Req 12.4/12.5). Called once
   * immediately after registration and then on the `CATALOG_INTERVAL_MS` timer.
   *
   * - Skips entirely once teardown has begun or the catalog stream is closed (Req 12.6) — no Catalog
   *   Object is enqueued after teardown.
   * - Stamps each Quality_Track's latest `initData` into the matching CMSF entry, so the document
   *   converges to a complete catalog as init segments become available (Req 12.3/12.4).
   * - Builds the Object inline with Publisher_Priority `0`, `ObjectForwardingPreference.Subgroup`, and
   *   `null` extension headers — it is NOT routed through `assignFrame`/`packageObject`, so it carries
   *   no keyframe marking or capture-timestamp header (Req 12.5).
   * - Uses a fresh, incrementing `groupId` at `objectId` 0 each time (Req 12.4).
   */
  private publishCatalogOnce(): void {
    if (this.stopped || !this.catalogPipe || this.catalogPipe.closed) return

    // Stamp the latest init segments into the catalog entries (Req 12.3).
    for (const pipe of this.tracks.values()) {
      if (pipe.initData) {
        const entry = this.cmsf.tracks.find((t) => t.name === pipe.name)
        if (entry) entry.initData = pipe.initData
      }
    }

    const payload = new TextEncoder().encode(JSON.stringify(this.cmsf))
    const obj = MoqtObject.newWithPayload(
      this.catalogPipe.ftn,
      new Location(this.catalogGroupId, 0n), // one object at objectId 0 of a fresh group (Req 12.4)
      0, // Publisher_Priority 0 (Req 12.1)
      ObjectForwardingPreference.Subgroup, // Req 12.5
      0n, // subgroupId 0
      null, // no extension headers (Req 12.5)
      payload,
    )
    this.catalogGroupId++

    try {
      this.catalogPipe.controller.enqueue(obj)
    } catch {
      // The catalog stream is closed: stop enqueuing to it. Teardown closes it explicitly; this guard
      // also covers a controller that closed out from under the interval.
      this.catalogPipe.closed = true
    }
  }

  /**
   * Read `VideoFrame`s from a `MediaStreamTrack` via `MediaStreamTrackProcessor`,
   * routing each frame to `onFrame`. Mirrors the reference publisher's
   * `makeTrackReader` pattern (`moqtail/apps/client-js/src/lib/publisher.ts`).
   *
   * Returns a handle whose `stop()` ends the read loop and cancels the reader; the
   * loop also exits naturally when the underlying track ends (`done`). This is the
   * single reader for the one acquired camera source (Req 2.1).
   */
  private makeTrackReader(
    track: MediaStreamTrack,
    onFrame: (f: VideoFrame) => void,
  ): { processor: unknown; stop: () => void } {
    // @ts-expect-error - MediaStreamTrackProcessor is Chromium-only (Req 2.3)
    const processor = new MediaStreamTrackProcessor({ track })
    const reader: ReadableStreamDefaultReader<VideoFrame> = processor.readable.getReader()
    let running = true
    const read = async (): Promise<void> => {
      while (running) {
        const { value, done } = await reader.read()
        if (done || !value) break
        onFrame(value)
      }
    }
    void read()
    return {
      processor,
      stop: () => {
        running = false
        void reader.cancel()
      },
    }
  }

  /**
   * Fan one camera frame out to all three encoders as a continuous live stream
   * (Req 2.2, 4.1–4.3, 8.1).
   *
   * For each pipeline:
   * - Decide the keyframe cadence from the per-track frame counter:
   *   `isKey = frameCount % 60 === 0`, so the first frame (index 0) is forced to a
   *   keyframe and every 60th frame thereafter requests one (Req 4.1–4.3). This is
   *   only a *request*; the actual GOP boundary is decided downstream from the
   *   emitted chunk type (Req 4.4, wired in task 8.2).
   * - Scale the source frame to the pipeline's configured resolution via a
   *   per-pipeline `OffscreenCanvas` draw (the technique `publisher.ts` uses for its
   *   screen/embed paths), producing a fresh `VideoFrame` for the encoder — or pass
   *   the source frame natively when it already matches the target size, avoiding an
   *   unnecessary copy.
   * - `encoder.encode(scaled, { keyFrame: isKey })`, then increment `frameCount`.
   * - Close each intermediate scaled `VideoFrame` to avoid leaks (the native
   *   passthrough frame is the source frame, which is closed once after fan-out).
   *
   * The source frame's `timestamp` is captured for the capture-timestamp extension
   * header; the actual header attachment happens in the muxer `onSegment` wiring
   * (task 8.2), which carries the segment's own timestamp through the CMAF segment
   * event. Here the timestamp is read before the frame is closed so a native
   * passthrough frame's timestamp survives.
   *
   * Frames are fed as a continuous live stream — there is no looping,
   * buffering-to-restart, or replay (Req 2.2). When teardown has begun the frame is
   * closed and dropped without encoding (Req 11.4).
   */
  private onCameraFrame(frame: VideoFrame): void {
    // No-op once stopped: drop the frame without encoding so the reader loop does
    // not leak it, and never enqueue work after teardown begins (Req 11.4).
    if (this.stopped) {
      frame.close()
      return
    }

    // Capture the source frame's media-timeline timestamp (µs) for the per-object
    // capture-timestamp header (Req 8.1). Read before any close so a native
    // passthrough frame's timestamp is still valid.
    const timestamp = frame.timestamp

    for (const pipe of this.tracks.values()) {
      if (pipe.closed) continue

      // Keyframe cadence: frame 0 forced key, then every 60th frame (Req 4.1–4.3).
      const isKey = pipe.frameCount % GOP_FRAMES === 0

      // Always route each quality through its per-pipeline OffscreenCanvas: scale the
      // source frame to this track's resolution (Req 3.4) AND burn in a per-quality
      // overlay (name, resolution, bitrate, distinct colored border/badge). The overlay
      // makes a quality switch obvious in the picture itself — a downscaled-then-
      // upscaled webcam at hd/med/low looks nearly identical on screen, so the baked-in
      // label + color is what makes Decision 4 visible to the eye. (We route even the
      // native-size track through the canvas so all three carry a consistent overlay.)
      const ctx = this.scaleContext(pipe)
      ctx.drawImage(frame, 0, 0, pipe.config.width, pipe.config.height)
      this.drawQualityOverlay(ctx, pipe.config)
      const scaled = new VideoFrame(ctx.canvas, { timestamp, alpha: 'discard' })

      pipe.encoder.encode(scaled, { keyFrame: isKey })
      pipe.frameCount++

      // Close the scaled frame to avoid leaks; the source frame is closed once after
      // the fan-out below.
      scaled.close()
    }

    // Close the source frame exactly once after fanning it out to every pipeline.
    frame.close()
  }

  /**
   * Lazily create and reuse this pipeline's scaling `OffscreenCanvas` context. Each
   * Quality_Track scales to its own resolution, so each pipeline keeps its own
   * canvas sized to `config.{width,height}`; it is created on first use and reused
   * for every subsequent frame to avoid per-frame allocation.
   */
  private scaleContext(pipe: TrackPipeline): OffscreenCanvasRenderingContext2D {
    let ctx = this.scaleContexts.get(pipe.name)
    if (!ctx) {
      const canvas = new OffscreenCanvas(pipe.config.width, pipe.config.height)
      ctx = canvas.getContext('2d')!
      this.scaleContexts.set(pipe.name, ctx)
    }
    return ctx
  }

  /**
   * Burn a per-quality overlay into the (already scaled) frame on the canvas, BEFORE it
   * is wrapped in a VideoFrame and encoded. Each quality gets a distinct accent color, a
   * full-frame border, and a badge reading its name + resolution + bitrate. Because the
   * overlay is baked into the encoded pixels, a quality switch is instantly obvious in
   * the picture (the color and label change), which a plain downscaled webcam would not
   * make visible. This is a demo aid; it is drawn on every quality so all three are
   * visually distinct. Sizes scale with the track width so the badge is legible at
   * 640-wide and 1280-wide alike.
   */
  private drawQualityOverlay(ctx: OffscreenCanvasRenderingContext2D, cfg: QualityConfig): void {
    const { width: w, height: h, name, bitrate } = cfg
    const accent = QUALITY_COLORS[name] ?? '#ffffff'
    const scale = w / 640 // badge/border sizing relative to the smallest track

    // Full-frame accent border — the most peripherally-obvious signal of the active track.
    const border = Math.max(4, Math.round(8 * scale))
    ctx.strokeStyle = accent
    ctx.lineWidth = border
    ctx.strokeRect(border / 2, border / 2, w - border, h - border)

    // Badge box in the top-left with the quality name, resolution, and bitrate.
    const pad = Math.round(10 * scale)
    const fontPx = Math.round(26 * scale)
    const label = `${name.toUpperCase()}  ${w}×${h}  ${(bitrate / 1_000_000).toFixed(1)} Mbps`
    ctx.font = `700 ${fontPx}px ui-sans-serif, system-ui, sans-serif`
    ctx.textBaseline = 'top'
    const textW = ctx.measureText(label).width
    const boxW = textW + pad * 2
    const boxH = fontPx + pad * 2
    const boxX = border + Math.round(6 * scale)
    const boxY = border + Math.round(6 * scale)

    // Semi-opaque dark plate for contrast, with an accent left edge.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
    ctx.fillRect(boxX, boxY, boxW, boxH)
    ctx.fillStyle = accent
    ctx.fillRect(boxX, boxY, Math.max(4, Math.round(6 * scale)), boxH)

    // The label text.
    ctx.fillStyle = '#ffffff'
    ctx.fillText(label, boxX + pad, boxY + pad)
  }

  /**
   * Handle loss of the camera source mid-broadcast (Req 2.5). Report the camera
   * loss and begin best-effort teardown.
   */
  private onCameraLost(): void {
    this.onStatus('error', 'camera source ended')
    void this.stop()
  }

  /**
   * Best-effort, idempotent teardown (Req 1.5, 1.6, 11.3, 11.4).
   *
   * Guarded by the `stopped` flag so repeated calls (e.g. an explicit `stop()`
   * racing the camera-loss path) run the teardown exactly once. The flag is set
   * *first*, before anything is closed, so `onCameraFrame` and the muxer `onSegment`
   * handlers stop encoding and enqueuing immediately — no Object is produced after
   * teardown begins (Req 11.4).
   *
   * Teardown order follows design.md step 8:
   *   1. stop the frame reader (end the camera read loop)
   *   2. `encoder.close()` for all three pipelines (Req 11.3)
   *   3. `controller.close()` for all three track streams (Req 11.4)
   *   4. stop the camera `MediaStream` tracks (release the device, Req 2.5)
   *   5. if the namespace was announced, best-effort `publishNamespaceDone` (Req 1.5)
   *   6. `client.disconnect()` to release the relay connection (Req 1.6, 11.4)
   *
   * Each step is wrapped in try/catch so one failure never blocks the rest — in
   * particular `publishNamespaceDone` self-disconnects and rethrows on a send
   * failure, so its throw must not prevent the subsequent `disconnect` (Req 1.5).
   * `disconnect` is idempotent, so it is safe to call even after a
   * `publishNamespaceDone`-triggered self-disconnect. When nothing was ever
   * announced, `publishNamespaceDone` is skipped entirely (Req 1.6).
   */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true // Req 11.4 — set first so no further frames/objects flow

    // 0. Stop the catalog re-publish interval and close the catalog stream (Req 12.6). Done first,
    //    alongside setting `stopped`, so the timer callback cannot enqueue another Catalog Object
    //    after teardown begins. The controller close is guarded because it may already be closed.
    if (this.catalogInterval) {
      clearInterval(this.catalogInterval)
      this.catalogInterval = null
    }
    if (this.catalogPipe) {
      this.catalogPipe.closed = true
      try {
        this.catalogPipe.controller.close()
      } catch {
        // ignore — controller may already be closed
      }
    }

    // 1. End the camera read loop so no more frames are fanned out.
    try {
      this.reader?.stop()
    } catch {
      // ignore — teardown is best-effort
    }

    // 2. Close every VideoEncoder (Req 11.3). close() can throw if already
    //    closed/errored, so guard each one and keep going.
    for (const pipe of this.tracks.values()) {
      try {
        pipe.encoder.close()
      } catch {
        // ignore — encoder may already be closed/errored
      }
    }

    // 3. Close every track stream controller (Req 11.4). Mark the pipeline closed
    //    first so any in-flight onSegment drops its object instead of enqueuing.
    for (const pipe of this.tracks.values()) {
      pipe.closed = true
      try {
        pipe.controller.close()
      } catch {
        // ignore — controller may already be closed
      }
    }

    // 4. Stop the camera MediaStream tracks so the device is released (Req 2.5).
    try {
      this.cameraStream?.getTracks().forEach((t) => t.stop())
    } catch {
      // ignore
    }

    // 5. If the namespace was announced, best-effort PublishNamespaceDone (Req 1.5).
    //    Skipped entirely if nothing was announced (Req 1.6). Its failure must NOT
    //    block the disconnect below — note it self-disconnects and rethrows on a
    //    send failure, which the surrounding try/catch absorbs.
    if (this.announced && this.client) {
      try {
        const ns = Tuple.fromUtf8Path(this.config.namespace.join('/'))
        await this.client.publishNamespaceDone(ns)
      } catch {
        // ignore — best-effort; proceed to disconnect regardless (Req 1.5)
      }
    }

    // 6. Release the relay connection (Req 1.6, 11.4). disconnect() is idempotent,
    //    so it is safe even after a publishNamespaceDone self-disconnect.
    try {
      await this.client?.disconnect()
    } catch {
      // ignore — connection may already be gone
    }

    this.onStatus('stopped')
  }
}
