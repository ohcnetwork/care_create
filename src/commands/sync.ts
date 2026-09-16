import * as p from "@clack/prompts";
import pc from "picocolors";
import path from "node:path";
import { existsSync } from "node:fs";
import { execa } from "execa";
import type { Command } from "commander";

import type { CreateManifest, Runtime } from "../types.js";
import {
  buildArgPlugs,
  COMPOSE_FILES,
  keepEnvFilesOutOfImage,
  readEnvValue,
  readManifest,
  runBackend,
  runManage,
} from "../lib/backend.js";
import { pullRepo } from "../lib/git.js";
import { nativeBuildEnv } from "../lib/native.js";

function message(error: unknown): string {
  if (error instanceof Error) {
    return (error as { shortMessage?: string }).shortMessage ?? error.message;
  }
  return String(error);
}

export function registerSyncCommand(program: Command): void {
  program
    .command("sync [directory]")
    .alias("update")
    .description("Pull latest changes for all repos, update dependencies, and run migrations")
    .action((directory: string | undefined) => syncCommand(directory));
}

async function pull(
  spinner: ReturnType<typeof p.spinner>,
  dir: string,
  label: string,
  warnings: string[],
): Promise<void> {
  if (!existsSync(dir)) {
    return;
  }
  spinner.start(`Pulling ${label}`);
  try {
    await pullRepo(dir);
    spinner.stop(`Updated ${label}`);
  } catch (error) {
    spinner.stop(`Skipped ${label}`);
    warnings.push(`Could not update ${label}: ${message(error)}`);
  }
}

async function bringUpBackend(
  runtime: Runtime,
  backendPath: string,
  manifest: CreateManifest,
  warnings: string[],
): Promise<void> {
  if (runtime === "docker") {
    const additionalPlugs = await readEnvValue(path.join(backendPath, "docker", ".local.env"), "ADDITIONAL_PLUGS");
    await keepEnvFilesOutOfImage(backendPath);
    p.log.step("Rebuilding and starting backend services (docker)");
    await execa("docker", ["compose", ...COMPOSE_FILES, "up", "-d", "--build"], {
      cwd: backendPath,
      stdio: "inherit",
      env: { ...process.env, ...(additionalPlugs ? { ADDITIONAL_PLUGS: buildArgPlugs(additionalPlugs) } : {}) },
    });
  } else {
    p.log.step("Updating backend dependencies (pipenv)");
    await execa("pipenv", ["install", "--categories", "packages dev-packages docs"], {
      cwd: backendPath,
      stdio: "inherit",
    });
  }

  if (manifest.backendPlugs.length === 0) {
    return;
  }

  p.log.step("Updating backend plugs (editable)");
  const buildEnv = runtime === "native" ? nativeBuildEnv().env : {};
  for (const plug of manifest.backendPlugs) {
    const pkg = runtime === "docker" ? `/app/${plug.dir}` : path.join(backendPath, plug.dir);
    try {
      await runBackend(runtime, backendPath, ["pip", "install", "-e", pkg], buildEnv);
    } catch (error) {
      warnings.push(`Could not update plug ${plug.name}: ${message(error)}`);
    }
  }
}

async function installFrontend(targetPath: string, frontendPath: string, manifest: CreateManifest): Promise<void> {
  if (existsSync(frontendPath)) {
    p.log.step("Updating frontend dependencies (care_fe)");
    await execa("npm", ["install"], { cwd: frontendPath, stdio: "inherit" });
  }
  for (const plug of manifest.frontendPlugs) {
    const dir = path.join(targetPath, plug.dir);
    if (existsSync(dir)) {
      p.log.step(`Updating frontend plug ${plug.name}`);
      await execa("npm", ["install"], { cwd: dir, stdio: "inherit" });
    }
  }
}

function reportWarnings(warnings: string[]): void {
  if (warnings.length === 0) {
    return;
  }
  p.log.warn(`Completed with ${warnings.length} warning(s):`);
  for (const warning of warnings) {
    p.log.warn(`  • ${warning}`);
  }
}

async function syncCommand(directory: string | undefined): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" @ohcn/care sync ")));

  const targetPath = path.resolve(process.cwd(), directory ?? ".");

  let manifest: CreateManifest;
  try {
    manifest = await readManifest(targetPath);
  } catch (error) {
    p.log.error(message(error));
    process.exit(1);
  }

  const runtime = manifest.runtime;
  const backendPath = path.join(targetPath, manifest.backendDir);
  const frontendPath = path.join(targetPath, manifest.frontendDir);
  const warnings: string[] = [];
  const spinner = p.spinner();

  await pull(spinner, backendPath, "care backend", warnings);
  await pull(spinner, frontendPath, "care frontend", warnings);
  for (const plug of manifest.backendPlugs) {
    await pull(spinner, path.join(backendPath, plug.dir), `backend plug ${plug.name}`, warnings);
  }
  for (const plug of manifest.frontendPlugs) {
    await pull(spinner, path.join(targetPath, plug.dir), `frontend plug ${plug.name}`, warnings);
  }

  try {
    await bringUpBackend(runtime, backendPath, manifest, warnings);

    p.log.step("Applying database migrations");
    await runManage(runtime, backendPath, ["migrate"]);

    p.log.step("Syncing permissions and valuesets");
    await runManage(runtime, backendPath, ["sync_permissions_roles"]);
    await runManage(runtime, backendPath, ["sync_valueset"]);

    await installFrontend(targetPath, frontendPath, manifest);
  } catch (error) {
    p.log.error(message(error));
    reportWarnings(warnings);
    process.exit(1);
  }

  reportWarnings(warnings);
  p.outro(pc.green("Sync complete."));
}
