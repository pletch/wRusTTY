/** The audible half of the terminal bell: one synthesized tone (no asset,
 * decode or license question). Soft and brief, since some shells ring in
 * bursts on ambiguous completion. */

let ctx: AudioContext | null = null

/** Created on first use: a context created before a user gesture stays
 * suspended under the autoplay policy. */
function audioContext(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext()
    } catch {
      // No Web Audio; the visual marker still works.
      return null
    }
  }
  return ctx
}

export function playBell() {
  const audio = audioContext()
  if (!audio) return
  // Browsers can suspend a context after silence too, so always resume.
  if (audio.state === 'suspended') audio.resume().catch(() => {})

  const now = audio.currentTime
  const osc = audio.createOscillator()
  const gain = audio.createGain()
  osc.type = 'sine'
  osc.frequency.value = 880

  // Ramped in and out: an abrupt edge on a sine wave is an audible click.
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(0.06, now + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18)

  osc.connect(gain).connect(audio.destination)
  osc.start(now)
  osc.stop(now + 0.2)
  // One-shot nodes are released so bursts don't accumulate them.
  osc.onended = () => {
    osc.disconnect()
    gain.disconnect()
  }
}
