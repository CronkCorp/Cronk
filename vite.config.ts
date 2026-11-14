import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The web client. `npm run dev:web` serves it with the API proxied to `npm run dev` on port 3000.
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:3000" } },
});
