// viewer/quality.ts — Decision 4 (quality switching) policy core.
//
// The QualityController separates the *decision* ("is this switch allowed, to which
// full track name, on which subscription?") from the *effect* (`client.switch` + the
// MSE re-init, which live in subscribe.ts). The guard logic in `decide` is pure — a
// function of (current, pending, catalogTrackNames, target) with no network or MSE
// dependency — which makes it the unit- and property-test surface for the viewer.
//
// Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 5.7, 6.4

import { FullTrackName, Tuple } from 'moqtail'

/** A quality track name as listed in the catalog; the demo uses 'hd' | 'med' | 'low'. */
export type QualityName = string

/**
 * The outcome of the pure switch-policy guard (`decide`), as a discriminated union on
 * `kind`.
 * - `noop`    — target is already the current track (Req 5.7)
 * - `unknown` — target is absent from the catalog (Req 5.6)
 * - `busy`    — a switch is already pending (Req 6.4)
 * - `switch`  — perform the switch to `target` via `fullTrackName` (Req 5.1, 5.2)
 */
export type SwitchDecision =
  | { kind: 'noop' }
  | { kind: 'unknown'; track: QualityName }
  | { kind: 'busy' }
  | { kind: 'switch'; target: QualityName; fullTrackName: FullTrackName }

/** The externally observable state of the controller. */
export interface QualityControllerState {
  current: QualityName
  pending: QualityName | null
}

export class QualityController {
  private current: QualityName
  private pending: QualityName | null = null

  /**
   * @param namespace         the MoQ namespace the broadcast was published under; used
   *                          to build target full track names.
   * @param catalogTrackNames the set of selectable track names discovered in the catalog.
   * @param initial           the track rendered at start (the `current` track).
   */
  constructor(
    private readonly namespace: Tuple,
    private readonly catalogTrackNames: ReadonlySet<QualityName>,
    initial: QualityName,
  ) {
    this.current = initial
  }

  get state(): QualityControllerState {
    return { current: this.current, pending: this.pending }
  }

  /**
   * Pure guard (Decision 4 policy). Decides whether/what to switch WITHOUT performing
   * any I/O or mutating controller state. Its entire behavior is a function of
   * (current, pending, catalogTrackNames, target):
   * - target === current       -> { noop }                          (Req 5.7)
   * - a switch already pending  -> { busy }                          (Req 6.4)
   * - target not in catalog      -> { unknown }                       (Req 5.6)
   * - otherwise                  -> { switch, target, fullTrackName }  (Req 5.1, 5.2)
   *   where fullTrackName = FullTrackName.tryNew(namespace, encode(target)).
   */
  decide(target: QualityName): SwitchDecision {
    if (target === this.current) {
      return { kind: 'noop' }
    }
    if (this.pending !== null) {
      return { kind: 'busy' }
    }
    if (!this.catalogTrackNames.has(target)) {
      return { kind: 'unknown', track: target }
    }
    const fullTrackName = FullTrackName.tryNew(this.namespace, new TextEncoder().encode(target))
    return { kind: 'switch', target, fullTrackName }
  }

  /** Record that a `{ switch }` decision is now in flight (sets `pending`). */
  beginSwitch(target: QualityName): void {
    this.pending = target
  }

  /**
   * Commit the switch: `current = pending`, `pending = null` (Req 5.4). Called by the
   * render loop once the switch has been applied at the next objectId===0 keyframe
   * boundary — NOT when client.switch resolves — so `pending` (and thus the Req 6.4
   * `busy` guard) stays set until the switch is fully settled on both planes.
   */
  commitSwitch(): void {
    if (this.pending !== null) {
      this.current = this.pending
      this.pending = null
    }
  }

  /** On a client.switch RequestError/throw: `pending = null`, `current` unchanged (Req 5.3). */
  abortSwitch(): void {
    this.pending = null
  }
}
