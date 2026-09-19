import path from "node:path";
import { execa } from "execa";

import type { Runtime } from "../types.js";
import { readEnvValue, composeFiles } from "./backend.js";
import { upsertEnv } from "./env.js";
import { readDockerTunnelUrl } from "./tunnel.js";

const ABDM_PLUG_NAME = "abdm";
const DEFAULT_GATEWAY_URL = "https://dev.abdm.gov.in/api/hiecm";

export interface AbdmConfig {
  clientId: string;
  clientSecret: string;
  gatewayUrl: string;
  backendDomain?: string;
}

export function abdmEnvFile(runtime: Runtime, backendPath: string): string {
  return runtime === "docker"
    ? path.join(backendPath, "docker", ".local.env")
    : path.join(backendPath, ".env");
}

export async function readAbdmConfig(runtime: Runtime, backendPath: string): Promise<AbdmConfig | undefined> {
  const raw = await readEnvValue(abdmEnvFile(runtime, backendPath), "ADDITIONAL_PLUGS");
  if (!raw) return undefined;

  let plugs: Array<{ name: string; configs?: Record<string, string> }>;
  try {
    plugs = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const configs = plugs.find((plug) => plug.name === ABDM_PLUG_NAME)?.configs;
  if (!configs?.ABDM_CLIENT_ID || !configs.ABDM_CLIENT_SECRET) {
    return undefined;
  }

  return {
    clientId: configs.ABDM_CLIENT_ID,
    clientSecret: configs.ABDM_CLIENT_SECRET,
    gatewayUrl: configs.ABDM_GATEWAY_URL || DEFAULT_GATEWAY_URL,
    backendDomain: configs.BACKEND_DOMAIN,
  };
}

export async function writeBackendDomain(runtime: Runtime, backendPath: string, publicUrl: string): Promise<void> {
  const file = abdmEnvFile(runtime, backendPath);
  const raw = await readEnvValue(file, "ADDITIONAL_PLUGS");
  if (!raw) return;

  let plugs: Array<{ name: string; configs?: Record<string, string> }>;
  try {
    plugs = JSON.parse(raw);
  } catch {
    return;
  }

  const updated = plugs.map((plug) =>
    plug.name === ABDM_PLUG_NAME
      ? { ...plug, configs: { ...(plug.configs ?? {}), BACKEND_DOMAIN: publicUrl } }
      : plug,
  );

  await upsertEnv(file, { ADDITIONAL_PLUGS: JSON.stringify(updated) });
}

function gatewayOrigin(gatewayUrl: string): string {
  try {
    return new URL(gatewayUrl).origin;
  } catch {
    return "https://dev.abdm.gov.in";
  }
}

const ABDM_REQUEST_TIMEOUT_MS = 30000;

async function abdmFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ABDM_REQUEST_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`ABDM request to ${url} timed out after ${ABDM_REQUEST_TIMEOUT_MS}ms`);
    }
    throw new Error(`ABDM request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function createSession(origin: string, clientId: string, clientSecret: string): Promise<string> {
  const response = await abdmFetch(`${origin}/gateway/v0.5/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!response.ok) {
    throw new Error(`ABDM session request failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { accessToken?: string };
  if (!data.accessToken) {
    throw new Error("ABDM session response did not include an accessToken");
  }
  return data.accessToken;
}

async function updateBridge(origin: string, token: string, url: string): Promise<void> {
  const response = await abdmFetch(`${origin}/gateway/v1/bridges`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ url }),
  });
  if (!response.ok) {
    throw new Error(`ABDM bridge update failed (${response.status}): ${await response.text()}`);
  }
}

export async function updateAbdmCallbackUrl(config: AbdmConfig, publicUrl: string): Promise<void> {
  const origin = gatewayOrigin(config.gatewayUrl);
  const token = await createSession(origin, config.clientId, config.clientSecret);
  const bridgeUrl = `${publicUrl.replace(/\/$/, "")}/api/abdm`;
  await updateBridge(origin, token, bridgeUrl);
}

export interface StepLogger {
  step(message: string): void;
  info(message: string): void;
}

export async function setupDockerAbdmCallback(backendPath: string, log: StepLogger): Promise<void> {
  const config = await readAbdmConfig("docker", backendPath);
  if (!config) {
    throw new Error("abdm plug is installed but its client credentials are missing");
  }

  log.step("Waiting for the cloudflare tunnel URL");
  const url = await readDockerTunnelUrl(backendPath, composeFiles(backendPath));
  log.info(`Public tunnel URL: ${url}`);

  await writeBackendDomain("docker", backendPath, url);
  await execa("docker", ["compose", ...composeFiles(backendPath), "up", "-d"], {
    cwd: backendPath,
    stdio: "inherit",
  });

  log.step("Updating ABDM callback URL (session + bridge)");
  await updateAbdmCallbackUrl(config, url);
  log.info("ABDM callback URL updated.");
}
