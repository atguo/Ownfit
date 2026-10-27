// 图片读取：本地样本文件 → base64 data URL（OpenAI 兼容图像输入格式）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const mimeByExt: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

export function isImageFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() in mimeByExt;
}

/** 相对 packages/experiments 的样本路径 */
export function samplePath(relativePath: string): string {
  return path.join(pkgRoot, relativePath);
}

export function listSampleImages(dirRelative: string): string[] {
  const dir = path.join(pkgRoot, dirRelative);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => isImageFile(name))
    .map((name) => path.join(dirRelative, name).replace(/\\/g, '/'))
    .sort();
}

export function toDataUrl(relativePath: string): string {
  const absolute = path.join(pkgRoot, relativePath);
  const mime = mimeByExt[path.extname(absolute).toLowerCase()];
  if (!mime) throw new Error(`不支持的图片格式：${absolute}`);
  return `data:${mime};base64,${fs.readFileSync(absolute).toString('base64')}`;
}
