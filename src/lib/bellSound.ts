/** The audible half of the terminal bell.
 *
 * Synthesised rather than shipped as an audio file: it's one short tone, and
 * generating it avoids a binary asset in the bundle, a decode step, and the
 * question of what licence the sample is under. It also can't fail to load.
 *
 * Deliberately soft and brief. A terminal bell fires on tab-completion
 * ambiguity in some shells, so it can arrive in bursts — anything sharp
 * enough to be startling once is intolerable five times in a row. */

let ctx: AudioContext | null = null

/** Created on first use, not at import: constructing an AudioContext before
 * the page has seen a user gesture leaves it suspended under the browser's
 * autoplay policy, and a suspended context created at startup stays that way
 * even once the user does interact. */
function audioContext(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext()
    } catch {
      // No Web Audio (or it's been disabled). The visual marker still works,
      // so there's nothing to report — silently having no sound is the whole
      // failure.
      return null
    }
  }
  return ctx
}

export function playBell() {
  const audio = audioContext()
  if (!audio) return
  // A context can be suspended by the browser after a period of silence, not
  // only before the first gesture — resume unconditionally rather than only
  // on the first call.
  if (audio.state === 'suspended') audio.resume().catch(() => {})

  const now = audio.currentTime
  const osc = audio.createOscillator()
  const gain = audio.createGain()
  osc.type = 'sine'
  osc.frequency.value = 880

  // Ramped in and out rather than started and stopped at full volume: an
  // abrupt edge on a sine wave is a click, which is more audible than the
  // tone itself and reads as a glitch rather than a bell.
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(0.06, now + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18)

  osc.connect(gain).connect(audio.destination)
  osc.start(now)
  osc.stop(now + 0.2)
  // Nodes are one-shot; releasing them here keeps a burst of bells from
  // accumulating disconnected graph nodes for the GC to find later.
  osc.onended = () => {
    osc.disconnect()
    gain.disconnect()
  }
}
