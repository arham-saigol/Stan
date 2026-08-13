import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli/index.ts", "src/gateway/daemon.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: false,
  sourcemap: true,
  removeNodeProtocol: false,
});
