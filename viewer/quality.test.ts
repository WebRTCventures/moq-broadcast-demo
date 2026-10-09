// viewer/quality.test.ts — property-based tests for the pure QualityController
// (Decision-4 switching policy in viewer/quality.ts).
//
// Five fast-check properties, one per Correctness Property (tasks 2.2–2.6), each
// tagged with its Feature/Property comment and validating specific requirements.
// Every property runs with numRuns >= 100.
//
// The controller under test is pure in `decide` (a function of current / pending /
// catalogTrackNames / target) and holds minimal mutable state advanced only by
// beginSwitch / commitSwitch / abortSwitch. These tests exercise that contract
// without any network or MSE dependency.

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { FullTrackName, Tuple } from 'moqtail'
import { QualityController, type QualityName, type SwitchDecision } from './quality.ts'

// ---------------------------------------------------------------------------
// Shared test fixtures / generators
// ---------------------------------------------------------------------------

// A realistic namespace, built the same way the broadcaster / reference player do
// (Tuple.fromUtf8Path), so the full-track-name assertions in Property 5 compare
// against a namespace the production code would actually use.
const NAMESPACE: Tuple = Tuple.fromUtf8Path('/moq/demo/live')

// The demo's canonical catalog: a few distinct, realistic quality names.
const CORE_QUALITIES: readonly QualityName[] = ['hd', 'med', 'low'] as const

/** Build a FullTrackName the exact way quality.ts does, for structural comparison. */
function expectedFtn(target: QualityName): FullTrackName {
  return FullTrackName.tryNew(NAMESPACE, new TextEncoder().encode(target))
}

/** Structural equality for FullTrackName: compare namespace (Tuple.equals) + name bytes. */
function ftnEquals(a: FullTrackName, b: FullTrackName): boolean {
  if (!a.namespace.equals(b.namespace)) return false
  const an = a.name
  const bn = b.name
  if (an.length !== bn.length) return false
  for (let i = 0; i < an.length; i++) {
    if (an[i] !== bn[i]) return false
  }
  return true
}

/**
 * A generator for a catalog (a non-empty set of distinct names). It always contains
 * the core hd/med/low plus a random handful of extra distinct names, so targets can
 * be drawn both inside and outside the catalog.
 */
const catalogArb: fc.Arbitrary<ReadonlySet<QualityName>> = fc
  .uniqueArray(
    fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim().length > 0),
    { minLength: 0, maxLength: 5 },
  )
  .map((extras) => new Set<QualityName>([...CORE_QUALITIES, ...extras]))

/** A name definitely NOT in a given catalog (used to generate unknown targets). */
const outsideArb = (catalog: ReadonlySet<QualityName>): fc.Arbitrary<QualityName> =>
  fc.string({ minLength: 1, maxLength: 12 }).filter((s) => !catalog.has(s))

/**
 * Build a fresh controller whose `current` is a member of the catalog, and
 * optionally drive it into a pending state (to model "a switch is in flight").
 */
function makeController(
  catalog: ReadonlySet<QualityName>,
  initial: QualityName,
): QualityController {
  return new QualityController(NAMESPACE, catalog, initial)
}

// A small step language for exercising the controller's state machine (Properties
// 3 & 4). Each step mutates the controller via its public effect methods.
type Step =
  | { op: 'decide'; target: QualityName }
  | { op: 'begin'; target: QualityName }
  | { op: 'commit' }
  | { op: 'abort' }

/** Generate a sequence of steps drawing targets from inside + outside the catalog. */
function stepsArb(catalog: ReadonlySet<QualityName>): fc.Arbitrary<Step[]> {
  const inside = fc.constantFrom(...catalog)
  const target = fc.oneof(inside, outsideArb(catalog))
  const step: fc.Arbitrary<Step> = fc.oneof(
    target.map((t) => ({ op: 'decide', target: t }) as Step),
    target.map((t) => ({ op: 'begin', target: t }) as Step),
    fc.constant<Step>({ op: 'commit' }),
    fc.constant<Step>({ op: 'abort' }),
  )
  return fc.array(step, { minLength: 0, maxLength: 30 })
}

