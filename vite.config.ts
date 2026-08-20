import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const commonPolicy = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
];

export default defineConfig(({ command }) => {
  const development = command === "serve";
  const policy = [
    ...commonPolicy,
    development ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    development
      ? "connect-src 'self' ws://127.0.0.1:4178 http://127.0.0.1:4178"
      : "connect-src 'none'",
  ].join("; ");

  return {
    plugins: [
      react(),
      {
        name: "persona-content-security-policy",
        transformIndexHtml: (html) => html.replace("__PERSONA_CSP__", policy),
      },
    ],
    root: ".",
    base: "./",
    build: {
      outDir: "dist",
      emptyOutDir: true,
      target: "chrome138",
      sourcemap: false,
    },
    server: {
      host: "127.0.0.1",
      port: 4178,
      strictPort: true,
      watch: {
        ignored: ["**/build/**", "**/release/**"],
      },
    },
  };
});
