// viewer/subscribe.ts — the Viewer orchestrator (connect, catalog discovery,
// join-late subscribe, single-SourceBuffer MSE render loop, group-boundary quality
// switch, best-effort teardown).
//
// This file is the config/types/skeleton established by task 4. The method bodies
// (start / selectQuality / stop and the render loop) are filled in by later tasks:
//   - connect + catalog discovery      -> task 5
//   - join-late subscribe              -> task 6
//   - MSE render loop                  -> task 7
//   - group-boundary quality switch    -> task 8
//   - error reporting + teardown       -> task 11
// Only the shapes required to typecheck are defined here; the stubs throw / no-op so
// the module compiles under strict + noUnusedLocals/Parameters.
//
// Requirements: 1.1, 4.1, 8.3

import { MOQtailClient } from 'moqtail/client'
import { FilterType, FullTrackName, GroupOrder, Tuple, TupleField } from 'moqtail'
import type { MoqtObject } from 'moqtail'
import { CMSFCatalog, RequestError } from 'moqtail/model'
import { QualityController } from './quality.ts'
import type { QualityName } from './quality.ts'

/**
 * Custom extension-header type id carrying the Broadcaster's wall-clock capture epoch
 * (ms). MUST match `WALLCLOCK_CAPTURE_EPOCH_MS_TYPE` in broadcaster/grouping.ts. The
 * viewer subtracts this epoch from its own `Date.now()` to compute glass-to-glass
 * latency (accurate when both share a clock — same machine or NTP-synced hosts).
 */
const WALLCLOCK_CAPTURE_EPOCH_MS_TYPE = 20n
/** EMA smoothing factor for the latency readout (0..1; higher = snappier). */
const LATENCY_EMA_ALPHA = 0.2

// ---------------------------------------------------------------------------
// Config & status
// ---------------------------------------------------------------------------

/**
 * Lifecycle status reported to the UI via {@link ViewerConfig.onStatus}. Mirrors the
 * data-flow stages: connect -> discover -> subscribe -> buffer -> play, with
 * `switching` during a quality switch and the terminal `error` / `stopped` states.
 */
export type ViewerStatus =
  | 'connecting'
  | 'discovering'
  | 'subscribing'
  | 'buffering'
  | 'playing'
  | 'switching'
  | 'error'
  | 'stopped'

/**
 * All configuration for a single viewing session. Only `relayUrl`, `namespace`, and
 * `videoElement` are required; the rest carry the design defaults.
 */
export interface ViewerConfig {
  /** The relay's WebTransport URL, e.g. "https://localhost:4433". */
  relayUrl: string
  /** The same MoQ namespace tuple (as string parts) the Broadcaster announced. */
  namespace: string[]
  /** The track rendered at start. Default `'med'`. */
  initialQuality?: QualityName
  /** Budget for connect + SETUP before the connection is treated as failed (Req 1.2). Default `10_000`. */
  connectTimeoutMs?: number
  /** Budget for catalog discovery, incl. waiting for late `initData` (Req 2.2). Default `5_000`. */
  catalogTimeoutMs?: number
  /** Seconds of media buffered before first play; also the live-edge target (Req 4.5). Default `1.0`. */
  targetBufferSeconds?: number
  /** Enable the optional telemetry panel (Req 8.3). Default `false`. */
  enableTelemetry?: boolean
  /** The `<video>` element to render into (the Media_Element). */
  videoElement: HTMLVideoElement
  /** Called on each lifecycle status transition; `detail` carries e.g. the target track. */
  onStatus?: (status: ViewerStatus, detail?: string) => void
  /** Called when a recoverable or terminal error is reported (Req 3.3, 4.2, 5.3, 5.6, 9.1). */
  onError?: (error: ViewerError) => void
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Base class for every error the Viewer surfaces through {@link ViewerConfig.onError}.
 * Each concrete subclass identifies the failing operation and carries the fields a
 * caller needs to diagnose it (the affected track and/or the underlying library
 * `RequestError`).
 */
export abstract class ViewerError extends Error {
  protected constructor(message: string) {
    super(message)
    // Preserve the concrete subclass name across the Error -> subclass chain.
    this.name = new.target.name
  }
}

/**
 * The relay rejected the WebTransport/SETUP connection, or the connect budget
 * elapsed (Req 1.2, 1.3). Carries the optional underlying cause.
 */
export class ConnectError extends ViewerError {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

/**
 * The catalog could not be retrieved within the discovery budget, or its stream
 * closed before a usable catalog (with the chosen track's `initData`) was read
 * (Req 2.2, 2.5). No track is subscribed when this is reported.
 */
export class DiscoveryError extends ViewerError {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

/**
 * `client.subscribe` returned a protocol-level rejection for a join-late subscribe
 * (Req 3.3). Identifies the failing track by name and carries the library's
 * `RequestError`.
 */
export class SubscribeRejectedError extends ViewerError {
  constructor(
    readonly track: QualityName,
    readonly requestError: RequestError,
  ) {
    super(
      `subscribe rejected for track "${track}": ` +
        `code ${requestError.errorCode} ${requestError.reasonPhrase.phrase}`,
    )
  }
}

/**
 * The MIME type derived from a track's role + codec is not supported by MSE, or the
 * role/codec was missing from the catalog (Req 4.2). Carries the offending MIME.
 */
export class UnsupportedMimeError extends ViewerError {
  constructor(readonly mime: string) {
    super(`unsupported MIME type: ${mime}`)
  }
}

/**
 * `client.switch` returned a protocol-level rejection for a quality switch (Req 5.3).
 * Identifies the target track and carries the library's `RequestError`; the current
 * track keeps playing unchanged.
 */
export class SwitchRejectedError extends ViewerError {
  constructor(
    readonly track: QualityName,
    readonly requestError: RequestError,
  ) {
    super(
      `switch rejected to track "${track}": ` +
        `code ${requestError.errorCode} ${requestError.reasonPhrase.phrase}`,
    )
  }
}

/**
 * A requested track (initial or switch target) is not present in the catalog
 * (Req 5.6). Identifies the unknown track; the current track keeps playing.
 */
export class UnknownTrackError extends ViewerError {
  constructor(readonly track: QualityName) {
    super(`unknown track: "${track}" is not present in the catalog`)
  }
}

/**
 * The subscription stream errored or closed unexpectedly, or appending to the
 * SourceBuffer failed past its retry budget, while rendering (Req 9.1, 9.2).
 * Identifies the affected track; rendering of that track stops without crashing.
 */
export class RenderError extends ViewerError {
  constructor(
    readonly track: QualityName,
    message: string,
    readonly cause?: unknown,
  ) {
    super(`render error for track "${track}": ${message}`)
  }
}

// ---------------------------------------------------------------------------
// Internal subscription / switch state
// ---------------------------------------------------------------------------

/** The single active subscription (one at a time); the stream is reused across a switch. */
export interface ActiveSubscription {
  track: QualityName
  requestId: bigint
  stream: ReadableStream<MoqtObject>
}

/** A quality switch armed on the control plane, applied by the render loop at the next keyframe. */
export interface PendingSwitch {
  track: QualityName
  mime: string
  initAppended: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reject with a `TimeoutError` if `promise` has not settled within `ms`, otherwise
 * resolve/reject with the promise's own outcome. Used to bound connect (Req 1.2) and
 * catalog discovery (Req 2.2). The timer is cleared on settle so it never leaks.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`operation timed out after ${ms}ms`))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

// ---------------------------------------------------------------------------
// Viewer orchestrator (skeleton — bodies filled by tasks 5–8, 11)
// ---------------------------------------------------------------------------

export class Viewer {
  private readonly config: ViewerConfig

