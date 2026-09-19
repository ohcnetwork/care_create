import * as p from "@clack/prompts";
import pc from "picocolors";
import path from "node:path";
import { existsSync } from "node:fs";
import { execa, type ResultPromise } from "execa";
import type { Command } from "commander";

import type { CreateManifest } from "../types.js";
import { composeFiles, readManifest } from "../lib/backend.js";
import { startCloudflaredTunnel, writeTunnelComposeFile, type Tunnel } from "../lib/tunnel.js";
import { readAbdmConfig, setupDockerAbdmCallback, updateAbdmCallbackUrl, writeBackendDomain } from "../lib/abdm.js";

const PREFIX_COLORS = [pc.cyan, pc.green, pc.magenta, pc.yellow, pc.blue, pc.red];

const BACKEND_PORT = 9000;

interface Task {
  name: string;
  cwd: string;
  command: string;
  env?: Record<string, string>;
}

export function registerRunCommand(program: Command): void {
  program
    .command("run [directory]")
    .alias("start")
    .description("Install missing deps and start the backend, frontend, and frontend plug dev servers")
    .action((directory: string | undefined) => runCommand(directory));
}

async function ensureDeps(cwd: string): Promise<void> {
  if (!existsSync(path.join(cwd, "node_modules"))) {
    await execa("npm", ["install"], { cwd, stdio: "inherit" });
  }
}

function parseCommand(command: string): [string, string[]] {
  const parts = command.trim().split(/\s+/);
  return [parts[0], parts.slice(1)];
}

function spawnTask(task: Task, color: (text: string) => string): ResultPromise {
  const [command, args] = parseCommand(task.command);
  const child = execa(command, args, {
    cwd: task.cwd,
    env: { ...process.env, FORCE_COLOR: "1", ...task.env },
    stdout: "pipe",
    stderr: "pipe",
    reject: false,
  });

  pipeChildOutput(child, task.name, color);
  return child;
}

function pipeChildOutput(child: ResultPromise, name: string, color: (text: string) => string): void {
  const prefix = color(`[${name}]`);
  const pipe = (stream: NodeJS.ReadableStream): void => {
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        process.stdout.write(`${prefix} ${line}\n`);
      }
    });
  };

  if (child.stdout) pipe(child.stdout);
  if (child.stderr) pipe(child.stderr);
}

async function startNativeAbdmTunnel(
  manifest: CreateManifest,
  backendPath: string,
): Promise<Tunnel | undefined> {
  const config = await readAbdmConfig(manifest.runtime, backendPath);
  if (!config) {
    p.log.warn("abdm plug is installed but its client credentials are missing; skipping tunnel setup.");
    return undefined;
  }

  p.log.step("Creating cloudflare tunnel for ABDM callbacks");
  const tunnel = await startCloudflaredTunnel(BACKEND_PORT);
  pipeChildOutput(tunnel.child, "tunnel", pc.magenta);
  p.log.info(`Public tunnel URL: ${pc.cyan(tunnel.url)}`);

  await writeBackendDomain(manifest.runtime, backendPath, tunnel.url);

  p.log.step("Updating ABDM callback URL (session + bridge)");
  await updateAbdmCallbackUrl(config, tunnel.url);
  p.log.info("ABDM callback URL updated.");

  return tunnel;
}

async function runCommand(directory: string | undefined): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" @ohcn/care run ")));

  const targetPath = path.resolve(process.cwd(), directory ?? ".");

  let manifest: CreateManifest;
  try {
    manifest = await readManifest(targetPath);
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const tasks: Task[] = [];

  const backendPath = path.join(targetPath, manifest.backendDir);
  const isAbdm = manifest.backendPlugs.some((plug) => plug.name === "abdm");

  let nativeTunnel: Tunnel | undefined;

  if (manifest.runtime === "docker") {
    if (isAbdm) {
      await writeTunnelComposeFile(backendPath);
    }
    p.log.step("Starting backend services (docker, detached)");
    await execa("docker", ["compose", ...composeFiles(backendPath), "up", "-d"], { cwd: backendPath, stdio: "inherit" });
    if (isAbdm) {
      try {
        await setupDockerAbdmCallback(backendPath, {
          step: (msg) => p.log.step(msg),
          info: (msg) => p.log.info(msg),
        });
      } catch (error) {
        p.log.warn(`Skipped ABDM tunnel setup: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else {
    if (isAbdm) {
      try {
        nativeTunnel = await startNativeAbdmTunnel(manifest, backendPath);
      } catch (error) {
        p.log.warn(`Skipped ABDM tunnel setup: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    tasks.push({
      name: "backend",
      cwd: backendPath,
      command: "pipenv run python manage.py runserver 0.0.0.0:9000",
      env: { DJANGO_SETTINGS_MODULE: "config.settings.local", DJANGO_READ_DOT_ENV_FILE: "true" },
    });
  }

  const frontendPath = path.join(targetPath, manifest.frontendDir);
  if (existsSync(frontendPath)) {
    p.log.step("Preparing frontend (care_fe)");
    await ensureDeps(frontendPath);
    tasks.push({ name: "care_fe", cwd: frontendPath, command: "npm run dev" });
  }

  for (const plug of manifest.frontendPlugs) {
    const plugPath = path.join(targetPath, plug.dir);
    if (!existsSync(plugPath)) {
      p.log.warn(`Skipping ${plug.name}: ${plug.dir} not found`);
      continue;
    }
    p.log.step(`Preparing frontend plug ${plug.name}${plug.devUrl ? ` (${plug.devUrl})` : ""}`);
    await ensureDeps(plugPath);
    tasks.push({ name: plug.name, cwd: plugPath, command: plug.devCommand ?? "npm run dev" });
  }

  if (tasks.length === 0) {
    if (nativeTunnel) {
      const tunnelChild = nativeTunnel.child;
      p.log.info("Tunnel running. Press Ctrl+C to stop.");
      const stopTunnel = (): void => {
        tunnelChild.kill("SIGINT");
      };
      process.on("SIGINT", stopTunnel);
      process.on("SIGTERM", stopTunnel);
      await tunnelChild;
      return;
    }
    p.outro("Nothing to run.");
    return;
  }

  const children = tasks.map((task, index) => spawnTask(task, PREFIX_COLORS[index % PREFIX_COLORS.length]));
  if (nativeTunnel) {
    children.push(nativeTunnel.child);
  }

  const shutdown = (): void => {
    for (const child of children) {
      child.kill("SIGINT");
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  p.log.info("Dev servers running. Press Ctrl+C to stop.");
  await Promise.allSettled(children);
}
