import { useEffect, useState } from 'react'
import type { RefObject } from 'react'

import type { App } from 'obsidian'

import { bootLog } from '../../utils/bootLog'

/**
 * On-screen keyboard adaptation for the chat panel, unified across all four
 * mobile placements (Android/iPad × main area/side drawer).
 *
 * OUTPUT CONTRACT (consumed by styles.css — do not rename):
 *  - `.is-keyboard` class on the chat root (zeros safe-area / 66px paddings)
 *  - `--ai-kb`  = keyboard height in px (root padding-bottom pushes the
 *                 composer's bottom edge flush against the keyboard top)
 *  - `--ai-vvh` = remaining visible viewport height (caps popup max-height)
 *
 * HEIGHT SOURCES, highest trust first:
 *  1. Obsidian native `--keyboard-height` on <html> — maintained by Obsidian
 *     itself from the native keyboard insets (this is what Copilot reads too).
 *  2. VisualViewport inset — reliable on iPhone; silent on iPad WKWebView and
 *     unreliable on some Android WebViews, hence source 1 leads.
 *  3. Ratio-based estimate — last resort only, while a textarea holds focus
 *     and neither real source reports (legacy iPad path).
 *
 * Replaces the old focus-estimate/lock/500ms-poll stack in Chat.tsx.
 */

/** Dead zone: anything below this is not a keyboard. */
export const KB_DEADZONE_PX = 40

/**
 * Estimate-path gating (iPad + EXTERNAL keyboard fix). With a hardware
 * keyboard attached, iPadOS shows no on-screen keyboard, so the native var
 * and visualViewport both stay 0 forever — the old estimate kicked in on
 * every focus and lifted the composer for a keyboard that isn't there.
 * Device logs proved the native var fires EVERY time the on-screen keyboard
 * opens on this iPad, so a missing real signal genuinely means "no
 * keyboard". Two gates, strongest first:
 *  1. REAL-SEEN LATCH: once any real signal landed in this plugin session,
 *     the estimate is disabled PERMANENTLY — signals demonstrably work
 *     here, so silence = no keyboard (external keyboard case, zero lift).
 *  2. GRACE/GIVEUP window: only before any real signal was ever seen.
 *     Below GRACE the estimate stays off; between GRACE and GIVEUP it is
 *     allowed (legacy silent-iPad path); after GIVEUP with still nothing
 *     we conclude "no keyboard" for this focus session.
 */
export const EST_GRACE_MS = 900
export const EST_GIVEUP_MS = 1600

/** localStorage key persisting the real-signal latch across app restarts. */
export const KB_SIGNAL_FLAG_KEY = 'UNagent-kb-real-signal'

type MiniStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * Persisted REAL-SEEN LATCH (external-keyboard fix, final form). The
 * in-memory latch reset on every app restart, so a fresh session with an
 * external keyboard still ran the estimate window — the user-visible
 * "抬起来→停一下→收回去". Device logs prove the native signal fires every
 * on-screen open, so once it EVER worked on this device, silence means
 * "no keyboard" forever. Persisting the flag in localStorage kills the
 * estimate path permanently on such devices. Pure helpers — unit-tested.
 */
export function readSignalFlag(storage: MiniStorage | null): boolean {
  try {
    return storage?.getItem(KB_SIGNAL_FLAG_KEY) === '1'
  } catch {
    return false
  }
}

export function writeSignalFlag(storage: MiniStorage | null): void {
  try {
    storage?.setItem(KB_SIGNAL_FLAG_KEY, '1')
  } catch {
    // Storage may be full/blocked — the in-memory latch still covers this
    // session; never throw from a layout path.
  }
}

/**
 * Whether the ratio estimate may fire at all, given the session state.
 * Pure — unit-tested. Real signal seen once (this session OR persisted)
 * → never estimate again (silence means no keyboard). Otherwise the
 * GRACE/GIVEUP focus window decides.
 */
export function estimateAllowed(opts: {
  sawRealSignal: boolean
  estBlocked: boolean
  elapsedSinceFocusMs: number
}): boolean {
  if (opts.sawRealSignal) return false
  if (opts.estBlocked) return false
  const e = opts.elapsedSinceFocusMs
  return e >= EST_GRACE_MS && e <= EST_GIVEUP_MS
}