  // The MoQ namespace tuple the Broadcaster published under, built once from the
  // configured string parts the same way the Broadcaster builds it
  // (`Tuple.fromUtf8Path(namespace.join('/'))`), so the viewer's full track names
  // match the broadcast's exactly. Used for both `FullTrackName.tryNew` (catalog +
  // quality tracks) and the QualityController.
  private readonly namespaceTuple: Tuple

  // Connection + discovery state.
  private client: MOQtailClient | null = null
  private catalog: CMSFCatalog | null = null

  // Decision-4 switching policy. Constructed lazily in start() once the catalog's
  // track-name set is known (the design builds the QualityController from the catalog
  // during start), so it is null until then.
  private qc: QualityController | null = null

  // Active subscription state (one at a time).
  private currentRequestId: bigint | null = null
  private currentStream: ReadableStream<MoqtObject> | null = null

  // MSE render state. A single MediaSource/SourceBuffer is reused across switches so
  // the media timeline stays continuous.
  private mse: MediaSource = new MediaSource()
  private sourceBuffer: SourceBuffer | null = null
  private currentMime: string | null = null

  // Switch-boundary latch, armed by selectQuality and applied in the render loop at
  // the next objectId===0 keyframe.
  private pendingSwitch: PendingSwitch | null = null

  // Live-edge start latch. The render loop seeks to the buffered end and calls
  // play() exactly once, the first time the buffered duration crosses
  // `targetBufferSeconds` (Req 4.5, 7.3); subsequent objects just keep appending.
  private playbackStarted = false

  // Smoothed glass-to-glass latency (ms): `Date.now()` at append minus the
  // Broadcaster's wall-clock capture epoch header, EMA-smoothed. Null until the first
  // object carrying the header is appended, or if the broadcast omits it.
  private latencyMsEma: number | null = null

  // Render-pipe lifetime + teardown guard.
  private renderAbort: AbortController = new AbortController()
  private stopped = false

  constructor(config: ViewerConfig) {
    this.config = config
    // Build the namespace tuple from the string parts (each part is one tuple
    // field), matching the Broadcaster's `Tuple.fromUtf8Path(namespace.join('/'))`.
    this.namespaceTuple = new Tuple(config.namespace.map((part) => TupleField.fromUtf8(part)))
  }

  /**
   * connect -> discover catalog -> subscribe join-late -> attach MSE -> render
   * (Req 1, 2, 3, 4). Implemented by tasks 5–7.
   */
  async start(): Promise<void> {
    // --- Connect (Req 1.1, 1.2, 1.3) -------------------------------------------
    // Report 'connecting', then establish the WebTransport + MoQ SETUP connection,
    // bounded by the connect budget. `MOQtailClient.new` awaits both WebTransport
    // readiness and the control-stream SETUP handshake, so a transport/SETUP failure
    // rejects here, and a hang is cut off by `withTimeout`. Either way we report a
    // ConnectError and stop the start sequence WITHOUT attempting catalog retrieval.
    this.report('connecting')
    try {
      this.client = await withTimeout(
        MOQtailClient.new({ url: this.config.relayUrl }),
        this.config.connectTimeoutMs ?? 10_000,
      )
    } catch (cause) {
      // Req 1.3: identify the connection failure and stop — no discovery.
      this.fail(new ConnectError(`failed to connect to relay at ${this.config.relayUrl}`, cause))
      return
    }

    // --- Discover (Req 2.1, 2.2, 2.3, 2.5) -------------------------------------
    // Report 'discovering', then retrieve the catalog by SUBSCRIBE and build the
    // QualityController once the selectable track set is known. A discovery failure
    // (timeout / early close / never-usable catalog) reports a DiscoveryError and
    // stops the start sequence without subscribing to any quality track.
    this.report('discovering')
    try {
      this.catalog = await this.retrieveCatalog()
    } catch (cause) {
      if (cause instanceof DiscoveryError) {
        this.fail(cause)
      } else {
        this.fail(new DiscoveryError('failed to retrieve the catalog', cause))
      }
      return
    }

    // Build the Decision-4 switching policy from the catalog's video track names and
    // the configured initial quality (default 'med'). `availableQualities` now
    // reflects exactly the catalog entries (Req 2.3).
    const trackNames = this.catalog.getTracks('video').map((t) => t.name)
    this.qc = new QualityController(
      this.namespaceTuple,
      new Set(trackNames),
      this.config.initialQuality ?? 'med',
    )

    // --- Subscribe join-late (Req 2.3, 2.4, 3.1–3.5) --------------------------
    // Validate the initial quality against the catalog and, if usable, subscribe to
    // it at the next group boundary (FilterType.NextGroupStart — Decision 3). A
    // validation failure or a subscribe RequestError reports an error, stops the
    // start sequence, and renders nothing. On success currentRequestId/currentStream
    // are set and left ready for the MSE attach + render loop (task 7).
    try {
      await this.subscribeTrack(this.config.initialQuality ?? 'med')
    } catch (error) {
      if (error instanceof ViewerError) {
        this.fail(error)
      } else {
        this.fail(new SubscribeRejectedError(this.config.initialQuality ?? 'med', error as RequestError))
      }
      return
    }

    // --- Attach MSE + init segment (Req 4.1, 4.2, 4.3) ------------------------
    // With the join-late subscription live, attach the MediaSource to the <video>
    // element, create the single SourceBuffer for the chosen track's MIME, and append
    // its init segment once (task 7.1). An unsupported MIME or a missing init segment
    // reports an UnsupportedMimeError and stops rendering that track (Req 4.2); any
    // other MSE failure is reported as a RenderError for the track. On success the
    // SourceBuffer + currentMime are set and currentStream is ready for the render
    // loop, which start() kicks off in the background immediately below.
    try {
      await this.attachAndInit(this.config.initialQuality ?? 'med')
    } catch (error) {
      if (error instanceof ViewerError) {
        this.fail(error)
      } else {
        this.fail(
          new RenderError(
            this.config.initialQuality ?? 'med',
            'failed to attach MediaSource / append init segment',
            error,
          ),
        )
      }
      return
    }

    // --- Render loop (Req 4.4–4.6, 7.1–7.3, 9.1, 9.2) ------------------------
    // The join-late subscription is live and the SourceBuffer is primed with the init
    // segment. Kick off the render loop that pipes `currentStream` into a
    // WritableStream<MoqtObject>, appending media objects and starting playback at the
    // live edge once enough is buffered.
    //
    // The pipe is started in the BACKGROUND (not awaited): it only settles when the
    // subscription stream ends, errors, or the render pipe is aborted by stop(), so
    // awaiting it here would make start() hang for the whole viewing session. Running
    // it detached lets start() resolve once the viewer has been brought to the point
    // of rendering (connected + subscribed + MSE primed + loop running); the loop then
    // drives the transition to 'buffering'/'playing' as objects arrive. Any error from
    // the detached pipe is routed to onError via a RenderError (Req 9.1), so a failing
    // background loop never produces an unhandled rejection.
    const stream = this.currentStream
    if (!stream) {
      // Defensive: subscribeTrack sets currentStream on success, so this should not
      // happen after a successful attach. Treat a missing stream as a render failure.
      this.fail(
        new RenderError(
          this.config.initialQuality ?? 'med',
          'no subscription stream available to render',
        ),
      )
      return
    }
    void this.runRenderLoop(stream, this.config.initialQuality ?? 'med')
  }

