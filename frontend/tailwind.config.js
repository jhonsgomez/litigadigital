/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        legalBlue: '#0A57A7', // Tu azul institucional
      }
    },
  },
  plugins: [],
}