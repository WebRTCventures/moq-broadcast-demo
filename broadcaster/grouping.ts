// Decision-1 grouping logic for the moq-broadcaster (see design.md "grouping.ts").
//
// This module separates the *decision* (what group/object/priority/marking does a
// frame get?) from the *effect* (enqueuing a MoqtObject onto a live stream). The
// counter logic in `assignFrame` is pure: its entire observable behavior is a
// function of the counter state and the emitted-keyframe flag it is fed, which is
// what makes it unit- and property-testable.

import { ExtensionHeaders, KeyValuePair, Location, MoqtObject, ObjectForwardingPreference } from 'moqtail'
import type { FullTrackName } from 'moqtail'

/**
 * Custom extension-header type id carrying the wall-clock capture epoch in
 * milliseconds (`Date.now()` at segment time). This is DISTINCT from the LOC
 * `CaptureTimestamp` header (type 2), which carries the media-timeline
 * `VideoFrame.timestamp` (µs) — a presentation clock the viewer cannot convert to
 * wall-clock latency. The viewer subtracts this epoch from its own `Date.now()` to
 * compute real glass-to-glass latency (accurate when broadcaster and viewer share a
 * clock, e.g. the same machine, or NTP-synced hosts). Even type id => varint value
 * per the MoQ KVP convention; 20 avoids the used LOC ids (2, 4, 6, 13).
 */
export const WALLCLOCK_CAPTURE_EPOCH_MS_TYPE = 20

/** Fixed priority and marking constants (Req 7.2–7.4, 8.3–8.5). */
export const KEYFRAME_PRIORITY = 1 // lower number = higher priority
export const DELTA_PRIORITY = 2 // numerically higher = lower priority
export const KEYFRAME_MARKING = 1
export const DELTA_MARKING = 0

/** Forwarding preference for every video object (Req 6.1, 6.2). */
export const VIDEO_FORWARDING_PREFERENCE = ObjectForwardingPreference.Subgroup

/**
 * Independent per-track counters. One instance per Quality_Track.
 * Initialized to groupId=0, objectId=0 before the first object (Req 5.3).
 * Because a keyframe increments groupId *before* assignment, the first
 * (keyframe) object lands at groupId=1, objectId=0 (Req 5.4, intentional).
 */
export interface GroupCounter {
  groupId: bigint // starts at 0n
  objectId: bigint // starts at 0n
}

export function newGroupCounter(): GroupCounter {
  return { groupId: 0n, objectId: 0n }
}

/** The grouping decision for a single emitted frame. Pure data, no side effects. */
export interface FrameAssignment {
  groupId: bigint
  objectId: bigint
  priority: number // KEYFRAME_PRIORITY | DELTA_PRIORITY
  marking: number // KEYFRAME_MARKING | DELTA_MARKING
  forwardingPreference: ObjectForwardingPreference // always Subgroup
}

/**
 * Advance a track's counters for one emitted frame and return its assignment.
 * MUTATES `counter` in place (mirrors publisher.ts enqueueObject semantics).
 *
 * Keyframe (Req 5.4, 7.2, 8.3):
 *   groupId += 1; objectId = 0; assign (groupId, 0); objectId = 1 after assignment.
 * Delta (Req 5.5, 7.3, 8.4):
 *   assign (groupId, objectId); objectId += 1 after assignment.
 *
 * Grouping is driven by the *emitted* chunk type (`isKey`), not by the requested
 * keyframe cadence, so a keyframe emitted at an arbitrary position still starts a
 * new group (Req 4.4).
 */
export function assignFrame(counter: GroupCounter, isKey: boolean): FrameAssignment {
  if (isKey) {
    counter.groupId += 1n
    counter.objectId = 0n
    const assignment: FrameAssignment = {
      groupId: counter.groupId,
      objectId: counter.objectId,
      priority: KEYFRAME_PRIORITY,
      marking: KEYFRAME_MARKING,
      forwardingPreference: VIDEO_FORWARDING_PREFERENCE,
    }
    counter.objectId = 1n
    return assignment
  }

  const assignment: FrameAssignment = {
    groupId: counter.groupId,
    objectId: counter.objectId,
    priority: DELTA_PRIORITY,
    marking: DELTA_MARKING,
    forwardingPreference: VIDEO_FORWARDING_PREFERENCE,
  }
  counter.objectId += 1n
  return assignment
}

/**
 * Build the per-object extension headers (Req 8). Deterministic: given the same
 * inputs it always produces the same KeyValuePair[]. It constructs moqtail-ts
 * library types (ExtensionHeaders) but has no I/O or hidden state, so it is safe
 * to drive from property tests.
 *
 * `captureTimestampMicros` is VideoFrame.timestamp (microseconds, a number).
 * Because `ExtensionHeaders.addCaptureTimestamp` does `BigInt(timestamp)`
 * internally and `BigInt()` throws a RangeError on a non-integer, the timestamp is
 * rounded to an integer (Math.round) before being passed. VideoFrame.timestamp is
 * usually integral but is not guaranteed to be (e.g. canvas-sourced frames), so
 * this guard is required (Req 8.1).
 *
 * Attaches exactly one capture-timestamp header (Req 8.1, 8.2) and exactly one
 * video-frame-marking header carrying `marking` (Req 8.3–8.5).
 */
export function buildExtensionHeaders(
  captureTimestampMicros: number,
  marking: number,
  wallClockEpochMs?: number,
): KeyValuePair[] {
  const headers = new ExtensionHeaders()
    .addCaptureTimestamp(Math.round(captureTimestampMicros))
    .addVideoFrameMarking(marking)
  // Wall-clock capture epoch (ms) for real glass-to-glass latency on the viewer. Added
  // as a raw even-typed varint header so it rides alongside the LOC headers without a
  // library change. Omitted (not added) when not provided, keeping the deterministic
  // LOC-only output for the property tests that call this without it.
  if (wallClockEpochMs !== undefined) {
    headers.addRaw(KeyValuePair.tryNewVarInt(WALLCLOCK_CAPTURE_EPOCH_MS_TYPE, Math.round(wallClockEpochMs)))
  }
  return headers.build()
}

/**
 * Package an assigned frame as a MoqtObject (effect boundary; thin, side-effect-free
 * wrapper over MoqtObject.newWithPayload). Kept here so the full Decision-1 mapping
 * is in one file.
 *
 * `location` is `new Location(assignment.groupId, assignment.objectId)`; `subgroupId`
 * is `0n` (matching publisher.ts); `publisherPriority` is `assignment.priority`
 * (Req 7.1); `objectForwardingPreference` is `assignment.forwardingPreference`
 * (always Subgroup, Req 6.1); `extensionHeaders` are built from the capture timestamp
 * and marking (Req 8); `payload` is the CMAF segment produced by the muxer (Req 5.1).
 */
export function packageObject(
  ftn: FullTrackName,
  assignment: FrameAssignment,
  captureTimestampMicros: number,
  payload: Uint8Array,
  wallClockEpochMs?: number,
): MoqtObject {
  return MoqtObject.newWithPayload(
    ftn,
    new Location(assignment.groupId, assignment.objectId),
    assignment.priority,
    assignment.forwardingPreference,
    0n,
    buildExtensionHeaders(captureTimestampMicros, assignment.marking, wallClockEpochMs),
    payload,
  )
}
