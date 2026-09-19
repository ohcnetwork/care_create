import * as p from "@clack/prompts";
import pc from "picocolors";
import path from "node:path";
import { execa } from "execa";
import type { Command } from "commander";

import { composeFiles, readManifest } from "../lib/backend.js";

interface StopOptions {
  volumes?: boolean;
}

function message(error: unknown): string {
  if (error instanceof Error) {
    return (error as { shortMessage?: string }).shortMessage ?? error.message;
  }
  return String(error);
}

export function registerStopCommand(program: Command): void {
  program
    .command("stop [directory]")
    .alias("down")
    .description("Stop running services and clean up")
    .option("-v, --volumes", "also remove docker volumes (wipes database and storage)")
    .action((directory: string | undefined, options: StopOptions) => stopCommand(directory, options));
}

async function pidsOnPort(port: number): Promise<string[]> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execa("netstat", ["-ano"], { reject: false });
      const pids = new Set<string>();
      for (const line of stdout.split("\n")) {
        const cols = line.trim().split(/\s+/);
        if (cols.length >= 5 && cols[0] === "TCP" && cols[3] === "LISTENING" && cols[1].endsWith(`:${port}`)) {
          pids.add(cols[4]);
        }
      }
      return [...pids];
    }
    const { stdout } = await execa("lsof", ["-ti", `tcp:${port}`], { reject: false });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}


async function killPort(port: number): Promise<boolean> {
  const pids = await pidsOnPort(port);
  if (pids.length === 0) {
    return false;
  }
  if (process.platform === "win32") {
    for (const pid of pids) {
      await execa("taskkill", ["/PID", pid, "/T", "/F"], { reject: false });
    }
  } else {
    await execa("kill", ["-TERM", ...pids], { reject: false });
  }
  return true;
}

async function stopCommand(directory: string | undefined, options: StopOptions): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" @ohcn/care stop ")));

  const targetPath = path.resolve(process.cwd(), directory ?? ".");

  try {
    const manifest = await readManifest(targetPath);

    if (manifest.runtime === "docker") {
      const backendPath = path.join(targetPath, manifest.backendDir);
      const args = ["compose", ...composeFiles(backendPath), "down"];
      if (options.volumes) {
        args.push("--volumes");
      }
      p.log.step(`Stopping docker services${options.volumes ? " and removing volumes" : ""}`);
      await execa("docker", args, { cwd: backendPath, stdio: "inherit" });
    } else {
      const ports = new Set<number>([9000, 4000]);
      for (const plug of manifest.frontendPlugs) {
        const port = Number(plug.devUrl?.split(":").pop());
        if (Number.isFinite(port) && port > 0) {
          ports.add(port);
        }
      }

      p.log.step("Stopping native dev servers");
      let stopped = 0;
      for (const port of ports) {
        if (await killPort(port)) {
          stopped += 1;
          p.log.info(`Freed port ${port}`);
        }
      }
      if (stopped === 0) {
        p.log.info("No dev servers were running on the expected ports.");
      }
    }

    p.outro(pc.green("Cleanup complete."));
  } catch (error) {
    p.log.error(message(error));
    process.exit(1);
  }
}
