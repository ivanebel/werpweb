/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/views/**/*.ejs', './public/js/**/*.js'],
  theme: {
    extend: {
      fontFamily: {
        outfit: ['Outfit', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'sans-serif'],
      },
      colors: {
        brand: {
          50: '#ecf3ff',
          100: '#dde9ff',
          200: '#c2d6ff',
          300: '#9cb9ff',
          400: '#7592ff',
          500: '#465fff',
          600: '#3641f5',
          700: '#2a31d8',
          800: '#252dae',
          900: '#262e89',
          950: '#16194f',
        },
        success: {
          50: '#ecfdf3',
          100: '#d1fadf',
          200: '#a6f4c5',
          300: '#6ce9a6',
          400: '#32d583',
          500: '#12b76a',
          600: '#039855',
          700: '#027a48',
          800: '#05603a',
          900: '#054f31',
        },
        error: {
          50: '#fef3f2',
          100: '#fee4e2',
          200: '#fecdca',
          300: '#fda29b',
          400: '#f97066',
          500: '#f04438',
          600: '#d92d20',
          700: '#b42318',
          800: '#912018',
          900: '#7a271a',
        },
        warning: {
          50: '#fffaeb',
          100: '#fef0c7',
          200: '#fedf89',
          300: '#fec84b',
          400: '#fdb022',
          500: '#f79009',
          600: '#dc6803',
          700: '#b54708',
          800: '#93370d',
          900: '#7a2e0e',
        },
        'blue-light': {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#b9e6fe',
          300: '#7cd4fd',
          400: '#36bffa',
          500: '#0ba5ec',
          600: '#0086c9',
          700: '#026aa2',
          800: '#065986',
          900: '#0b4a6f',
        },
      },
      boxShadow: {
        'theme-sm': '0px 1px 3px 0px rgba(16, 24, 40, 0.05)',
        'theme-md': '0px 4px 8px -2px rgba(16, 24, 40, 0.1), 0px 2px 4px -2px rgba(16, 24, 40, 0.06)',
        'theme-lg': '0px 12px 16px -4px rgba(16, 24, 40, 0.08), 0px 4px 6px -2px rgba(16, 24, 40, 0.03)',
      },
      zIndex: {
        999: '999',
        9999: '9999',
      },
    },
  },
  safelist: [
    {
      pattern:
        /^(bg|text|ring)-(success|error|warning|blue-light|purple|gray)-(50|100|200|300|400|500|600|700|800|900)$/,
      variants: ['dark', 'hover'],
    },
    {
      pattern:
        /^(bg|text|ring)-(success|error|warning|blue-light|purple|gray)-(50|100|200|300|400|500|600|700|800|900)\/(10|15|20|30)$/,
      variants: ['dark', 'hover'],
    },
  ],
  plugins: [],
};