  /**
   * Decide whether appending `b` keeps the appended position moving forward relative
   * to the previously appended object `a` (Req 7.2) — the reference player's
   * `isInOrder` rule, verbatim:
   *
   *   - a Group's first object (`object === 0n`) is a keyframe/RAP, so it is always in
   *     order (lets a new Group start even if its group id is lower, e.g. after a
   *     switch);
   *   - otherwise a strictly later Group is in order, a strictly earlier Group is not;
   *   - within the same Group, a strictly later object id is in order.
   *
   * The render loop discards any object for which this returns `false`, favoring
   * forward progress over stalling on a backward-ordered object.
   */
  private isInOrder(a: MoqtObject, b: MoqtObject): boolean {
    // First objects are most likely to be RAPs (keyframes).
    if (b.location.object === 0n) return true
    if (a.location.group < b.location.group) return true
    if (a.location.group > b.location.group) return false
    return a.location.object < b.location.object
  }

  /**
   * The single-SourceBuffer MSE render loop (Req 4.4–4.6, 7.1–7.3, 9.1, 9.2).
   *
   * Pipes the subscription `stream` into a `WritableStream<MoqtObject>` guarded by
   * `renderAbort`. Per delivered object the `write` handler:
   *
   *   1. returns early if the viewer is `stopped` or the render pipe was aborted
   *      (Req 9.4) — nothing is appended after teardown begins;
   *   2. skips end-of-group marker objects (`isEndOfGroup()`) (Req 4.4);
   *   3. skips any object whose `payload?.buffer` is not an `ArrayBuffer` — status
   *      objects carry a `null` payload (the reference-player guard);
   *   4. discards a backward-ordered object via {@link isInOrder} relative to the last
   *      appended object, favoring forward progress (Req 7.2);
   *   5. otherwise appends `object.payload.buffer` with a BOUNDED retry loop
   *      ({@link appendAndWait}); on repeated failure it errors the stream controller
   *      so the pipe rejects and a {@link RenderError} is reported — no infinite stall
   *      (Req 9.2).
   *
   * After a successful append it checks the buffered range: once the buffered duration
   * crosses `targetBufferSeconds` for the first time, it seeks the video element to the
   * buffered END (the live edge, not the start) and calls `play()`, reporting
   * `buffering` then `playing` (Req 4.5, 7.3). It keeps appending for as long as the
   * subscription delivers (Req 4.6).
   *
   * The pipe is driven with `pipeTo(..., { signal: renderAbort.signal })`. A clean
   * stream close resolves it (normal end of delivery); a stream error, a bounded-retry
   * failure, or any other append failure rejects it and is reported as a RenderError
   * identifying the affected track, stopping rendering without crashing (Req 9.1).
   * An abort (from `stop()`) is swallowed — it is intentional teardown, not an error.
   */
  private async runRenderLoop(
    stream: ReadableStream<MoqtObject>,
    initialTrack: QualityName,
  ): Promise<void> {
    // Max consecutive appendBuffer attempts for a single object before giving up and
    // reporting a RenderError (Req 9.2). Matches the reference player's bound of 5.
    const MAX_APPEND_RETRIES = 5

    // The track name a RenderError should identify: the quality CURRENTLY rendered.
    // The QualityController's committed `current` is the source of truth once the
    // switch wiring (task 8) updates it on each applied boundary; before any switch it
    // equals the initial quality. Fall back to the initial track if qc is unset.
    const currentTrack = (): QualityName => this.qc?.state.current ?? initialTrack

    // The last object actually appended, used for the forward-progress check (Req 7.2).
    let previousObject: MoqtObject | null = null

    // Set true the moment a switch commits at the boundary; consumed right after the
    // new track's keyframe is appended to snap the playhead to the live edge (so the
    // switch resumes smoothly rather than stalling on the brief re-init pause).
    let justSwitched = false

    // When the element stalls waiting for data (common for a beat right after a
    // group-boundary switch while the new init segment + keyframe are appended), snap
    // the playhead back to the live edge and resume instead of freezing on "loading".
    // Registered once per render loop; removed when the pipe settles (finally below).
    const onStall = (): void => this.catchUpToLiveEdge()
    this.config.videoElement.addEventListener('waiting', onStall)
    this.config.videoElement.addEventListener('stalled', onStall)

    const writable = new WritableStream<MoqtObject>({
      write: async (object, controller) => {
        // (1) Append nothing once teardown has begun (Req 9.4).
        if (this.stopped || this.renderAbort.signal.aborted) return

        // (2) Skip end-of-group marker objects (Req 4.4).
        if (object.isEndOfGroup()) return

        // (3) Skip status objects (null payload / non-ArrayBuffer) — reference guard.
        if (!(object.payload?.buffer instanceof ArrayBuffer)) return

        // (3b) Group-boundary quality switch (Decision 4, Req 5.4, 5.5, 6.4). If a
        // switch is armed and this object is the first of a Group (objectId 0, a
        // keyframe) — and not an end-of-group marker (already skipped at step 2) —
        // re-initialize the MSE parser for the TARGET track BEFORE appending this
        // object's media payload:
        //
        //   - changeType only if the derived MIME actually changes (gated). The demo's
        //     hd/med/low all share codec avc1.640028, so the MIME is identical and
        //     changeType will NOT fire; it is reserved for a future cross-codec track.
        //   - append the TARGET track's init segment (new moov) exactly once — the
        //     bytes from catalog.getInitData, already base64-decoded by the library.
        //   - clear the latch, commitSwitch() (this is where current = target and
        //     pending clears, re-enabling the next switch — Req 6.4 serialization),
        //     and report `playing`.
        //
        // The init segment is appended via the SAME single SourceBuffer so the media
        // timeline stays continuous; after it, control falls through to the normal
        // forward-progress + append of this same objectId===0 keyframe below (so the
        // keyframe is NOT skipped and the init segment is NOT double-appended).
        if (this.pendingSwitch && object.objectId === 0n) {
          const pending = this.pendingSwitch
          try {
            if (pending.mime !== this.currentMime) {
              this.sourceBuffer!.changeType(pending.mime)
              this.currentMime = pending.mime
            }
            if (!pending.initAppended) {
              const initSegment = this.catalog!.getInitData(pending.track)
              if (!initSegment) {
                throw new UnsupportedMimeError(
                  `${pending.mime} (track "${pending.track}" has no init segment)`,
                )
              }
              await this.appendAndWait(initSegment)
              pending.initAppended = true
            }
          } catch (cause) {
            // A failed re-init (changeType throw / init-segment append failure) stops
            // rendering the target track rather than appending media against a parser
            // that was never re-initialized (Req 9.2). Abort the switch so the
            // controller's current/pending are left consistent, then error the pipe.
            this.qc?.abortSwitch()
            this.pendingSwitch = null
            controller.error(
              cause instanceof RenderError
                ? cause
                : new RenderError(pending.track, `failed to re-initialize for switch`, cause),
            )
            return
          }
          // Re-init applied at the keyframe boundary — commit the switch (current =
          // target, pending cleared) and resume. The forward-progress check and media
          // append of THIS keyframe object happen below. Reset the forward-progress
          // reference so the new track's keyframe is never compared against the OLD
          // track's last object (a stale comparison that could wrongly discard it);
          // this objectId===0 keyframe becomes the new baseline.
          previousObject = null
          this.pendingSwitch = null
          this.qc?.commitSwitch()
          this.report('playing')
          justSwitched = true
        }

        // (4) Discard a backward-ordered object (forward progress, Req 7.2). The new
        // track's first object has objectId 0n, which isInOrder treats as always-in-
        // order, so a just-committed switch keyframe is never wrongly discarded.
        if (previousObject && !this.isInOrder(previousObject, object)) return
        previousObject = object

        // (5) Append with a bounded retry loop (Req 9.2). appendAndWait resolves on
        // `updateend` and rejects on the SourceBuffer `error` event or a throwing
        // appendBuffer; retry a small, bounded number of times before reporting a
        // RenderError so a persistently-failing append never stalls indefinitely.
        let appended = false
        let lastError: unknown
        for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt++) {
          // Re-check teardown between attempts so an abort mid-retry stops promptly.
          if (this.stopped || this.renderAbort.signal.aborted) return
          try {
            await this.appendAndWait(object.payload.buffer)
            appended = true
            break
          } catch (error) {
            lastError = error
          }
        }
        if (!appended) {
          // Bounded retries exhausted — abort the pipe so pipeTo rejects and the catch
          // below reports a RenderError for this track (no infinite stall, Req 9.2).
          controller.error(
            new RenderError(
              currentTrack(),
              `appendBuffer failed after ${MAX_APPEND_RETRIES} attempts`,
              lastError,
            ),
          )
          return
        }

        // Glass-to-glass latency: decode the Broadcaster's wall-clock capture epoch from
        // this object's extension headers and fold `now - epoch` into the EMA (Req 8.1).
        this.updateLatency(object)

        // Live-edge start: once enough is buffered, seek to the buffered END and play,
        // exactly once (Req 4.5, 7.3).
        this.maybeStartPlayback()

        // Just-committed switch: the new track's keyframe is now in the buffer. Snap
        // the playhead to the live edge so playback resumes immediately rather than
        // sitting on the brief re-init stall (the switch's visible-but-recoverable
        // moment, not a freeze).
        if (justSwitched) {
          justSwitched = false
          this.catchUpToLiveEdge()
        }
      },
    })

