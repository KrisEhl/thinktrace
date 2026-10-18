import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VITE_API_URL (e.g. http://localhost:8000) switches the app from the in-browser mock to the real backend.
export default defineConfig({ plugins: [react()] });
