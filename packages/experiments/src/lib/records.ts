// 实验记录：每次真实模型调用追加一条 JSONL。
// 记录是 A 线的证据资产（给 M3 契约草案与 M5 适配提供真实返回样本）：
// 引用输入文件名，绝不内嵌图片数据或凭证。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const recordsRoot = path.join(pkgRoot, 'records');

export interface ExperimentRecord {
  /** ISO 时间 */
  ts: string;
  /** 工作流标识：garment-understanding / try-on-preview / ... */
  workflow: string;
  /** 实验目的或批次说明 */
  purpose: string;
  provider: string;
  model: string;
  /** 输入样本的相对引用（相对 packages/experiments），如 samples/wardrobe/knit-01.jpg */
  inputRefs: string[];
  /** 生成产物落盘后的相对引用（生成图 URL 有时效，必须当场下载保存） */
  outputRefs?: string[];
  ok: boolean;
  latencyMs: number;
  /** 失败时的错误类别与摘要（不含凭证） */
  error?: { kind: string; message: string };
  /** 原始返回（完整保存，供契约归纳；已确认不含凭证字段） */
  raw?: unknown;
  /** 解析后的结构化结果（如通过 schema 校验） */
  parsed?: unknown;
  /** 解析/校验失败说明 */
  parseError?: string;
  /** 人工核对结论（回填字段） */
  review?: Record<string, unknown>;
}

export function appendRecord(workflow: string, record: Omit<ExperimentRecord, 'ts'>): string {
  const dir = path.join(recordsRoot, workflow);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
  fs.appendFileSync(file, line, 'utf-8');
  return file;
}

export function recordsPathFor(workflow: string): string {
  return path.relative(pkgRoot, path.join(recordsRoot, workflow));
}

/** 找到某输入样本最近一次带解析结果的记录（如 A-衣物理解 → 上身预览 prompt 的管线） */
export function findLatestParsed(
  workflow: string,
  inputRef: string,
): { ts: string; parsed: unknown; model: string } | null {
  const dir = path.join(recordsRoot, workflow);
  if (!fs.existsSync(dir)) return null;
  let latest: { ts: string; parsed: unknown; model: string } | null = null;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const lines = fs.readFileSync(path.join(dir, file), 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as {
          ts: string;
          inputRefs?: string[];
          ok?: boolean;
          parsed?: unknown;
          model?: string;
        };
        if (record.ok && record.parsed && record.inputRefs?.includes(inputRef)) {
          if (!latest || record.ts > latest.ts) {
            latest = { ts: record.ts, parsed: record.parsed, model: record.model ?? '' };
          }
        }
      } catch {
        // 单行损坏跳过，不影响其余记录
      }
    }
  }
  return latest;
}

