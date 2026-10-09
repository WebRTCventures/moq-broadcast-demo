// Task 1.2 — cross-package import de-risk / verification.
//
// This file exists to prove the full symbol set the downstream viewer tasks need
// resolves across the package boundary into the in-repo draft-16 moqtail-ts build,
// via the tsconfig `paths` (types) + vite/vitest `resolve.alias` (runtime) wiring.
// If any specifier or symbol fails to resolve, `npm run typecheck` fails here.
//
// The riskiest import is `NetworkTelemetry` from `moqtail/util`: that subpath entry
// is viewer-specific (the broadcaster does not use it), so it is exercised first.
import { describe, it, expect } from 'vitest'

// moqtail/client — the connection primitive.
import { MOQtailClient } from 'moqtail/client'

// moqtail (main entry) — core subscribe/switch model types used by subscribe.ts.
import {
  FullTrackName,
  FilterType,
  GroupOrder,
  Tuple,
  MoqtObject,
  Location,
} from 'moqtail'

// moqtail/model — catalog parsing + protocol-rejection type.
import { CMSFCatalog, RequestError } from 'moqtail/model'

// moqtail/util — optional telemetry panel (the riskiest cross-boundary symbol).
import { NetworkTelemetry } from 'moqtail/util'

// Type-level assertions: reference every imported symbol so `noUnusedLocals` would
// flag a missing/renamed export, turning a broken import into a typecheck failure.
type _Client = typeof MOQtailClient
type _FullTrackName = typeof FullTrackName
type _FilterType = FilterType
type _GroupOrder = GroupOrder
type _Tuple = Tuple
type _MoqtObject = MoqtObject
type _Location = typeof Location
type _CMSFCatalog = typeof CMSFCatalog
type _RequestError = typeof RequestError
type _NetworkTelemetry = NetworkTelemetry

// A trivial runtime assertion keeps vitest happy (a file with only type imports is
// elided to an empty module). It also confirms the value-level bindings exist at
// runtime through the .mjs aliases, not just the .d.mts typings.
describe('cross-package moqtail-ts imports (task 1.2)', () => {
  it('resolves every symbol the viewer tasks depend on', () => {
    const symbols: unknown[] = [
      MOQtailClient,
      FullTrackName,
      FilterType,
      GroupOrder,
      Tuple,
      MoqtObject,
      Location,
      CMSFCatalog,
      RequestError,
      NetworkTelemetry,
    ]
    for (const s of symbols) {
      expect(s).toBeDefined()
    }
    // Touch the type aliases so they are not reported as unused.
    const _typeTouch: [
      _Client?,
      _FullTrackName?,
      _FilterType?,
      _GroupOrder?,
      _Tuple?,
      _MoqtObject?,
      _Location?,
      _CMSFCatalog?,
      _RequestError?,
      _NetworkTelemetry?,
    ] = []
    expect(_typeTouch).toHaveLength(0)
  })
})
