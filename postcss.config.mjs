import tailwind from "@tailwindcss/postcss";
import textScale from "./scripts/postcss-text-scale.mjs";

const config = {
  plugins: [
    tailwind(),
    // Larger text: font sizes and line heights follow --text-scale (scripts/postcss-text-scale.mjs).
    textScale(),
  ],
};

export default config;
