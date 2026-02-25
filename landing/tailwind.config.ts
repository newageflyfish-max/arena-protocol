import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        navy: {
          800: "#1E3050",
          900: "#1B2A4A",
          950: "#0F1A2E",
          1000: "#080E1A",
        },
        accent: {
          blue: "#3B82F6",
          cyan: "#06B6D4",
          green: "#10B981",
          red: "#EF4444",
          amber: "#F59E0B",
        },
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Fira Code", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
