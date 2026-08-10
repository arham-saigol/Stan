import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineSkill } from "@flue/runtime";

export const voiceSkill = loadSkill("voice");
export const stanSkill = loadSkill("stan");

function loadSkill(directory: string) {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, directory, "SKILL.md"),
    join(here, "skills", directory, "SKILL.md"),
    join(here, "..", "skills", directory, "SKILL.md"),
  ];
  let source: string | undefined;
  for (const candidate of candidates) {
    try {
      source = readFileSync(candidate, "utf8");
      break;
    } catch {
      /* try packaged location */
    }
  }
  if (!source) throw new Error(`Packaged skill ${directory} is missing`);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error(`Skill ${directory} has invalid frontmatter`);
  const fields = Object.fromEntries(
    match[1]!.split(/\r?\n/).map((line) => {
      const separator = line.indexOf(":");
      return [
        line.slice(0, separator).trim(),
        line.slice(separator + 1).trim(),
      ];
    }),
  );
  return defineSkill({
    name: fields.name!,
    description: fields.description!,
    instructions: match[2]!.trim(),
  });
}
