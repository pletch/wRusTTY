import tailwindcssAnimate from 'tailwindcss-animate'

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'media',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // The chrome tone, flipped to black over light themes (chromeRgb in
        // src/lib/theme.ts sets it). <alpha-value> keeps `/40` and the like
        // working.
        chrome: 'rgb(var(--chrome-rgb) / <alpha-value>)',
        // Floating surfaces (dialogs, menus, popovers, toasts), a few levels off
        // the terminal and following the theme (surfaceRgb in src/lib/theme.ts).
        surface: 'rgb(var(--surface-rgb) / <alpha-value>)',
      },
      // App-wide motion tokens, so transitions share one character.
      transitionTimingFunction: {
        // Decelerate curve: quick to start, gentle to settle.
        swift: 'cubic-bezier(0.2, 0, 0, 1)',
      },
      transitionDuration: {
        fast: '120ms', // hover + color feedback
        base: '200ms', // most state transitions
        slow: '320ms', // panels, toasts, larger moves
      },
      keyframes: {
        // Indeterminate progress in the tab strip's pane map: a block sweeping
        // across the running pane's segment (a sweep, unlike the amber
        // "wants attention" pulse). `left: 100%` with `translateX(-100%)` keeps it
        // flush at both ends whatever its width.
        'pane-run': {
          from: { left: '0%', transform: 'translateX(0)' },
          to: { left: '100%', transform: 'translateX(-100%)' },
        },
        // The resting counterpart, breathing mid-segment: "this pane wants you"
        // (a command finished or the bell rang elsewhere), and the reduced-motion
        // substitute for pane-run.
        'pane-glow': {
          '0%, 100%': { opacity: '0.35' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        // `alternate` sweeps back and forth, eased into each turn, slow enough to
        // read as ambient.
        'pane-run': 'pane-run 2.3s cubic-bezier(0.4, 0, 0.6, 1) infinite alternate',
        'pane-glow': 'pane-glow 2.4s ease-in-out infinite',
      },
    },
  },
  plugins: [tailwindcssAnimate],
}
