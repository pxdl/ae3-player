import { defineConfig } from "vite";

/* Served from GitHub Pages at https://<user>.github.io/ae3-player/ (plan
 * §9.2); dev + preview mirror the same base so path handling never differs
 * between local testing and production. */
export default defineConfig({
    base: "/ae3-player/",
});
