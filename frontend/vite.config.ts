import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server runs on :5173. The API proxy forwards /api/* to the Flask backend
// (default :5001). Set CDV_API_URL to point at a different host if needed.
const apiUrl = process.env.CDV_API_URL || "http://127.0.0.1:5001";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiUrl,
        changeOrigin: true,
      },
    },
  },
});
