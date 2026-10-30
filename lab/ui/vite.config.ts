import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// In development Vite serves the UI and sends /api to the bun server (server/index.ts).
export default defineConfig({
    plugins: [vue()],
    server: {
        host: "127.0.0.1",
        port: 5173,
        proxy: { "/api": `http://127.0.0.1:${process.env.LAB_UI_PORT ?? 4173}` },
    },
});
