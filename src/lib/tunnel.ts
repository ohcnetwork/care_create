import { execa, type ResultPromise } from "execa";
import fs from "node:fs/promises";
import path from "node:path";

import { TUNNEL_COMPOSE_FILE } from "./backend.js";

const TUNNEL_URL_PATTERN = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;

export const TUNNEL_SERVICE = "tunnel";

export interface Tunnel {
  url: string;
  child: ResultPromise;
}

function message(error: unknown): string {
  if (error instanceof Error) {
    return (error as { shortMessage?: string }).shortMessage ?? error.message;
  }
  return String(error);
}

export async function writeTunnelComposeFile(
  backendPath: string,
  service = "backend",
  port = 9000,
): Promise<void> {
  const content = `services:
  ${TUNNEL_SERVICE}:
    image: cloudflare/cloudflared:latest
    command: tunnel --no-autoupdate --url http://${service}:${port}
    dns:
      - 1.1.1.1
      - 8.8.8.8
    depends_on:
      - ${service}
    restart: unless-stopped
`;
  await fs.writeFile(path.join(backendPath, TUNNEL_COMPOSE_FILE), content);
}

export async function readDockerTunnelUrl(
  backendPath: string,
  composeFileArgs: string[],
  attempts = 30,
  delayMs = 2000,
): Promise<string> {
  let lastLogs = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { stdout, stderr } = await execa(
      "docker",
      ["compose", ...composeFileArgs, "logs", "--no-color", TUNNEL_SERVICE],
      { cwd: backendPath, reject: false },
    );
    lastLogs = `${stdout}\n${stderr}`;
    const match = lastLogs.match(TUNNEL_URL_PATTERN);
    if (match) {
      return match[0];
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  const errorLine = lastLogs
    .split("\n")
    .reverse()
    .find((line) => /failed to (?:request|serve|connect|register)/i.test(line));
  const hint = errorLine
    ? ` Last tunnel error: ${errorLine.trim()}`
    : ` Check \`docker compose logs ${TUNNEL_SERVICE}\`.`;
  throw new Error(`Timed out waiting for the cloudflare tunnel URL.${hint}`);
}

export function startCloudflaredTunnel(port: number, timeoutMs = 30000): Promise<Tunnel> {
  let child: ResultPromise;
  try {
    child = execa("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
      stdout: "pipe",
      stderr: "pipe",
      reject: false,
    });
  } catch (error) {
    return Promise.reject(
      new Error(
        `Could not start cloudflared. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ (${message(error)})`,
      ),
    );
  }

  return new Promise<Tunnel>((resolve, reject) => {
    let settled = false;

    const finish = (result: Tunnel | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Error) {
        child.kill("SIGINT");
        reject(result);
      } else {
        resolve(result);
      }
    };

    const timer = setTimeout(
      () => finish(new Error(`Timed out after ${timeoutMs}ms waiting for the cloudflare tunnel URL`)),
      timeoutMs,
    );

    const scan = (chunk: Buffer): void => {
      const match = chunk.toString().match(TUNNEL_URL_PATTERN);
      if (match) {
        finish({ url: match[0], child });
      }
    };

    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);

    child.on("error", (error) =>
      finish(
        new Error(
          `Could not start cloudflared. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ (${error.message})`,
        ),
      ),
    );
    child.on("exit", (code) =>
      finish(new Error(`cloudflared exited (code ${code ?? "unknown"}) before providing a tunnel URL`)),
    );
  });
}
