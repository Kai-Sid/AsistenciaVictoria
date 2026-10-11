import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
export default defineConfig({
  server: { port: 5174, strictPort: true },
  preview: { port: 5174, strictPort: true },
  plugins: [react(), VitePWA({
  registerType: "autoUpdate",
  manifest: { name: "AsistenciaVictoria", short_name: "AsistenciaVictoria", description: "Control de asistencia del personal", theme_color: "#101010", background_color: "#101010", display: "standalone", scope: "/", start_url: "/", icons: [
    { src: "/pwa-192.svg", sizes: "192x192", type: "image/svg+xml", purpose: "any" },
    { src: "/pwa-512.svg", sizes: "512x512", type: "image/svg+xml", purpose: "any" }
  ]}
})] });