/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: '#3b82f6',
        secondary: '#10b981',
      },
      // Documents travelling along a lane on the login page. Three packets share one 7.2s loop, 2.4s apart.
      keyframes: {
        'flow-right': {
          '0%': { left: '0%', opacity: '0', transform: 'translateX(-50%) scale(.8)' },
          '8%': { opacity: '1', transform: 'translateX(-50%) scale(1)' },
          '92%': { opacity: '1', transform: 'translateX(-50%) scale(1)' },
          '100%': { left: '100%', opacity: '0', transform: 'translateX(-50%) scale(.8)' },
        },
        'flow-left': {
          '0%': { left: '100%', opacity: '0', transform: 'translateX(-50%) scale(.8)' },
          '8%': { opacity: '1', transform: 'translateX(-50%) scale(1)' },
          '92%': { opacity: '1', transform: 'translateX(-50%) scale(1)' },
          '100%': { left: '0%', opacity: '0', transform: 'translateX(-50%) scale(.8)' },
        },
        'rise-in': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'flow-right': 'flow-right 7.2s ease-in-out infinite backwards',
        'flow-left': 'flow-left 7.2s ease-in-out infinite backwards',
        'rise-in': 'rise-in .6s ease-out both',
      },
    },
  },
  plugins: [],
};
