import { execa, type ResultPromise } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import type { CreateManifest, Runtime } from "../types.js";

export const COMPOSE_FILES = ["-f", "docker-compose.yaml", "-f", "docker-compose.local.yaml"];

export const TUNNEL_COMPOSE_FILE = "docker-compose.tunnel.yaml";

export function composeFiles(backendPath: string): string[] {
  const files = [...COMPOSE_FILES];
  if (existsSync(path.join(backendPath, TUNNEL_COMPOSE_FILE))) {
    files.push("-f", TUNNEL_COMPOSE_FILE);
  }
  return files;
}

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
