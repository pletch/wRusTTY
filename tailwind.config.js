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
    },
  },
  plugins: [tailwindcssAnimate],
}
