import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "^/(agents|events|services|yield|vault|pay|payments|health|config|datasets|products|daemon|nostr|audit|demo)(/|$)": "http://localhost:4402",
    },
  },
});
