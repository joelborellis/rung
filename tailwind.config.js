/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // Spec §8: the token system is the theme. Everything resolves to a CSS
    // variable declared in :root so it stays inspectable and themeable.
    extend: {
      colors: {
        ink: 'var(--ink)',
        surface: 'var(--surface)',
        card: 'var(--card)',
        line: 'var(--line)',
        accent: 'var(--accent)',
        flag: 'var(--flag)',
        'tier-0': 'var(--tier-0)',
        'tier-1': 'var(--tier-1)',
        'tier-2': 'var(--tier-2)',
        'tier-3': 'var(--tier-3)',
      },
      fontFamily: {
        display: ['Schibsted Grotesk', 'system-ui', 'sans-serif'],
        sans: ['IBM Plex Sans', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // Spec §8 scale: 13 / 15 / 17 / 22 / 28
        xs: ['11px', { lineHeight: '1.4' }],
        sm: ['13px', { lineHeight: '1.5' }],
        base: ['15px', { lineHeight: '1.6' }],
        md: ['17px', { lineHeight: '1.5' }],
        lg: ['22px', { lineHeight: '1.3' }],
        xl: ['28px', { lineHeight: '1.2' }],
      },
      borderRadius: {
        card: '10px',
      },
      boxShadow: {
        // The only shadow in the system (§8): modals.
        modal: '0 12px 40px -8px rgba(28, 43, 51, 0.22)',
      },
      transitionDuration: {
        DEFAULT: '150ms',
      },
    },
  },
  plugins: [],
};
