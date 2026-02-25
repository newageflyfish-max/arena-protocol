import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        navy: {
          50: '#E7EBF3',
          100: '#CED7E7',
          200: '#9DAFCF',
          300: '#6C87B7',
          400: '#4A6A9A',
          500: '#3A5580',
          600: '#2E4468',
          700: '#253758',
          800: '#1F2E4A',
          900: '#1B2A4A',
          950: '#0F1A2E',
        },
        'arena-green': '#10B981',
        'arena-red': '#EF4444',
        'arena-amber': '#F59E0B',
        'arena-blue': '#3B82F6',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
