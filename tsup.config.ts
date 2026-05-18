import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  sourcemap: true,
  splitting: false,
  bundle: true,
});