    try {
      await stream.pipeTo(writable, { signal: this.renderAbort.signal })
      // A clean close resolves the pipe: the subscription stopped delivering. This is
      // normal end-of-delivery, not an error — leave the current state as-is.
    } catch (error) {
      // An intentional abort from stop() is not an error (Req 9.4).
      if (this.renderAbort.signal.aborted) return
      // A RenderError already carries the track; otherwise wrap the stream/append
      // failure as a RenderError identifying the affected track (Req 9.1).
      const renderError =
        error instanceof RenderError
          ? error
          : new RenderError(currentTrack(), 'subscription stream errored while rendering', error)
      this.fail(renderError)
    } finally {
      // Detach the stall listeners when the render loop settles (clean close, error,
      // or abort) so they do not leak across a restart.
      this.config.videoElement.removeEventListener('waiting', onStall)
      this.config.videoElement.removeEventListener('stalled', onStall)
    }
  }

  /**
   * Start playback at the live edge the first time the buffered duration crosses
   * `targetBufferSeconds` (Req 4.5, 7.3). Computes the buffered range from
   * `sourceBuffer.buffered`; once `end - start` exceeds the target it reports
   * `buffering`, seeks `videoElement.currentTime` to the buffered END (the live edge,
   * NOT the start of the range), calls `play()`, and reports `playing`. Guarded by
   * `playbackStarted` so it fires exactly once; later objects just keep appending.
   */
  private maybeStartPlayback(): void {
    if (this.playbackStarted) return
    const sb = this.sourceBuffer
    if (!sb || sb.buffered.length === 0) return

    const start = sb.buffered.start(0)
    const end = sb.buffered.end(sb.buffered.length - 1)
    const bufferedSeconds = end - start
    const target = this.config.targetBufferSeconds ?? 1.0
    if (bufferedSeconds <= target) return

    // Threshold crossed — kick off playback at the live edge, exactly once.
    this.playbackStarted = true
    this.report('buffering')
    // Seek to the buffered END (live edge) rather than the start of the range.
    this.config.videoElement.currentTime = end
    this.report('playing')
    void this.config.videoElement.play().catch((cause) => {
      // play() can reject (e.g. autoplay policy). Surface it as a render error for the
      // current track without crashing; appends continue regardless.
      this.fail(
        new RenderError(this.qc?.state.current ?? (this.config.initialQuality ?? 'med'), 'play() was rejected', cause),
      )
    })
  }

  /**
   * Keep the playhead at the live edge of the buffered range (Req 4.5, 7.3).
   *
   * Unlike {@link maybeStartPlayback} (which runs once to kick off playback), this is
   * called repeatedly — after a group-boundary quality switch and whenever the element
   * stalls (`waiting`/`stalled`) — because a live single-SourceBuffer switch can briefly
   * leave the playhead behind the newly appended data: appending the target track's init
   * segment + keyframe takes a beat during which the old track's buffer can drain, and
   * the new track's media may begin a hair ahead of or behind `currentTime`. If the
   * playhead has fallen more than a small threshold behind the buffered end, seek it to
   * the live edge and resume play(), so the switch recovers instead of freezing on
   * "loading". A no-op before playback has started, when there is no buffered range, or
   * when the playhead is already near the live edge.
   */
  private catchUpToLiveEdge(): void {
    if (!this.playbackStarted || this.stopped) return
    const sb = this.sourceBuffer
    const video = this.config.videoElement
    if (!sb || sb.buffered.length === 0) return

    const end = sb.buffered.end(sb.buffered.length - 1)
    // If the playhead is behind the live edge by more than ~0.25s (or is sitting in a
    // gap with no buffered data at currentTime), snap it to the live edge. The small
    // threshold avoids fighting normal playback jitter.
    const BEHIND_THRESHOLD = 0.25
    if (end - video.currentTime > BEHIND_THRESHOLD) {
      video.currentTime = end
    }
    // If the element stalled (paused by the UA while waiting for data), resume.
    if (video.paused) {
      void video.play().catch(() => {
        // Autoplay/stall resume can reject transiently; appends continue and the next
        // waiting/stalled event will retry, so swallow rather than fault the track.
      })
    }
  }

  /**
   * Jump the playhead to the live edge of the buffered range and resume playback.
   *
   * The MSE SourceBuffer retains everything appended since start (sequence mode grows
   * one continuous range), so the `<video controls>` scrubber can seek backward through
   * that locally-buffered history — a side effect worth calling out: it is seek-within-
   * buffer, NOT a FETCH/VOD replay from the relay (which is out of scope). This method
   * is the "jump to live" escape hatch: after scrubbing back, snap forward to the newest
   * buffered position and play. Unlike {@link catchUpToLiveEdge} it is unconditional (no
   * behind-threshold guard) because the user explicitly asked to return to live. A no-op
   * if nothing is buffered yet.
   */
  jumpToLive(): void {
    const sb = this.sourceBuffer
    const video = this.config.videoElement
    if (!sb || sb.buffered.length === 0) return
    video.currentTime = sb.buffered.end(sb.buffered.length - 1)
    void video.play().catch(() => {
      // Resume can reject transiently (autoplay policy); harmless — the user can press
      // play on the native controls, and appends continue regardless.
    })
  }

