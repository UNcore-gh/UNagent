// Pure helpers of the unified mobile keyboard adapter (useKeyboardLift).
// The DOM wiring itself needs a real browser; these tests pin the math the
// four mobile views (Android/iPad × main/side drawer) all share.

import {
  containerLift,
  effectiveInset,
  EST_GIVEUP_MS,
  EST_GRACE_MS,
  estimateAllowed,
  estimateKbHeight,
  KB_SIGNAL_FLAG_KEY,
  keyboardInsetFrom,
  KB_DEADZONE_PX,
  parseCssPx,
  readSignalFlag,
  writeSignalFlag,
} from '../useKeyboardLift'

describe('parseCssPx', () => {
  it('parses pixel strings', () => {
    expect(parseCssPx('340px')).toBe(340)
    expect(parseCssPx(' 12.5px')).toBe(12.5)
  })

  it('returns 0 for empty/garbage/negative input', () => {
    expect(parseCssPx('')).toBe(0)
    expect(parseCssPx('abc')).toBe(0)
    expect(parseCssPx('-5px')).toBe(0)
  })
})

describe('keyboardInsetFrom', () => {
  const innerHeight = 800

  it('uses the native --keyboard-height when visualViewport is silent', () => {
    // The Android case: vv reports nothing, Obsidian's own variable does.
    expect(
      keyboardInsetFrom({
        nativeCss: '320px',
        innerHeight,
        vv: { height: 800, offsetTop: 0 },
      }),
    ).toBe(320)
  })

  it('uses the visualViewport inset when the native var is missing', () => {
    // The iPhone case: no native var, vv shrinks by the keyboard height.
    expect(
      keyboardInsetFrom({
        nativeCss: '',
        innerHeight,
        vv: { height: 500, offsetTop: 0 },
      }),
    ).toBe(300)
  })

  it('takes the LARGER of the two sources', () => {
    expect(
      keyboardInsetFrom({
        nativeCss: '350px',
        innerHeight,
        vv: { height: 500, offsetTop: 0 },
      }),
    ).toBe(350)
    expect(
      keyboardInsetFrom({
        nativeCss: '200px',
        innerHeight,
        vv: { height: 450, offsetTop: 0 },
      }),
    ).toBe(350)
  })

  it('accounts for visualViewport offsetTop', () => {
    expect(
      keyboardInsetFrom({
        nativeCss: '',
        innerHeight,
        vv: { height: 500, offsetTop: 40 },
      }),
    ).toBe(260)
  })

  it('clamps a negative vv inset to 0 and tolerates a missing vv', () => {
    expect(
      keyboardInsetFrom({
        nativeCss: '',
        innerHeight,
        vv: { height: 900, offsetTop: 0 },
      }),
    ).toBe(0)
    expect(
      keyboardInsetFrom({ nativeCss: '', innerHeight, vv: null }),
    ).toBe(0)
  })
})

describe('estimateKbHeight', () => {
  it('uses the portrait ratio capped at 360px', () => {
    expect(estimateKbHeight(800, 400)).toBe(304) // 0.38 × 800
    expect(estimateKbHeight(1180, 400)).toBe(360) // 448 → capped
  })

  it('uses the landscape ratio capped at 360px', () => {
    expect(estimateKbHeight(600, 1000)).toBe(288) // 0.48 × 600
    expect(estimateKbHeight(900, 1000)).toBe(360) // 432 → capped
  })
})

describe('containerLift', () => {
  it('measures how far the root bottom sits above the window bottom', () => {
    expect(containerLift(800, 800)).toBe(0) // full-height main view
    expect(containerLift(420, 800)).toBe(380) // Obsidian pre-lifted drawer
    expect(containerLift(700, 800)).toBe(100) // split not reaching bottom
  })

  it('clamps oversize/offscreen rects and garbage to 0', () => {
    expect(containerLift(900, 800)).toBe(0)
    expect(containerLift(-315, 800)).toBe(0)
    expect(containerLift(NaN, 800)).toBe(0)
    expect(containerLift(800, NaN)).toBe(0)
  })
})

describe('effectiveInset', () => {
  it('subtracts the container lift from the keyboard height', () => {
    // iPad drawer double-lift case from the device boot-log:
    // native 412 but the container was already lifted ~380px.
    expect(effectiveInset(412, 380)).toBe(32)
  })

  it('never goes negative or above the raw keyboard height', () => {
    expect(effectiveInset(412, 500)).toBe(0)
    expect(effectiveInset(412, 0)).toBe(412)
    expect(effectiveInset(0, 100)).toBe(0)
  })
})

describe('KB_DEADZONE_PX', () => {
  it('stays below any plausible real keyboard but above layout noise', () => {
    expect(KB_DEADZONE_PX).toBeGreaterThan(10)
    expect(KB_DEADZONE_PX).toBeLessThan(200)
  })
})

describe('estimate gating window', () => {
  // External-keyboard fix: real on-screen signals land within ~400ms, so
  // the grace must sit above that, and giveup must stay long enough for
  // slow WebViews yet short enough that a phantom lift isn't visible long.
  it('grace is after real signals arrive, giveup after grace', () => {
    expect(EST_GRACE_MS).toBeGreaterThanOrEqual(500)
    expect(EST_GIVEUP_MS).toBeGreaterThan(EST_GRACE_MS)
    expect(EST_GIVEUP_MS).toBeLessThanOrEqual(4000)
  })
})

describe('estimateAllowed', () => {
  const base = { sawRealSignal: false, estBlocked: false }

  it('only fires inside the grace…giveup focus window', () => {
    expect(
      estimateAllowed({ ...base, elapsedSinceFocusMs: EST_GRACE_MS - 1 }),
    ).toBe(false)
    expect(
      estimateAllowed({ ...base, elapsedSinceFocusMs: EST_GRACE_MS }),
    ).toBe(true)
    expect(
      estimateAllowed({ ...base, elapsedSinceFocusMs: EST_GIVEUP_MS }),
    ).toBe(true)
    expect(
      estimateAllowed({ ...base, elapsedSinceFocusMs: EST_GIVEUP_MS + 1 }),
    ).toBe(false)
  })

  it('never fires once a real signal was seen this session', () => {
    // The external-keyboard latch: on devices where the native var works,
    // silence proves no keyboard is up — a guess would phantom-lift.
    expect(
      estimateAllowed({
        sawRealSignal: true,
        estBlocked: false,
        elapsedSinceFocusMs: EST_GRACE_MS + 100,
      }),
    ).toBe(false)
  })

  it('never fires once the focus session was marked keyboard-free', () => {
    expect(
      estimateAllowed({
        sawRealSignal: false,
        estBlocked: true,
        elapsedSinceFocusMs: EST_GRACE_MS + 100,
      }),
    ).toBe(false)
  })
})

describe('real-signal latch persistence', () => {
  const makeStorage = () => {
    const map = new Map<string, string>()
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    }
  }

  it('round-trips the flag so every future session skips the estimate', () => {
    const storage = makeStorage()
    expect(readSignalFlag(storage)).toBe(false)
    writeSignalFlag(storage)
    expect(readSignalFlag(storage)).toBe(true)
    expect(storage.getItem(KB_SIGNAL_FLAG_KEY)).toBe('1')
  })

  it('tolerates missing or throwing storage', () => {
    expect(readSignalFlag(null)).toBe(false)
    expect(() => writeSignalFlag(null)).not.toThrow()
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readSignalFlag(broken)).toBe(false)
    expect(() => writeSignalFlag(broken)).not.toThrow()
  })
})
