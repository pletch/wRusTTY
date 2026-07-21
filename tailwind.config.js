import tailwindcssAnimate from 'tailwindcss-animate'

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'media',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // App-wide motion vocabulary. Using these named tokens instead of
      // Tailwind's default `ease`/ad-hoc `duration-150` everywhere keeps
      // every transition sharing one character — the mark of an authored
      // UI rather than a pile of independent guesses.
      transitionTimingFunction: {
        // Signature decelerate curve: quick to start, gentle to settle.
        // Reads as "native/considered" next to the linear-ish default.
        swift: 'cubic-bezier(0.2, 0, 0, 1)',
      },
      transitionDuration: {
        fast: '120ms', // hover + color feedback
        base: '200ms', // most state transitions
        slow: '320ms', // panels, toasts, larger moves
      },
      keyframes: {
        // Indeterminate progress for the tab strip's pane map — a solid block
        // travelling across the segment of whichever pane is running a
        // command. Deliberately a sweep rather than a pulse: "in progress"
        // rather than "wants attention", which is what the amber
        // animate-pulse marker on the same tab already means.
        //
        // Travels flush-left to flush-right whatever its own width and
        // whatever the segment's — `left: 100%` puts its leading edge at the
        // far end, and the paired `translateX(-100%)` pulls it back by
        // exactly its own width to sit flush. That pairing is why nothing
        // here needs to know the marker is 28px: an earlier version encoded
        // the travel as a percentage of the element, which silently broke
        // whenever the width changed.
        'pane-run': {
          from: { left: '0%', transform: 'translateX(0)' },
          to: { left: '100%', transform: 'translateX(-100%)' },
        },
        // The resting counterpart: the same marker parked in the middle of
        // its segment, breathing. Used for "this pane wants you" — a command
        // finished or the bell rang while you were elsewhere — and reused as
        // the reduced-motion substitute for pane-run, since it conveys
        // "active" with no travel at all.
        'pane-glow': {
          '0%, 100%': { opacity: '0.35' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        // `alternate` is what makes it sweep back and forth instead of
        // snapping back to the left each cycle — the reversal is the part
        // that reads as activity at this size. Eased at both ends so it
        // decelerates into each turn rather than bouncing mechanically,
        // and slow enough to read as an ambient "still working" rather than
        // something demanding attention.
        'pane-run': 'pane-run 2.3s cubic-bezier(0.4, 0, 0.6, 1) infinite alternate',
        'pane-glow': 'pane-glow 2.4s ease-in-out infinite',
      },
    },
  },
  plugins: [tailwindcssAnimate],
}