  /**
   * Fold one object's glass-to-glass latency into the smoothed estimate (Req 8.1).
   * Reads the Broadcaster's wall-clock capture epoch (ms) from the object's extension
   * headers (type {@link WALLCLOCK_CAPTURE_EPOCH_MS_TYPE}) and computes `Date.now() -
   * epoch` — the end-to-end delay from capture to the moment the frame is appended for
   * display. The per-object sample is EMA-smoothed into `latencyMsEma` so the readout
   * is stable. A no-op if the object carries no such header (older/other broadcasters),
   * leaving the latency null so the UI falls back to its buffered-ahead proxy.
   *
   * Accuracy note: this is a true wall-clock delta, so it is only meaningful when the
   * Broadcaster and this viewer share a clock (same machine, or NTP-synced hosts).
   */
  private updateLatency(object: MoqtObject): void {
    const headers = object.extensionHeaders
    if (!headers) return
    let epochMs: number | null = null
    for (const kvp of headers) {
      if (kvp.typeValue === WALLCLOCK_CAPTURE_EPOCH_MS_TYPE && typeof kvp.value === 'bigint') {
        epochMs = Number(kvp.value)
        break
      }
    }
    if (epochMs === null) return
    const sample = Date.now() - epochMs
    // Guard against clock skew producing a negative/absurd sample; clamp at 0.
    const clamped = sample < 0 ? 0 : sample
    this.latencyMsEma =
      this.latencyMsEma === null
        ? clamped
        : LATENCY_EMA_ALPHA * clamped + (1 - LATENCY_EMA_ALPHA) * this.latencyMsEma
  }

  /**
   * Validate the initial quality against the catalog and subscribe to it join-late
   * at the next group boundary (Decision 3). The validation runs FIRST, before any
   * subscribe, so an invalid track subscribes nothing:
   *
   *   1. The track must be present in the catalog (role resolvable). An absent track
   *      -> {@link UnknownTrackError}.
   *   2. The track's packaging must be CMAF (`isCMAF`). A non-CMAF track ->
   *      {@link UnsupportedMimeError} (the viewer only knows how to render CMAF/MP4).
   *   3. The track's codec, role, and initData must all be available
   *      (`getCodecString` / `getRole` / `getInitData`). A missing one ->
   *      {@link UnsupportedMimeError}. (`getInitData` should already be present by the
   *      time discovery returned — Req 2.5 — but it is re-verified here so the render
   *      path never starts without an init segment.)
   *
   * Once validated, report `subscribing`, build the full track name, and call
   * `client.subscribe` with `FilterType.NextGroupStart` + `forward: true` +
   * `GroupOrder.Original` (Req 3.1). A returned `RequestError` becomes a
   * {@link SubscribeRejectedError} and nothing is rendered (Req 3.3). On success the
   * subscription's `requestId` + `stream` are stored for the render loop; the first
   * delivered Object is `objectId` 0 of the next Group — a keyframe (Req 3.4).
   *
   * `FilterType.AbsoluteStart` / `AbsoluteRange` are deliberately NOT used (Req 3.5).
   */
  private async subscribeTrack(track: QualityName): Promise<void> {
    const catalog = this.catalog
    if (!catalog) {
      throw new DiscoveryError('cannot subscribe before the catalog is retrieved')
    }

    // (1) Present in the catalog? getRole returns undefined for an unknown track.
    const role = catalog.getRole(track)
    if (role === undefined) {
      throw new UnknownTrackError(track)
    }

    // (2) CMAF packaging? The viewer only renders CMAF/MP4 segments.
    if (!catalog.isCMAF(track)) {
      throw new UnsupportedMimeError(`${role}/mp4 (track "${track}" is not CMAF)`)
    }

    // (3) codec / role / initData all available? getCodecString and getInitData throw
    // when the entry exists but lacks codec / initData; treat either as unsupported.
    let codec: string | undefined
    try {
      codec = catalog.getCodecString(track)
      // getInitData returns the init segment (already base64-decoded) or throws when
      // the entry lacks initData; a missing/empty init segment is not renderable.
      const initData = catalog.getInitData(track)
      if (!codec || !initData) {
        throw new UnsupportedMimeError(`${role}/mp4; codecs="${codec}"`)
      }
    } catch (cause) {
      if (cause instanceof ViewerError) throw cause
      throw new UnsupportedMimeError(`${role}/mp4; codecs="${codec}" (track "${track}" is missing codec/initData)`)
    }

    // Validation passed — now subscribe join-late at the next group boundary.
    this.report('subscribing', track)

    const ftn = FullTrackName.tryNew(this.namespaceTuple, new TextEncoder().encode(track))
    const res = await this.client!.subscribe({
      fullTrackName: ftn,
      groupOrder: GroupOrder.Original,
      filterType: FilterType.NextGroupStart, // Req 3.1 — THE join-late decision
      forward: true,
      priority: 0,
    })
    if (res instanceof RequestError) {
      // Req 3.3: identify the failing track by name + rejection reason; render nothing.
      throw new SubscribeRejectedError(track, res)
    }

    // Success — store the subscription for the render loop (task 7). The first Object
    // delivered is objectId 0 of the next Group (a keyframe) by virtue of
    // NextGroupStart, so decoding starts at a keyframe and not mid-GOP (Req 3.4).
    this.currentRequestId = res.requestId
    this.currentStream = res.stream
  }

  /**
   * Derive the MSE MIME type for `track` from the catalog's role + codec, as
   * `<role>/mp4; codecs="<codec>"` (Req 4.1). Both `getRole` and `getCodecString`
   * return `undefined` for an unknown track (and `getCodecString` throws when the
   * entry exists but lacks a codec), so this guards BOTH and throws
   * {@link UnsupportedMimeError} when either is missing — the viewer cannot build a
   * SourceBuffer without a role and a codec. Mirrors the reference player's
   * `#newSourceBufferMSE` role/codec guard.
   */
  private mimeFor(track: QualityName): string {
    const catalog = this.catalog
    if (!catalog) {
      throw new UnsupportedMimeError(`<unknown>/mp4 (catalog not retrieved for track "${track}")`)
    }
    const role = catalog.getRole(track)
    // getCodecString throws when the entry exists but lacks a codec; treat that the
    // same as a missing codec (unsupported), rather than letting it escape untyped.
    let codec: string | undefined
    try {
      codec = catalog.getCodecString(track)
    } catch {
      codec = undefined
    }
    if (!role || !codec) {
      throw new UnsupportedMimeError(`${role}/mp4; codecs="${codec}"`)
    }
    return `${role}/mp4; codecs="${codec}"`
  }

  /**
   * Resolve once the MediaSource reaches the `open` state so that
   * `addSourceBuffer` is legal. If the MediaSource is already `open` this resolves
   * immediately; otherwise it binds the MediaSource to the `<video>` element via
   * `URL.createObjectURL` (which is what drives it toward `open`) and waits for the
   * one-shot `sourceopen` event. The object URL is revoked inside the handler once
   * `sourceopen` fires — the browser retains the attachment, so revoking after open
   * frees the URL without detaching the source. Mirrors the reference player's
   * `#newSourceBufferMSE` sourceopen wait.
   */
  private ensureSourceOpen(): Promise<void> {
    const mse = this.mse
    if (mse.readyState === 'open') return Promise.resolve()
    return new Promise<void>((resolve) => {
      const onSourceOpen = () => {
        mse.removeEventListener('sourceopen', onSourceOpen)
        // Free the object URL now that the attachment is established; the browser
        // keeps the MediaSource bound to the element after sourceopen.
        try {
          URL.revokeObjectURL(this.config.videoElement.src)
        } catch {
          // best-effort; revocation failure must not block rendering
        }
        resolve()
      }
      mse.addEventListener('sourceopen', onSourceOpen)
      // Binding the MediaSource to the element is what transitions it to 'open'.
      this.config.videoElement.src = URL.createObjectURL(mse)
    })
  }

