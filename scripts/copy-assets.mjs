import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/skills", { recursive: true });
await mkdir("dist/gateway/templates", { recursive: true });
await mkdir("dist/cli/templates", { recursive: true });
await cp("src/skills", "dist/skills", { recursive: true, force: true });
await cp("src/workspace/templates", "dist/gateway/templates", {
  recursive: true,
  force: true,
});
await cp("src/workspace/templates", "dist/cli/templates", {
  recursive: true,
  force: true,
});
