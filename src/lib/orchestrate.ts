import { execa } from "execa";
import pc from "picocolors";

import type { PluginConfigEntry, Runtime } from "../types.js";
import { nativeBuildEnv } from "./native.js";
import { composeFiles } from "./backend.js";

const PLUG_CONFIG_SCRIPT = `import json, os
from care.users.models import PlugConfig
PlugConfig.objects.update_or_create(slug=os.environ["PLUG_SLUG"], defaults={"meta": json.loads(os.environ["PLUG_META"])})`;

interface OrchestrateOptions {
  runtime: Runtime;
  backendPath: string;
  frontendPath: string;
  seedData: boolean;
  additionalPlugs: string;
  plugPackages: string[];
  pluginConfigs: PluginConfigEntry[];
}

function step(message: string): void {
  process.stdout.write(`\n${pc.cyan("▶")} ${pc.bold(message)}\n`);
}

function warn(message: string): void {
  process.stdout.write(`\n${pc.yellow("!")} ${message}\n`);
}

function run(command: string, args: string[], cwd: string, env?: Record<string, string>) {
  return execa(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
}

function message(error: unknown): string {
  if (error instanceof Error) {
    return (error as { shortMessage?: string }).shortMessage ?? error.message;
  }
  return String(error);
}

async function retry<T>(fn: () => Promise<T>, attempts = 20, delayMs = 5000): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

function nativeEnv(additionalPlugs = ""): Record<string, string> {
  return {
    DJANGO_SETTINGS_MODULE: "config.settings.local",
    DJANGO_READ_DOT_ENV_FILE: "true",
    ...(additionalPlugs ? { ADDITIONAL_PLUGS: additionalPlugs } : {}),
  };
}

function backendExec(cwd: string, args: string[], env?: Record<string, string>) {
  const envArgs = Object.entries(env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  return run("docker", ["compose", "exec", "-T", ...envArgs, "backend", ...args], cwd);
}

async function upsertPluginConfig(runtime: Runtime, cwd: string, entry: PluginConfigEntry): Promise<void> {
  const env = { PLUG_SLUG: entry.slug, PLUG_META: JSON.stringify(entry.meta) };
  const args = ["python", "manage.py", "shell", "-c", PLUG_CONFIG_SCRIPT];
  if (runtime === "docker") {
    await backendExec(cwd, args, env);
  } else {
    await run("pipenv", ["run", ...args], cwd, { ...nativeEnv(), ...env });
  }
}

// Reinstall plugs editable (over the baked non-editable install) so source edits live-reload, without touching core files.
async function makeEditable(
  runtime: Runtime,
  cwd: string,
  plugPackages: string[],
  warnings: string[],
): Promise<void> {
  if (plugPackages.length === 0) {
    return;
  }
  step("Making backend plugs editable (live reload)");
  for (const pkg of plugPackages) {
    try {
      if (runtime === "docker") {
        await retry(() => backendExec(cwd, ["pip", "install", "-e", pkg]));
      } else {
        await run("pipenv", ["run", "pip", "install", "-e", pkg], cwd, {
          ...nativeEnv(),
          ...nativeBuildEnv().env,
        });
      }
    } catch (error) {
      warnings.push(`Could not make plug editable (${pkg}): ${message(error)}`);
    }
  }
  if (runtime === "docker") {
    try {
      await run("docker", ["compose", ...composeFiles(cwd), "restart", "backend", "celery"], cwd);
    } catch (error) {
      warnings.push(`Could not restart services after editable install: ${message(error)}`);
    }
  }
}

async function registerPluginConfigs(
  runtime: Runtime,
  cwd: string,
  pluginConfigs: PluginConfigEntry[],
  warnings: string[],
): Promise<void> {
  if (pluginConfigs.length === 0) {
    return;
  }
  step("Registering frontend plugin configs");
  for (const entry of pluginConfigs) {
    try {
      await upsertPluginConfig(runtime, cwd, entry);
    } catch (error) {
      warnings.push(`Failed to register plugin config for ${entry.slug}: ${message(error)}`);
    }
  }
}

// Core steps throw (fatal); best-effort steps push to warnings and continue.
async function dockerUp(
  cwd: string,
  seedData: boolean,
  additionalPlugs: string,
  plugPackages: string[],
  pluginConfigs: PluginConfigEntry[],
  warnings: string[],
): Promise<void> {
  step("Building backend images (this can take a while)");
  await run("docker", ["compose", ...composeFiles(cwd), "build"], cwd, { ADDITIONAL_PLUGS: additionalPlugs });

  step("Starting services");
  await run("docker", ["compose", ...composeFiles(cwd), "up", "-d"], cwd, { ADDITIONAL_PLUGS: additionalPlugs });

  await makeEditable("docker", cwd, plugPackages, warnings);

  step("Applying database migrations");
  await retry(() => backendExec(cwd, ["python", "manage.py", "migrate"]));

  step("Syncing permissions and valuesets");
  await retry(() => backendExec(cwd, ["python", "manage.py", "sync_permissions_roles"]));
  await retry(() => backendExec(cwd, ["python", "manage.py", "sync_valueset"]));

  if (seedData) {
    step("Loading dummy data");
    try {
      await backendExec(cwd, ["python", "manage.py", "load_fixtures"]);
    } catch (error) {
      warnings.push(`Skipped dummy data: ${message(error)}`);
    }
  }

  await registerPluginConfigs("docker", cwd, pluginConfigs, warnings);
}

async function nativeUp(
  cwd: string,
  seedData: boolean,
  additionalPlugs: string,
  plugPackages: string[],
  pluginConfigs: PluginConfigEntry[],
  warnings: string[],
): Promise<void> {
  step("Installing backend dependencies (pipenv)");
  await run("pipenv", ["install", "--categories", "packages dev-packages docs"], cwd);

  if (additionalPlugs) {
    const build = nativeBuildEnv();
    if (build.warning) {
      warn(build.warning);
      warnings.push(build.warning);
    }
    step("Installing backend plugs");
    await run("pipenv", ["run", "python", "install_plugins.py"], cwd, {
      ...nativeEnv(additionalPlugs),
      ...build.env,
    });
  }

  await makeEditable("native", cwd, plugPackages, warnings);

  const env = nativeEnv(additionalPlugs);
  const manage = (args: string[]) => run("pipenv", ["run", "python", "manage.py", ...args], cwd, env);

  step("Applying database migrations");
  await manage(["migrate"]);

  step("Syncing permissions and valuesets");
  await manage(["sync_permissions_roles"]);
  await manage(["sync_valueset"]);

  if (seedData) {
    step("Loading dummy data");
    try {
      await manage(["load_fixtures"]);
    } catch (error) {
      warnings.push(`Skipped dummy data: ${message(error)}`);
    }
  }

  await registerPluginConfigs("native", cwd, pluginConfigs, warnings);
}

export async function orchestrate({
  runtime,
  backendPath,
  frontendPath,
  seedData,
  additionalPlugs,
  plugPackages,
  pluginConfigs,
}: OrchestrateOptions): Promise<string[]> {
  const warnings: string[] = [];

  if (runtime === "docker") {
    await dockerUp(backendPath, seedData, additionalPlugs, plugPackages, pluginConfigs, warnings);
  } else {
    await nativeUp(backendPath, seedData, additionalPlugs, plugPackages, pluginConfigs, warnings);
  }

  step("Installing frontend dependencies (npm)");
  await run("npm", ["install"], frontendPath);

  return warnings;
}