  /**
   * Append `data` to the single SourceBuffer and resolve on the next `updateend`,
   * rejecting if the SourceBuffer dispatches `error`. This is the one place the MSE
   * append-and-await-updateend handshake lives; the render loop (task 7.2) reuses it
   * for media objects. Mirrors the reference player's `waitForBufferUpdate`.
   */
  private appendAndWait(data: BufferSource): Promise<void> {
    const sb = this.sourceBuffer
    if (!sb) {
      return Promise.reject(new Error('cannot append before the SourceBuffer is created'))
    }
    return new Promise<void>((resolve, reject) => {
      const onUpdateEnd = () => {
        sb.removeEventListener('updateend', onUpdateEnd)
        sb.removeEventListener('error', onError)
        resolve()
      }
      const onError = () => {
        sb.removeEventListener('updateend', onUpdateEnd)
        sb.removeEventListener('error', onError)
        reject(new Error('SourceBuffer append failed'))
      }
      sb.addEventListener('updateend', onUpdateEnd, { once: true })
      sb.addEventListener('error', onError, { once: true })
      try {
        sb.appendBuffer(data)
      } catch (cause) {
        sb.removeEventListener('updateend', onUpdateEnd)
        sb.removeEventListener('error', onError)
        reject(cause)
      }
    })
  }

  /**
   * Attach the MediaSource to the `<video>` element, create the single SourceBuffer
   * for `track`, and append its init segment exactly once (Req 4.1, 4.2, 4.3):
   *
   *   1. Bind the MediaSource and wait for `sourceopen` ({@link ensureSourceOpen}), so
   *      `addSourceBuffer` happens only after the MediaSource is `open`.
   *   2. Derive the MIME via {@link mimeFor}; if `MediaSource.isTypeSupported` reports
   *      it unsupported, throw {@link UnsupportedMimeError} and render nothing for this
   *      track (Req 4.2).
   *   3. `addSourceBuffer(mime)` -> the single `sourceBuffer`; record `currentMime`
   *      (Req 4.1).
   *   4. Append the track's init segment — the bytes from `catalog.getInitData(track)`,
   *      which the library has ALREADY base64-decoded (do not decode again) — exactly
   *      once, awaiting `updateend` ({@link appendAndWait}) (Req 4.3).
   *
   * Called from `start()` after a successful join-late subscribe, before the render
   * loop (task 7.2). Uses only the standard MSE events (`sourceopen`, `updateend`) so
   * the design's stubbed MediaSource/SourceBuffer can drive it under vitest.
   */
  private async attachAndInit(track: QualityName): Promise<void> {
    const catalog = this.catalog
    if (!catalog) {
      throw new DiscoveryError('cannot attach media before the catalog is retrieved')
    }

    // (1) MediaSource must be 'open' before addSourceBuffer is legal.
    await this.ensureSourceOpen()

    // (2) Derive and validate the MIME (Req 4.1, 4.2).
    const mime = this.mimeFor(track)
    if (!MediaSource.isTypeSupported(mime)) {
      throw new UnsupportedMimeError(mime)
    }

    // (3) Create the single SourceBuffer and record its MIME (Req 4.1).
    this.sourceBuffer = this.mse.addSourceBuffer(mime)
    this.currentMime = mime

    // Use 'sequence' append mode (vs the default 'segments'). The three quality tracks
    // run on a SHARED capture timeline (the Broadcaster encodes the same source frame
    // with the same timestamp into every track), so after a quality switch the target
    // track's segments carry timestamps that OVERLAP the already-buffered old-track
    // range at roughly the current playhead. In 'segments' mode MSE honors those
    // absolute timestamps, so the overlapping append lands on top of the current
    // position and the element stalls on "loading" (the freeze). 'sequence' mode makes
    // MSE ignore the internal segment timestamps and place each appended segment
    // immediately AFTER the previously appended one, keeping one continuous, monotonic
    // buffered range across the switch — the standard MSE mechanism for a same-codec
    // representation change on a single SourceBuffer. It is set once here and applies to
    // the init segment and every media append, including the post-switch re-init.
    this.sourceBuffer.mode = 'sequence'

    // (4) Append the init segment exactly once. getInitData returns the CMAF init
    // segment ALREADY base64-decoded as a Uint8Array — append its bytes directly,
    // without decoding again (Req 4.3).
    const initSegment = catalog.getInitData(track)
    if (!initSegment) {
      throw new UnsupportedMimeError(`${mime} (track "${track}" has no init segment)`)
    }
    await this.appendAndWait(initSegment)
  }

  /**
   * Retrieve the Catalog by SUBSCRIBE (Req 2.1): subscribe to the `catalog` track
   * under the namespace (join-late, priority 0), read Objects from the stream, skip
   * end-of-group markers and null-payload status Objects, and parse the first usable
   * payload via `CMSFCatalog.from`. Because the Broadcaster fills each track's
   * `initData` in asynchronously (after that track's first keyframe) and re-publishes
   * the catalog ~every second, keep reading subsequent catalog Objects until the
   * initial quality's `initData` is present (Req 2.5). The whole operation is bounded
   * by the discovery budget; on timeout, early stream close, or a stream error before
   * a usable catalog is captured, throw a {@link DiscoveryError} and subscribe no
   * quality track (Req 2.2). The catalog subscription is unsubscribed once a usable
   * catalog is in hand.
   */
  private async retrieveCatalog(): Promise<CMSFCatalog> {
    const client = this.client
    if (!client) {
      throw new DiscoveryError('cannot retrieve catalog before the client is connected')
    }

    // Mirror the reference player's catalog SUBSCRIBE exactly: GroupOrder.Original +
    // FilterType.NextGroupStart + forward:true, priority 0. The live-only viewer stays
    // on the SUBSCRIBE path (not FETCH) so it always observes the latest re-published
    // catalog — the one that eventually carries each track's late initData (Req 2.5).
    const ftn = FullTrackName.tryNew(this.namespaceTuple, new TextEncoder().encode('catalog'))
    const sub = await client.subscribe({
      fullTrackName: ftn,
      groupOrder: GroupOrder.Original,
      filterType: FilterType.NextGroupStart,
      forward: true,
      priority: 0,
    })
    if (sub instanceof RequestError) {
      throw new DiscoveryError(
        `catalog subscribe rejected: code ${sub.errorCode} ${sub.reasonPhrase.phrase}`,
      )
    }

    const budgetMs = this.config.catalogTimeoutMs ?? 5_000
    const initialQuality = this.config.initialQuality ?? 'med'
    const reader = sub.stream.getReader()

    try {
      // Bound the whole read loop (potentially several catalog re-reads while we wait
      // for late initData) by the discovery budget. `withTimeout` races the drain
      // against the deadline; on timeout the finally-block below releases the reader
      // and unsubscribes.
      const catalog = await withTimeout(
        this.drainCatalog(reader, initialQuality),
        budgetMs,
      )
      return catalog
    } catch (cause) {
      if (cause instanceof DiscoveryError) throw cause
      // A timeout (or any other read-loop failure) means we never captured a usable
      // catalog within the budget (Req 2.2).
      throw new DiscoveryError(
        `catalog not retrieved within ${budgetMs}ms (or the stream failed)`,
        cause,
      )
    } finally {
      // Release the reader and unsubscribe the catalog stream regardless of outcome,
      // so a usable catalog, a timeout, or an error all leave no dangling catalog
      // subscription behind.
      try {
        reader.releaseLock()
      } catch {
        // best-effort; the reader may already be released on a settled stream
      }
      try {
        await client.unsubscribe(sub.requestId)
      } catch {
        // best-effort; teardown of the catalog subscription must not mask the result
      }
    }
  }

