// 实验配置：从 packages/experiments/.env 读取多服务档案。
// 凭证只存在于本机 .env（git 忽略），不进入日志、记录文件或版本库。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export type Capability = 'text' | 'vision';

export interface ServiceProfile {
  name: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  capabilities: Capability[];
}

export interface AppConfig {
  profiles: Record<string, ServiceProfile>;
  requestTimeoutMs: number;
}

function readEnvFile(): Record<string, string> {
  const envPath = path.join(pkgRoot, '.env');
  if (!fs.existsSync(envPath)) return {};
  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

function parseCapabilities(raw: string | undefined): Capability[] {
  const list = (raw ?? 'text')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.filter((c): c is Capability => c === 'text' || c === 'vision');
}

function readProfile(env: Record<string, string>, name: string): ServiceProfile | null {
  const prefix = name.toUpperCase();
  const baseUrl = env[`${prefix}_BASE_URL`] ?? '';
  const apiKey = env[`${prefix}_API_KEY`] ?? '';
  const modelId = env[`${prefix}_MODEL_ID`] ?? '';
  if (!baseUrl && !apiKey) return null;
  return {
    name,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    modelId,
    capabilities: parseCapabilities(env[`${prefix}_CAPABILITIES`]),
  };
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const env = { ...readEnvFile() };
  const profiles: Record<string, ServiceProfile> = {};
  for (const name of ['glm', 'deepseek']) {
    const profile = readProfile(env, name);
    if (profile) profiles[name] = profile;
  }
  cached = {
    profiles,
    requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? 60000) || 60000,
  };
  return cached;
}

export function requireProfile(name: string, capability?: Capability): ServiceProfile {
  const { profiles } = loadConfig();
  const profile = profiles[name];
  if (!profile) {
    throw new Error(
      `服务档案 "${name}" 未配置。请复制 packages/experiments/.env.example 为 .env 并填入 ${name.toUpperCase()}_* 各项（凭证不进对话与版本库）。`,
    );
  }
  if (!profile.baseUrl || !profile.apiKey || !profile.modelId) {
    throw new Error(`服务档案 "${name}" 配置不完整：需要 BASE_URL、API_KEY、MODEL_ID 三项。`);
  }
  if (capability && !profile.capabilities.includes(capability)) {
    throw new Error(`服务档案 "${name}" 未声明能力 "${capability}"（.env 中 ${name.toUpperCase()}_CAPABILITIES）。`);
  }
  return profile;
}

/** 找到声明了指定能力的第一个已配置档案（如图像理解 → vision） */
export function findProfileWith(capability: Capability): ServiceProfile {
  const { profiles } = loadConfig();
  const profile = Object.values(profiles).find((p) => p.capabilities.includes(capability));
  if (!profile) {
    throw new Error(`没有任何已配置服务声明能力 "${capability}"。请检查 .env 的 *_CAPABILITIES。`);
  }
  return profile;
}
