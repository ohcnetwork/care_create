import { execa, type ResultPromise } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import type { CreateManifest, Runtime } from "../types.js";
import { appendMissingLines } from "./env.js";

export const COMPOSE_FILES = ["-f", "docker-compose.yaml", "-f", "docker-compose.local.yaml"];

// care's dev.Dockerfile bakes the ADDITIONAL_PLUGS build arg into the image's ENV. Installing plugs only needs the list, so
// drop their configs, which can hold secrets (e.g. ABDM credentials); containers read the full value from docker/.local.env.
export function buildArgPlugs(additionalPlugs: string): string {
  if (!additionalPlugs) {
    return "";
  }
  try {
    const plugs = JSON.parse(additionalPlugs) as Record<string, unknown>[];
    return JSON.stringify(plugs.map(({ configs: _configs, ...plug }) => plug));
  } catch {
    // care skips an ADDITIONAL_PLUGS it can't parse, so passing nothing builds the same image without the secrets.
    return "";
  }
}

// dev.Dockerfile also copies the whole backend dir into the image, and care's .dockerignore doesn't exclude the env files
// this CLI writes plug configs to.
export async function keepEnvFilesOutOfImage(backendPath: string): Promise<void> {
  await appendMissingLines(path.join(backendPath, ".dockerignore"), [".env", "docker/.local.env"]);
}

// Compose defaults the project name to the backend dir ("care"), so every care checkout would share one set of
// volumes (care_postgres-data, ...). Derive a name unique to this setup instead.
export function composeProjectName(targetPath: string): string {
  const slug = path.basename(targetPath).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  const hash = createHash("sha256").update(targetPath).digest("hex").slice(0, 8);
  return `${slug || "care"}-${hash}`;
}

export async function readManifest(targetPath: string): Promise<CreateManifest> {
  const file = path.join(targetPath, ".care-create.json");
  if (!existsSync(file)) {
    throw new Error(`No .care-create.json found in ${targetPath}. Run 'care create' first.`);
  }
  return JSON.parse(await fs.readFile(file, "utf8")) as CreateManifest;
}

export function nativeManageEnv(): Record<string, string> {
  return {
    DJANGO_SETTINGS_MODULE: "config.settings.local",
    DJANGO_READ_DOT_ENV_FILE: "true",
  };
}

// Run an arbitrary command in the backend context of whichever runtime the setup uses.
export function runBackend(
  runtime: Runtime,
  backendPath: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): ResultPromise {
  if (runtime === "docker") {
    const envArgs = Object.entries(extraEnv).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    return execa("docker", ["compose", "exec", "-T", ...envArgs, "backend", ...args], {
      cwd: backendPath,
      stdio: "inherit",
    });
  }
  return execa("pipenv", ["run", ...args], {
    cwd: backendPath,
    stdio: "inherit",
    env: { ...process.env, ...nativeManageEnv(), ...extraEnv },
  });
}

export function runManage(runtime: Runtime, backendPath: string, args: string[]): ResultPromise {
  return runBackend(runtime, backendPath, ["python", "manage.py", ...args]);
}

export async function readEnvValue(file: string, key: string): Promise<string | undefined> {
  if (!existsSync(file)) {
    return undefined;
  }
  const content = await fs.readFile(file, "utf8");
  for (const line of content.split("\n")) {
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`));
    if (match) {
      return match[1].trim().replace(/^"(.*)"$/, "$1");
    }
  }
  return undefined;
}