  /**
   * Read Objects from the catalog stream until a usable {@link CMSFCatalog} — one in
   * which the initial quality track's `initData` is present — is parsed, then return
   * it. Skips end-of-group markers and status Objects (null payload). Throws a
   * {@link DiscoveryError} if the stream closes before a usable catalog is read
   * (Req 2.2). The caller bounds this with {@link withTimeout}.
   */
  private async drainCatalog(
    reader: ReadableStreamDefaultReader<MoqtObject>,
    initialQuality: QualityName,
  ): Promise<CMSFCatalog> {
    for (;;) {
      const result = await reader.read()
      if (result.done) {
        // Early stream close before any usable catalog (Req 2.2).
        throw new DiscoveryError('catalog stream closed before a usable catalog was read')
      }
      const object = result.value
      // Skip end-of-group markers and status Objects (which carry a null payload);
      // only real catalog payloads are parseable (reference-player guard).
      if (object.isEndOfGroup()) continue
      if (!(object.payload?.buffer instanceof ArrayBuffer)) continue

      let catalog: CMSFCatalog
      try {
        catalog = CMSFCatalog.from(object.payload.buffer)
      } catch {
        // A malformed/partial catalog Object: keep reading for the next re-publish.
        continue
      }

      // The initial quality must exist in the catalog AND have its initData filled in.
      // `getInitData` returns undefined for an unknown track and THROWS when the track
      // exists but its initData has not been published yet — both mean "not usable
      // yet", so keep reading subsequent re-published catalogs (Req 2.5).
      if (this.catalogHasInitData(catalog, initialQuality)) {
        return catalog
      }
      // Otherwise loop and read the next catalog Object (the Broadcaster re-publishes
      // ~every second once the track's first keyframe lands).
    }
  }

  /**
   * True iff `track` is present in `catalog` and its `initData` (CMAF init segment) is
   * available. `getInitData` throws when the entry exists but lacks `initData` yet, so
   * that case is treated as "not available".
   */
  private catalogHasInitData(catalog: CMSFCatalog, track: QualityName): boolean {
    try {
      return catalog.getInitData(track) !== undefined
    } catch {
      return false
    }
  }

  /** Report a lifecycle status transition to the UI (no-op if no callback). */
  private report(status: ViewerStatus, detail?: string): void {
    this.config.onStatus?.(status, detail)
  }

  /**
   * Report a terminal error: surface it via `onError` and transition to the `error`
   * status, so the caller sees both the typed error and the status change. The start
   * sequence stops after this is called (the caller returns).
   */
  private fail(error: ViewerError): void {
    this.config.onError?.(error)
    this.report('error', error.message)
  }

  /**
   * User-driven quality change; delegates policy to the {@link QualityController} and
   * performs the control-plane `client.switch`, then arms the render-plane re-init that
   * is applied at the next group boundary (Req 5, 6) — Decision 4.
   *
   * The switch is a two-phase operation:
   *
   *   1. **Policy (pure).** `qc.decide(target)` classifies the request:
   *        - `noop`    (target === current)                 -> return, nothing changes (Req 5.7)
   *        - `busy`    (a switch is already pending)         -> return (Req 6.4 serialization)
   *        - `unknown` (target absent from the catalog)      -> report {@link UnknownTrackError},
   *                                                              keep the current track playing (Req 5.6)
   *        - `switch`  (valid, distinct, in-catalog target)  -> proceed below
   *
   *   2. **Control plane.** `qc.beginSwitch(target)` sets `pending` (so a second overlapping
   *      switch is now blocked as `busy`), report `switching`, then call
   *      `client.switch({ fullTrackName, subscriptionRequestId: currentRequestId })`,
   *      reusing the existing subscription (Req 5.1, 5.2).
   *        - On a returned `RequestError` (or a transport error thrown by the library's
   *          self-disconnect path): `qc.abortSwitch()` (current unchanged), report a
   *          {@link SwitchRejectedError}, return to `playing` (Req 5.3).
   *        - On success: adopt the library's new `requestId` and arm the render-plane
   *          switch via {@link armRenderSwitch}. The stream is the SAME object, so the
   *          render loop keeps consuming `currentStream` unchanged.
   *
   * CRITICAL — `commitSwitch()` is NOT called here. `pending` must stay set (keeping the
   * Req 6.4 `busy` guard active) until the render loop applies the switch at the next
   * `objectId === 0n` keyframe boundary, which is also where `commitSwitch()` runs
   * (see {@link runRenderLoop}). Committing on `client.switch` success would allow a
   * second switch before the library's deferred requestId->subscription remap has
   * settled, risking a `ProtocolViolationError('Unknown subscription request id')`.
   */
  async selectQuality(target: QualityName): Promise<void> {
    const qc = this.qc
    if (!qc) {
      // Defensive: selectQuality should only be callable once start() has built the
      // controller. Treat a premature call as an unknown track rather than crashing.
      this.config.onError?.(new UnknownTrackError(target))
      return
    }

    // (1) Pure policy decision (Decision 4 guard) — no I/O.
    const decision = qc.decide(target)
    switch (decision.kind) {
      case 'noop':
        return // Req 5.7 — same as current; continue unchanged.
      case 'busy':
        return // Req 6.4 — a switch is already in flight; ignore the overlap.
      case 'unknown':
        // Req 5.6 — reject the unknown target, keep the current track playing.
        this.config.onError?.(new UnknownTrackError(target))
        return
      case 'switch':
        break
    }

    // (2) Control-plane switch on the existing subscription.
    qc.beginSwitch(target) // pending set — the `busy` guard now blocks a second switch (Req 6.4).
    this.report('switching', target)

    let res: Awaited<ReturnType<MOQtailClient['switch']>>
    try {
      res = await this.client!.switch({
        fullTrackName: decision.fullTrackName,
        subscriptionRequestId: this.currentRequestId!, // same subscription (Req 5.1, 5.2)
      })
    } catch (cause) {
      // The library self-disconnects and rethrows on a transport error during switch.
      // Treat it like a rejection: abort the pending switch, keep the current track,
      // and report it. Wrap a non-RequestError cause so onError always gets a typed
      // ViewerError.
      qc.abortSwitch() // current unchanged (Req 5.3)
      const asRequestError = cause instanceof RequestError ? cause : undefined
      this.config.onError?.(
        asRequestError
          ? new SwitchRejectedError(target, asRequestError)
          : new RenderError(qc.state.current, `switch to "${target}" failed`, cause),
      )
      this.report('playing')
      return
    }

    if (res instanceof RequestError) {
      // Req 5.3 — protocol rejection: abort, keep the current track playing, report.
      qc.abortSwitch()
      this.config.onError?.(new SwitchRejectedError(target, res))
      this.report('playing')
      return
    }

    // Success. client.switch keeps the SAME stream and issues a NEW requestId; the
    // library's requestId->subscription remap is deferred until the new track alias is
    // observed, so we adopt the new id but must NOT commitSwitch yet.
    this.currentRequestId = res.requestId
    // The returned stream is the same object as currentStream (confirmed against
    // client.ts: `subscription.stream` is readonly and created once), so the running
    // render loop keeps consuming it. Re-point defensively in case the library ever
    // returns a distinct reference.
    this.currentStream = res.stream

    // Arm the render-plane re-init; the render loop applies it (and commits the switch)
    // at the next objectId===0 keyframe boundary (task 8.2).
    this.armRenderSwitch(target)
  }