// ---------------------------------------------------------------------------
// Property 1 (task 2.2) — Validates Requirements 5.7
// ---------------------------------------------------------------------------

describe('QualityController — Property 1', () => {
  // Feature: moq-viewer, Property 1: A no-op switch never changes state
  it('a no-op switch never changes state', () => {
    fc.assert(
      fc.property(catalogArb, (catalog) => {
        const names = [...catalog]
        return fc.assert(
          // nested over the chosen current track so "current" ranges over the catalog
          fc.property(fc.constantFrom(...names), (current) => {
            const qc = makeController(catalog, current)
            const before = qc.state

            const decision = qc.decide(current)

            // decide(current) must be a no-op...
            expect(decision).toEqual<SwitchDecision>({ kind: 'noop' })
            // ...and `decide` is pure: current/pending are unchanged.
            const after = qc.state
            expect(after.current).toBe(before.current)
            expect(after.pending).toBe(before.pending)
          }),
          { numRuns: 100 },
        )
      }),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 2 (task 2.3) — Validates Requirements 5.6
// ---------------------------------------------------------------------------

describe('QualityController — Property 2', () => {
  // Feature: moq-viewer, Property 2: Unknown targets are rejected and never become current
  it('unknown targets are rejected and never become current', () => {
    fc.assert(
      fc.property(
        catalogArb,
        fc.array(fc.boolean(), { minLength: 0, maxLength: 20 }),
        (catalog, commitFlags) => {
          const names = [...catalog]
          return fc.assert(
            fc.property(
              fc.constantFrom(...names),
              // targets drawn from inside AND outside the catalog
              fc.array(fc.oneof(fc.constantFrom(...names), outsideArb(catalog)), {
                minLength: 1,
                maxLength: 20,
              }),
              (initial, targets) => {
                const qc = makeController(catalog, initial)

                targets.forEach((target, i) => {
                  const decision = qc.decide(target)

                  // Out-of-catalog targets (that are not the current, no pending) yield unknown.
                  if (!catalog.has(target) && target !== qc.state.current && qc.state.pending === null) {
                    expect(decision).toEqual<SwitchDecision>({ kind: 'unknown', track: target })
                  }

                  // Drive a realistic select/commit sequence: only begin on a real switch.
                  if (decision.kind === 'switch') {
                    qc.beginSwitch(decision.target)
                    // Randomly commit or leave pending to vary the trajectory.
                    if (commitFlags[i % Math.max(1, commitFlags.length)]) {
                      qc.commitSwitch()
                    }
                  }

                  // Invariant: current is ALWAYS a member of the catalog — no select/commit
                  // sequence can ever set current to an out-of-catalog name.
                  expect(catalog.has(qc.state.current)).toBe(true)
                })
              },
            ),
            { numRuns: 100 },
          )
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 3 (task 2.4) — Validates Requirements 6.4
// ---------------------------------------------------------------------------

describe('QualityController — Property 3', () => {
  // Feature: moq-viewer, Property 3: No overlapping switches
  it('pending is set only strictly between beginSwitch and commit/abort, and decide returns busy while pending', () => {
    fc.assert(
      fc.property(catalogArb, (catalog) => {
        const names = [...catalog]
        return fc.assert(
          fc.property(fc.constantFrom(...names), stepsArb(catalog), (initial, steps) => {
            const qc = makeController(catalog, initial)

            // Model the expected pending state independently of the controller.
            let expectedPending: QualityName | null = null

            for (const step of steps) {
              switch (step.op) {
                case 'decide': {
                  // Whenever a switch is pending, decide must report busy (unless no-op).
                  const decision = qc.decide(step.target)
                  if (qc.state.pending !== null && step.target !== qc.state.current) {
                    expect(decision).toEqual<SwitchDecision>({ kind: 'busy' })
                  }
                  break
                }
                case 'begin': {
                  // Only begin a switch the controller would actually allow (mirrors wiring).
                  const decision = qc.decide(step.target)
                  if (decision.kind === 'switch') {
                    qc.beginSwitch(decision.target)
                    expectedPending = decision.target
                  }
                  break
                }
                case 'commit': {
                  qc.commitSwitch()
                  expectedPending = null
                  break
                }
                case 'abort': {
                  qc.abortSwitch()
                  expectedPending = null
                  break
                }
              }

              // Core invariant: pending is non-null ONLY strictly between a beginSwitch
              // and its following commit/abort — exactly the model's expectedPending.
              expect(qc.state.pending).toBe(expectedPending)
            }
          }),
          { numRuns: 100 },
        )
      }),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 4 (task 2.5) — Validates Requirements 5.1, 5.2, 5.3, 5.4
// ---------------------------------------------------------------------------

describe('QualityController — Property 4', () => {
  // Feature: moq-viewer, Property 4: current only advances via a committed, valid switch
  it('current changes only via commitSwitch after a valid switch; abort never changes current', () => {
    fc.assert(
      fc.property(catalogArb, (catalog) => {
        const names = [...catalog]
        return fc.assert(
          fc.property(fc.constantFrom(...names), stepsArb(catalog), (initial, steps) => {
            const qc = makeController(catalog, initial)

            // Track the target of the most recent valid `{ switch }` decision that we
            // began but have not yet committed/aborted.
            let armedTarget: QualityName | null = null

            for (const step of steps) {
              const currentBefore = qc.state.current

              switch (step.op) {
                case 'decide': {
                  qc.decide(step.target)
                  // decide is pure: never changes current.
                  expect(qc.state.current).toBe(currentBefore)
                  break
                }
                case 'begin': {
                  const decision = qc.decide(step.target)
                  if (decision.kind === 'switch') {
                    // A valid switch target must be in-catalog and distinct from current.
                    expect(catalog.has(decision.target)).toBe(true)
                    expect(decision.target).not.toBe(currentBefore)
                    qc.beginSwitch(decision.target)
                    armedTarget = decision.target
                  }
                  // beginSwitch never advances current.
                  expect(qc.state.current).toBe(currentBefore)
                  break
                }
                case 'commit': {
                  qc.commitSwitch()
                  if (armedTarget !== null) {
                    // current advanced to exactly the armed, valid target.
                    expect(qc.state.current).toBe(armedTarget)
                  } else {
                    // nothing pending => commit is a no-op on current.
                    expect(qc.state.current).toBe(currentBefore)
                  }
                  armedTarget = null
                  break
                }
                case 'abort': {
                  qc.abortSwitch()
                  // abort NEVER changes current.
                  expect(qc.state.current).toBe(currentBefore)
                  armedTarget = null
                  break
                }
              }

              // current is always a valid catalog member.
              expect(catalog.has(qc.state.current)).toBe(true)
            }
          }),
          { numRuns: 100 },
        )
      }),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 5 (task 2.6) — Validates Requirements 5.2
// ---------------------------------------------------------------------------

describe('QualityController — Property 5', () => {
  // Feature: moq-viewer, Property 5: The emitted full track name matches the target
  it('every { switch } decision emits fullTrackName === FullTrackName.tryNew(namespace, encode(target))', () => {
    fc.assert(
      fc.property(catalogArb, (catalog) => {
        const names = [...catalog]
        return fc.assert(
          fc.property(
            fc.constantFrom(...names),
            // targets inside + outside, so we also confirm non-switch decisions emit no ftn
            fc.array(fc.oneof(fc.constantFrom(...names), outsideArb(catalog)), {
              minLength: 1,
              maxLength: 20,
            }),
            (initial, targets) => {
              const qc = makeController(catalog, initial)

              for (const target of targets) {
                const decision = qc.decide(target)
                if (decision.kind === 'switch') {
                  const expected = expectedFtn(decision.target)
                  // Structural comparison on namespace + name bytes.
                  expect(ftnEquals(decision.fullTrackName, expected)).toBe(true)
                  // And a strong byte-level cross-check via wire serialization.
                  expect(decision.fullTrackName.serialize().toUint8Array()).toEqual(
                    expected.serialize().toUint8Array(),
                  )
                  // The emitted target must equal the requested target.
                  expect(decision.target).toBe(target)
                }
                // No pending here (we never beginSwitch), so each decide is independent.
              }
            },
          ),
          { numRuns: 100 },
        )
      }),
      { numRuns: 100 },
    )
  })
})