/** Parse a CSS pixel value ('340px' → 340); garbage/empty → 0. */
export const parseCssPx = (value: string): number => {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Keyboard inset from the two real sources, whichever reports more.
 * Pure — unit-tested in useKeyboardLift.test.ts.
 */
export function keyboardInsetFrom(opts: {
  /** Computed value of Obsidian's native `--keyboard-height` (may be ''). */
  nativeCss: string
  /** window.innerHeight */
  innerHeight: number
  /** visualViewport, when available */
  vv: { height: number; offsetTop: number } | null
}): number {
  const native = parseCssPx(opts.nativeCss)
  const vvInset = opts.vv
    ? Math.max(0, opts.innerHeight - opts.vv.height - opts.vv.offsetTop)
    : 0
  return Math.max(native, vvInset)
}

/**
 * Ratio-based fallback height for environments where no real source reports
 * (iPad WKWebView). Conservative cap so a wrong estimate never pushes the
 * composer absurdly high; corrected as soon as a real signal arrives. The
 * cap sits just above the tallest real-world iPad portrait keyboard (~350px
 * with the floating format bar): the old 420 cap over-lifted the composer
 * by ~half an input-box height on iPad portrait (formula 0.38×1180=448 →
 * clamped 420 vs actual ~350). Over-lift leaves a dead gap; slight
 * under-lift keeps the composer touching the keyboard — prefer the latter.
 */
export function estimateKbHeight(innerHeight: number, innerWidth: number): number {
  const isPortrait = innerHeight > innerWidth
  const ratio = isPortrait ? 0.38 : 0.48
  return Math.min(Math.round(innerHeight * ratio), 360)
}

/**
 * How far the chat root's own bottom edge sits ABOVE the window bottom.
 * Obsidian lifts/shrinks its own workspace containers when the keyboard
 * opens (iPad side drawer most aggressively — boot-log diag showed
 * delta≈final≈412 there, i.e. the container was pre-lifted by ~the full
 * keyboard height and our inset double-counted it). Anything the container
 * already gained must be subtracted from the inset we apply. Pure — unit
 * tested. Negative (offscreen/transition) and invalid rects clamp to 0.
 */
export function containerLift(rootBottom: number, innerHeight: number): number {
  // Negative/invalid bottom = container offscreen or mid-transition — no
  // trustworthy lift signal, report 0 (device log saw delta=-315 during a
  // view slide-in; over-compensating there would make things worse).
  if (
    !Number.isFinite(rootBottom) ||
    !Number.isFinite(innerHeight) ||
    rootBottom < 0
  ) {
    return 0
  }
  return Math.max(0, Math.round(innerHeight - rootBottom))
}

/** Inset actually applied after compensating the container's own lift. */
export function effectiveInset(kb: number, lift: number): number {
  return Math.min(Math.max(kb - lift, 0), kb)
}

export const useKeyboardLift = (
  rootRef: RefObject<HTMLDivElement | null>,
  app?: App,
): boolean => {
  const [keyboardOpen, setKeyboardOpen] = useState(false)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    // Desktop has no soft keyboard. Without this guard the estimate
    // fallback would apply a fake height on any textarea focus.
    const hasTouch =
      'ontouchstart' in window || navigator.maxTouchPoints > 0
    if (!hasTouch) return

    const doc = root.ownerDocument
    const win = doc.defaultView ?? window
    const vv = win.visualViewport ?? null

    let rafId: number | null = null
    let lastApplied = -1
    let lastInset = -1
    let wasOpen = false
    // Estimate gating state (external-keyboard fix): when the textarea most
    // recently gained focus, whether we've given up on an on-screen keyboard
    // for this focus session, and the REAL-SEEN LATCH — once a real signal
    // landed (ever, persisted across restarts) the estimate never fires
    // again: silence then provably means "no keyboard".
    let focusAt = 0
    let estBlocked = false
    let sawRealSignal = readSignalFlag(
      (win as unknown as { localStorage?: MiniStorage }).localStorage ?? null,
    )
    // Cache of the native var for MutationObserver throttling (Obsidian may
    // rewrite <html>'s style attribute for unrelated reasons; re-scheduling
    // a full sync for every such write is wasted layout work — that was the
    // "感觉有些卡" suspect).
    let lastNativeRaw = doc.documentElement.style.getPropertyValue(
      '--keyboard-height',
    )

    const rootLift = () =>
      containerLift(root.getBoundingClientRect().bottom, win.innerHeight)

    const apply = (kb: number, force = false) => {
      if (!force && kb === lastApplied) return
      lastApplied = kb
      const lift = rootLift()
      const inset = effectiveInset(kb, lift)
      if (inset === lastInset) return
      lastInset = inset
      const nowOpen = inset > 0
      setKeyboardOpen(nowOpen)
      root.style.setProperty('--ai-kb', `${inset}px`)
      root.style.setProperty('--ai-vvh', `${win.innerHeight - inset}px`)
      // Device diagnostics (same boot-log the Android auto-disable hunt
      // used): one line per open/close transition with the full source
      // breakdown, plus how far the composer's bottom edge actually landed
      // from the keyboard top (positive = floating ABOVE the keyboard,
      // negative = hidden behind it). This is what pinpoints which view's
      // over-lift comes from which source. The delta read is DEFERRED:
      // the is-keyboard class commits via React and the padding animates
      // (0.15s transition), so measuring immediately would capture the
      // pre-lift position.
      if (app && nowOpen !== wasOpen) {
        wasOpen = nowOpen
        const m = measure()
        const openNow = nowOpen
        const finalNow = inset
        win.setTimeout(() => {
          const rect = root.getBoundingClientRect()
          const compBottom = root
            .querySelector('.obsidian-ai-composer-wrap')
            ?.getBoundingClientRect().bottom
          const delta =
            compBottom === undefined
              ? NaN
              : Math.round(win.innerHeight - finalNow - compBottom)
          void bootLog(
            app,
            openNow
              ? `diag:kb-open src=${m.usedEstimate ? 'est' : 'real'} native=${m.native} vv=${m.vvInset} est=${m.usedEstimate ? m.kb : 0} final=${finalNow} lift=${containerLift(rect.bottom, win.innerHeight)} delta=${delta}`
              : `diag:kb-close final=${finalNow} seen=${sawRealSignal ? 1 : 0} blocked=${estBlocked ? 1 : 0}`,
          )
        }, 400)
      }
    }

    const measure = (): {
      kb: number
      real: boolean
      native: number
      vvInset: number
      usedEstimate: boolean
    } => {
      // Inline style read (not getComputedStyle): Obsidian writes the var
      // inline on <html>, and the inline read avoids forcing a style
      // recalculation on every sync — matters during keyboard animation.
      const nativeCss = doc.documentElement.style.getPropertyValue(
        '--keyboard-height',
      )
      const native = parseCssPx(nativeCss)
      const vvInset = vv
        ? Math.max(0, win.innerHeight - vv.height - vv.offsetTop)
        : 0
      const raw = Math.max(native, vvInset)
      if (raw > KB_DEADZONE_PX) {
        // Real signal works on this device — latch off the estimate for the
        // rest of this session AND persist it, so every future session
        // (every app restart) skips the estimate too (external-keyboard
        // silence is then proof of "no keyboard", not a gap to guess at).
        if (!sawRealSignal) {
          sawRealSignal = true
          writeSignalFlag(
            (win as unknown as { localStorage?: MiniStorage }).localStorage ??
              null,
          )
        }
        return { kb: raw, real: true, native, vvInset, usedEstimate: false }
      }
      // Last resort: an estimate is valid only while a textarea holds focus
      // and only inside the gating window — see estimateAllowed().
      if (
        doc.activeElement?.tagName === 'TEXTAREA' &&
        estimateAllowed({
          sawRealSignal,
          estBlocked,
          elapsedSinceFocusMs: Date.now() - focusAt,
        })
      ) {
        const est = estimateKbHeight(win.innerHeight, win.innerWidth)
        return { kb: est, real: false, native, vvInset, usedEstimate: true }
      }
      // Past the give-up point with still no real signal: mark this focus
      // session keyboard-free (external keyboard). Re-check ONCE shortly
      // after — the on-screen signal can land just late; if it does, the
      // latch above takes over; if not, the block sticks.
      if (
        !sawRealSignal &&
        !estBlocked &&
        doc.activeElement?.tagName === 'TEXTAREA' &&
        Date.now() - focusAt > EST_GIVEUP_MS
      ) {
        estBlocked = true
        win.setTimeout(() => {
          if (!sawRealSignal) schedule()
        }, 600)
      }
      return { kb: 0, real: false, native, vvInset, usedEstimate: false }
    }

    // rAF coalescing: keyboard slides fire dozens of resize/mutation events;
    // applying once per frame keeps the CSS transition smooth and avoids
    // layout thrash mid-animation.
    const sync = () => {
      const { kb } = measure()
      apply(kb)
    }
    const schedule = () => {
      if (rafId !== null) win.cancelAnimationFrame(rafId)
      rafId = win.requestAnimationFrame(() => {
        rafId = null
        sync()
      })
    }

    if (vv) {
      vv.addEventListener('resize', schedule)
      vv.addEventListener('scroll', schedule)
    }
    win.addEventListener('resize', schedule)
    win.addEventListener('orientationchange', schedule)

    // Obsidian rewrites `--keyboard-height` on <html>'s style attribute;
    // observe that directly — this catches Android cases where
    // visualViewport stays silent. THROTTLED: only schedule when the var
    // actually changed, so unrelated html-style writes don't trigger work.
    const htmlObserver = new MutationObserver(() => {
      const v = doc.documentElement.style.getPropertyValue('--keyboard-height')
      if (v === lastNativeRaw) return
      lastNativeRaw = v
      schedule()
    })
    htmlObserver.observe(doc.documentElement, {
      attributes: true,
      attributeFilter: ['style'],
    })

    // Focus signals: instant reaction (the estimate path makes the composer
    // start moving before any real signal lands) and a delayed recheck for
    // slow environments. Also the close backup: some keyboards dismiss
    // without a resize event AND without blurring the textarea.
    const onFocusIn = (e: FocusEvent) => {
      if ((e.target as HTMLElement)?.tagName !== 'TEXTAREA') return
      // Fresh focus session: restart the estimate window (unblocks the
      // external-keyboard conclusion from the previous session; the
      // real-seen latch survives this on purpose).
      focusAt = Date.now()
      estBlocked = false
      schedule()
      // The delayed rechecks double as LIFT catch-up: Obsidian may lift
      // its container only after the keyboard starts sliding, so the
      // first apply sees lift=0 and over-insets; re-measuring after the
      // settle lets effectiveInset subtract the container's own lift.
      // The GRACE+200 tick is the first sample inside the estimate window.
      for (const d of [150, 400, 900, EST_GRACE_MS + 200, EST_GIVEUP_MS + 300]) {
        win.setTimeout(schedule, d)
      }
    }
    const onFocusOut = (e: FocusEvent) => {
      if ((e.target as HTMLElement)?.tagName !== 'TEXTAREA') return
      win.setTimeout(() => {
        if (doc.activeElement?.tagName !== 'TEXTAREA') {
          lastApplied = -1
          lastInset = -1
          apply(0)
        }
      }, 150)
    }
    root.addEventListener('focusin', onFocusIn)
    root.addEventListener('focusout', onFocusOut)

    // Safety net (kept from the old stack): iOS can dismiss the keyboard
    // via swipe-down / dismiss button with NO resize event and NO blur.
    // Poll only while we believe a keyboard is open; the measure() estimate
    // gate (activeElement) keeps a wrong estimate from resurrecting. Also
    // catches late container lift changes while the keyboard stays open.
    const safetyInterval = win.setInterval(() => {
      if (lastApplied <= 0) return
      const { kb } = measure()
      // force=true: keyboard height may be unchanged while the container
      // lift moved underneath us — still re-derive the inset.
      apply(kb, true)
    }, 500)

    // Initial sync — the keyboard may already be open when the view mounts
    // (e.g. view restored while typing elsewhere).
    sync()

    return () => {
      htmlObserver.disconnect()
      if (vv) {
        vv.removeEventListener('resize', schedule)
        vv.removeEventListener('scroll', schedule)
      }
      win.removeEventListener('resize', schedule)
      win.removeEventListener('orientationchange', schedule)
      root.removeEventListener('focusin', onFocusIn)
      root.removeEventListener('focusout', onFocusOut)
      if (rafId !== null) win.cancelAnimationFrame(rafId)
      win.clearInterval(safetyInterval)
    }
  }, [rootRef])

  return keyboardOpen
}