  /**
   * Arm the render-plane re-initialization for a successful `client.switch` (Req 5.4,
   * 5.5). Sets the {@link PendingSwitch} latch read by the render loop; the actual
   * `changeType` (gated) + init-segment append + `commitSwitch()` happen in
   * {@link runRenderLoop} at the next group-start keyframe (`objectId === 0n`), so the
   * new quality begins at a decodable boundary rather than mid-GOP.
   *
   * `mime` is derived from the target track the same way {@link attachAndInit} derives
   * it. For the demo's `hd`/`med`/`low` (all `avc1.640028`) this equals `currentMime`,
   * so the gated `changeType` call will not fire — the init-segment append alone
   * re-initializes the decoder (the standard same-codec adaptive-streaming pattern).
   */
  private armRenderSwitch(target: QualityName): void {
    this.pendingSwitch = {
      track: target,
      mime: this.mimeFor(target),
      initAppended: false,
    }
  }

  /**
   * Best-effort, idempotent teardown (Req 1.4, 9.3, 9.4).
   *
   * Idempotent: guarded by `this.stopped`. A second (or stop-before-connect) call
   * returns immediately as a no-op. `this.stopped` is set `true` FIRST, before any
   * teardown step, so the render loop's `write` handler stops appending at once
   * (it returns early when `this.stopped` is set) — nothing is appended after
   * teardown begins (Req 9.4).
   *
   * The teardown steps then run in order, each wrapped in its OWN try/catch so one
   * failure never blocks the others (Req 9.3) — "best-effort isolation":
   *
   *   1. `this.renderAbort.abort()` — abort the render pipe (`pipeTo` rejects with an
   *      AbortError the render loop swallows as intentional teardown, so the
   *      subscription stream stops being drained).
   *   2. `client.unsubscribe(currentRequestId)` — only when BOTH the client and a
   *      current request id are set (Req 1.4). Unsubscribe runs BEFORE disconnect, and
   *      a failure here (it can throw, and on a transport error it self-disconnects and
   *      rethrows) must NOT prevent the disconnect in step 4 — the isolated try/catch
   *      guarantees that.
   *   3. `this.mse.endOfStream()` — end the MediaSource (Req 9.3). Only attempted when
   *      the MediaSource is `open`; calling it in any other state throws
   *      `InvalidStateError`, which the try/catch also absorbs.
   *   4. `client.disconnect()` — release the relay connection (Req 1.4, 9.3).
   *      `disconnect` is idempotent (its `#isDestroyed` guard), so it is safe even if
   *      step 2's unsubscribe already triggered a self-disconnect.
   *   5. Stop the telemetry timer — hook for task 10 (telemetry is not implemented
   *      yet); a no-op for now.
   *
   * Stop-before-connect and stop-after-a-failed-start are both no-crash no-ops: with
   * `client` and `currentRequestId` still null, steps 2 and 4 are skipped/guarded, and
   * `endOfStream()` on a non-open MediaSource is swallowed. Finally reports `stopped`.
   */
  async stop(): Promise<void> {
    // Idempotent guard: a second call (or a stop-before-connect after construction)
    // is a no-op.
    if (this.stopped) return

    // Set stopped FIRST so the render loop stops appending immediately (Req 9.4),
    // before any teardown step runs.
    this.stopped = true

    // (1) Abort the render pipe. Best-effort/isolated.
    try {
      this.renderAbort.abort()
    } catch {
      // abort() should not throw; isolate defensively so a failure here cannot block
      // the remaining teardown steps.
    }

    // (2) Best-effort unsubscribe BEFORE disconnect (Req 1.4). Only when the client is
    // connected and a subscription request id exists. A failure must NOT prevent the
    // disconnect below — isolated in its own try/catch.
    if (this.client && this.currentRequestId !== null) {
      try {
        await this.client.unsubscribe(this.currentRequestId)
      } catch {
        // Unsubscribe can throw (and may self-disconnect) — swallow so disconnect still
        // runs. disconnect() is idempotent, so a self-disconnect here is harmless.
      }
    }

    // (3) End the MediaSource (Req 9.3). endOfStream() is only legal while the
    // MediaSource is 'open'; guard the state and absorb any InvalidStateError.
    try {
      if (this.mse.readyState === 'open') {
        this.mse.endOfStream()
      }
    } catch {
      // best-effort; a bad MediaSource state must not block the disconnect.
    }

    // (4) Release the relay connection (Req 1.4, 9.3). Idempotent, so safe even if an
    // earlier step already triggered a self-disconnect.
    if (this.client) {
      try {
        await this.client.disconnect()
      } catch {
        // best-effort; disconnect failure must not prevent reporting 'stopped'.
      }
    }

    // (5) Stop the telemetry timer (Req 9.4). Hook for task 10 — telemetry is not
    // implemented yet, so there is no timer to clear. When task 10 adds a
    // `telemetryTimer` field, clear it here (e.g. `clearInterval(this.telemetryTimer)`)
    // inside its own try/catch, keeping best-effort isolation.

    // Terminal status: teardown complete.
    this.report('stopped')
  }

  /** The quality names discovered in the catalog, for building the picker (Req 6.1). */
  get availableQualities(): QualityName[] {
    // Derived from the catalog's video tracks once discovery has run; empty until then.
    if (!this.catalog) return []
    return this.catalog.getTracks('video').map((t) => t.name)
  }

  /**
   * The quality track currently being rendered — the QualityController's COMMITTED
   * `current`, which only advances at the applied group-boundary (not when
   * `client.switch` resolves). This is the authoritative source of truth for the UI's
   * current-track indicator (Req 6.2); the UI must not maintain its own mirror, which
   * would lag the deferred commit. Null until the controller is built in start().
   */
  get currentQuality(): QualityName | null {
    return this.qc?.state.current ?? null
  }

  /**
   * The pending switch target while a switch is in flight (the QualityController's
   * `pending`), or null when no switch is in flight. Set from `beginSwitch` until the
   * boundary `commitSwitch`, so the UI can mark the pending selection and keep the
   * picker disabled for exactly the window the Req 6.4 `busy` guard is active.
   */
  get pendingQuality(): QualityName | null {
    return this.qc?.state.pending ?? null
  }

  /**
   * Smoothed glass-to-glass latency in milliseconds (capture → display), or null if no
   * object carrying the Broadcaster's wall-clock capture epoch header has been appended
   * yet. The UI shows this as the real latency readout and falls back to a buffered-
   * ahead proxy when it is null. See {@link updateLatency} for the accuracy caveat.
   */
  get lastLatencyMs(): number | null {
    return this.latencyMsEma
  }
}
