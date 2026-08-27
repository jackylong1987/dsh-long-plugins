/**
 * dsh-long-plugins host entry.
 *
 * Merged single plugin bundling the former separate plugins:
 *
 *  - dsh-file-uploads  — upload manager + workspace "输出文件" section
 *    (`/api/dsh-uploads/*`)
 *  - dsh-skill-docs    — settings "技能文档" section (`/dsh-skill-docs/*`)
 *  - dsh-token-usage   — DeepSeek account balance (`/dsh-token-usage/balance`)
 *
 * All routes are loopback / same-origin gated via `isTrustedUploadRequest`
 * (which honours `config.trustedHosts`); file paths are resolved inside
 * their configured root so traversal is impossible.
 */
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { link, lstat, mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { inflateRawSync, inflateSync } from "node:zlib";
import { spawn } from "node:child_process";
import { defineTool } from "@deepseek-ai/dsh-tools";
import mammoth from "mammoth";
import ExcelJS from "exceljs";

// 插件根下的 client/vendor 目录（存放 docx-preview / jszip 前端库，供 docx 预览端点读取）。
// 用 module 级定位，让 createHandlers / 各 handler 都能访问（不依赖 apply 内的 PACKAGE_DIR）。
const VENDOR_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "client", "vendor");

export const name = "dsh-long-plugins";

/** Server services required: the web route carrier and the credential seam. */
export const inject = ["webServer", "credentials", "sessions", "sessionPersistence", "tools"];

export const API_PATH = "/api/dsh-uploads";
export const DOWNLOAD_PATH = "/api/dsh-uploads/download";
export const PREVIEW_PATH = "/api/dsh-uploads/preview";
export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_TOTAL_MAX_BYTES = 1024 * 1024 * 1024;

/** DeepSeek account balance endpoint. */
const BALANCE_URL = "https://api.deepseek.com/user/balance";

/** Largest preview body we will inline (256 KiB); larger files preview as metadata only. */
const PREVIEW_LIMIT = 256 * 1024;

/** Skills root: default $HOME/skills, overridable via config.skillsRoot. */
const DEFAULT_SKILLS_ROOT = resolve(process.env.HOME ?? process.env.DSH_HOME ?? "", "skills");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function resolveUploadRoot(env = process.env) {
  const dshHome = env.DSH_HOME?.trim() || join(homedir(), ".dsh");
  return resolve(env.DSH_UPLOAD_DIR?.trim() || join(dshHome, "uploads"));
}

function positiveInteger(value, fallback) {
  const configured = Number(value);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : fallback;
}

export function resolveMaxFileBytes(env = process.env) {
  return positiveInteger(env.DSH_UPLOAD_MAX_BYTES, DEFAULT_MAX_FILE_BYTES);
}

export function resolveTotalMaxBytes(env = process.env) {
  return positiveInteger(env.DSH_UPLOAD_TOTAL_MAX_BYTES, DEFAULT_TOTAL_MAX_BYTES);
}

export function sanitizeUploadName(value) {
  const decoded = String(value || "").normalize("NFC");
  let safe = basename(decoded)
    .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
    .replace(/^\.+/, "")
    .trim();

  if (!safe) safe = "upload.bin";
  if (safe.startsWith(".upload-")) safe = `file-${safe}`;

  if (safe.length > 180) {
    const extension = extname(safe).slice(0, 24);
    const stem = safe.slice(0, Math.max(1, 180 - extension.length));
    safe = `${stem}${extension}`;
  }
  return safe;
}

export function isSafeStoredName(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 180
    && value === basename(value)
    && value !== "."
    && value !== ".."
    && !value.startsWith(".upload-")
    && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

function requestUrl(req) {
  return new URL(req.url || "/", "http://dsh.internal");
}

function queryName(req) {
  const value = requestUrl(req).searchParams.get("name");
  if (!isSafeStoredName(value)) throw new HttpError(400, "invalid file name");
  return value;
}

function uploadHeaderName(req) {
  const value = header(req.headers, "x-file-name");
  if (value === undefined || value.length === 0) {
    throw new HttpError(400, "x-file-name header is required");
  }
  try {
    return sanitizeUploadName(decodeURIComponent(value));
  } catch {
    throw new HttpError(400, "x-file-name must be URI encoded UTF-8");
  }
}

function header(headers, key) {
  const value = headers[key];
  return typeof value === "string" ? value : undefined;
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
  return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

function assertTrustedAuthority(entry) {
  const entryUrl = parseAuthority(entry);
  if (entryUrl !== undefined && canonicalAuthority(entry, entryUrl) === entry.toLowerCase()) return;
  throw new Error(`dsh-long-plugins: trusted host ${JSON.stringify(entry)} is not a bare host[:port] authority`);
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4
    && parts[0] === "127"
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host;
  });
}

/**
 * Loopback / same-origin gate for every route (browser requests must match
 * Origin to Host; Origin-less calls only from loopback; `trustedHosts` from
 * the profile patch extend loopback to trusted reverse-proxy authorities).
 */
export function isTrustedUploadRequest(req, trustedHosts = []) {
  const host = header(req.headers, "host");
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(req.headers, "sec-fetch-site") === "cross-site") return false;

  const origin = header(req.headers, "origin");
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/** Read a JSON request body (bounded; 1 MiB to fit large edited documents). */
function readJsonBody(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        rejectPromise(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        rejectPromise(error);
      }
    });
    request.on("error", rejectPromise);
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendError(res, error, onError) {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.message });
    return;
  }
  onError?.(error);
  sendJson(res, 500, { error: "internal server error" });
}

function methodNotAllowed(res, methods) {
  res.writeHead(405, { allow: methods.join(", "), "content-length": 0 });
  res.end();
}

async function writeRequestToFile(req, target, maxBytes, limitStatus, limitMessage) {
  const declared = Number(header(req.headers, "content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    throw new HttpError(limitStatus, limitMessage);
  }

  const handle = await open(target, "wx", 0o600);
  let bytes = 0;
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        req.resume();
        throw new HttpError(limitStatus, limitMessage);
      }
      await handle.write(chunk);
    }
    await handle.sync();
    return bytes;
  } finally {
    await handle.close();
  }
}

function numberedName(name, index) {
  if (index === 0) return name;
  const extension = extname(name).slice(0, 24);
  const stem = name.slice(0, name.length - extname(name).length);
  const suffix = ` (${index})`;
  const maxStemLength = Math.max(1, 180 - extension.length - suffix.length);
  return `${stem.slice(0, maxStemLength)}${suffix}${extension}`;
}

async function publishUnique(tempPath, root, requestedName) {
  for (let index = 0; index < 10_000; index += 1) {
    const name = numberedName(requestedName, index);
    const target = join(root, name);
    try {
      await link(tempPath, target);
      await unlink(tempPath);
      return { name, path: target };
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new HttpError(409, "too many files share this name");
}

function fileRecord(root, name, info) {
  return {
    name,
    path: join(root, name),
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
  };
}

export async function listUploadedFiles(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".upload-")) continue;
    try {
      const info = await stat(join(root, entry.name));
      files.push(fileRecord(root, entry.name, info));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
  return files;
}

export function resolveWorkspaceRoot(env = process.env) {
  return dirname(resolveUploadRoot(env));
}

export function workspaceExcludedName(env = process.env) {
  return basename(resolveUploadRoot(env)) || "upload";
}

/** Resolve a user-supplied relative path safely inside the root. */
function safeResolve(root, rel) {
  if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0")) return undefined;
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + sep)) return undefined;
  return full;
}

/** 输出文件白名单：只显示文档类 + 图片（压缩包/代码/音视频/脚本一律隐藏） */
const DOCUMENT_EXTS = new Set([
  // 文本/文档
  "md", "markdown", "txt", "log", "rtf",
  // Office 文档
  "doc", "docx", "pdf",
  // 表格
  "xls", "xlsx", "csv", "tsv",
  // 演示
  "ppt", "pptx",
  // 数据/配置
  "json", "yml", "yaml", "xml",
  // 网页
  "html", "htm",
  // 图片
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tiff", "heic",
]);

/** Collect subdirectories with their files, grouped by folder. */
async function collectGroups(root, excluded) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return [];
    throw error;
  }
  const groups = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === excluded) continue;
    const files = [];
    const walk = async (dir) => {
      let sub;
      try {
        sub = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") return;
        throw error;
      }
      sub.sort((a, b) => a.name.localeCompare(b.name));
      for (const item of sub) {
        const abs = join(dir, item.name);
        if (item.isDirectory()) {
          await walk(abs);
        } else if (item.isFile()) {
          // 白名单：只显示文档类 + 图片文件，脚本/压缩包/代码/音视频一律隐藏
          const ext = item.name.slice(item.name.lastIndexOf(".") + 1).toLowerCase();
          if (!DOCUMENT_EXTS.has(ext)) continue;
          try {
            const info = await stat(abs);
            files.push({
              path: relative(root, abs).split(sep).join("/"),
              name: item.name,
              size: info.size,
              mtime: info.mtimeMs,
            });
          } catch (error) {
            if (error && typeof error === "object" && error.code !== "ENOENT") throw error;
          }
        }
      }
    };
    await walk(join(root, entry.name));
    files.sort((a, b) => (b.mtime - a.mtime) || a.path.localeCompare(b.path));
    groups.push({ folder: entry.name, files });
  }
  groups.sort((a, b) => a.folder.localeCompare(b.folder));
  return groups;
}

export async function sweepUploadTemps(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const entries = await readdir(root, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.name.startsWith(".upload-")) continue;
    try {
      await unlink(join(root, entry.name));
      removed += 1;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "EISDIR" && error?.code !== "EPERM") throw error;
    }
  }
  return removed;
}

async function requireRegularFile(root, name) {
  const target = join(root, name);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") throw new HttpError(404, "file not found");
    throw error;
  }
  if (!info.isFile()) throw new HttpError(400, "not a regular file");
  return { target, info };
}

function asciiDownloadName(name) {
  const value = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return value || "download";
}

export function contentDisposition(name) {
  return `attachment; filename="${asciiDownloadName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Content type for preview by extension. */
function contentType(name) {
  const extension = extname(name).toLowerCase();
  return ({
    ".txt": "text/plain; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".yml": "text/yaml; charset=utf-8",
    ".yaml": "text/yaml; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".zip": "application/zip",
  })[extension] || "application/octet-stream";
}

const OFFICE_EXTS = new Set([".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt"]);

/** Escape HTML special characters (attribute/body safe). */
function escHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render a .docx as HTML (keeps paragraphs, headings, bold, lists, tables). */
async function docxHtml(buf) {
  try {
    const result = await mammoth.convertToHtml({ buffer: buf });
    return result.value || "<p>（空文档）</p>";
  } catch {
    return null;
  }
}

/** Render the first sheet of a .xlsx as an HTML table. */
async function xlsxHtml(buf) {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buf);
    const sheet = workbook.worksheets[0];
    if (!sheet) return "<p>（空工作簿）</p>";
    const rows = [];
    const limit = 500; // cell cap to keep the preview bounded
    let rendered = 0;
    for (const row of sheet.eachRow({ includeEmpty: false })) {
      if (rendered >= limit) break;
      const cells = [];
      for (let col = 1; col <= Math.min(row.cellCount, 32); col += 1) {
        const cell = row.getCell(col);
        let value = cell.value;
        if (value !== null && typeof value === "object") {
          if (value.richText) value = value.richText.map((t) => t.text).join("");
          else if (value.text !== undefined) value = value.text;
          else if (value.result !== undefined) value = value.result;
          else value = "";
        }
        cells.push(`<td>${escHtml(value ?? "")}</td>`);
      }
      rows.push(`<tr>${cells.join("")}</tr>`);
      rendered += 1;
    }
    const header = rows.length > 0 ? `<thead><tr>${rows[0]}</tr></thead>` : "";
    const body = rows.length > 1 ? `<tbody>${rows.slice(1).join("")}</tbody>` : "";
    const css = "<style>table{border-collapse:collapse;width:100%;font-size:12px}td{border:1px solid #d0d0d0;padding:4px 8px;white-space:pre-wrap;word-break:break-all}</style>";
    return `${css}<table>${header}${body}</table>`;
  } catch {
    return null;
  }
}

/** List the entries of a minimal ZIP container (local-file-header walk). */
function zipEntries(buf) {
  const entries = new Map();
  let off = 0;
  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== 0x04034b50) break;
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString("utf8");
    const dataStart = off + 30 + nameLen + extraLen;
    entries.set(name, { method, data: buf.subarray(dataStart, dataStart + compSize) });
    off = dataStart + compSize;
  }
  return entries;
}

function inflateEntry(entry) {
  if (!entry) return null;
  try {
    return entry.method === 0 ? entry.data : inflateRawSync(entry.data);
  } catch {
    try {
      return inflateSync(entry.data);
    } catch {
      return null;
    }
  }
}

/** Join the text of every `<w:t>` (docx) or `<a:t>` (pptx) run. */
function taggedText(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1]).join("").replace(/\s+/g, " ").trim();
}

/** Render .pptx as simple HTML (one section per slide with its text runs). */
function pptxHtml(buf) {
  const parts = [];
  const entries = zipEntries(buf);
  const names = [...entries.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort();
  for (const name of names) {
    const xml = inflateEntry(entries.get(name))?.toString("utf8");
    if (xml === undefined) continue;
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join(" ").trim();
    if (texts !== "") parts.push(`<div style="margin:0 0 14px;padding:10px 12px;border:1px solid #e0e0e0;border-radius:6px;background:#fafafa"><div style="font-size:11px;color:#999;margin-bottom:4px">${escHtml(name.replace(/^ppt\/slides\/|\.xml$/g, ""))}</div><div>${escHtml(texts)}</div></div>`);
  }
  return parts.length > 0 ? parts.join("") : null;
}

/**
 * Render a binary Office document to HTML for layout-preserving preview.
 * Returns `null` when the file is not a supported Office format or the
 * conversion fails.
 * @param name - file name (extension decides the format).
 * @param buffer - raw file bytes.
 * @returns HTML string or null.
 */
async function officePreviewHtml(name, buffer) {
  const ext = extname(name).toLowerCase();
  if (ext === ".docx") return docxHtml(buffer);
  if (ext === ".xlsx") return xlsxHtml(buffer);
  if (ext === ".pptx") return pptxHtml(buffer);
  return null;
}

export function createHandlers(options = {}) {
  const root = resolve(options.root || resolveUploadRoot());
  const maxFileBytes = positiveInteger(options.maxFileBytes, resolveMaxFileBytes());
  const totalMaxBytes = positiveInteger(options.totalMaxBytes, resolveTotalMaxBytes());
  const trustedHosts = Array.isArray(options.trustedHosts) ? [...options.trustedHosts] : [];
  const onError = typeof options.onError === "function" ? options.onError : undefined;
  for (const entry of trustedHosts) assertTrustedAuthority(entry);

  let mutationTail = Promise.resolve();
  const enqueueMutation = (operation) => {
    const current = mutationTail.then(operation, operation);
    mutationTail = current.catch(() => {});
    return current;
  };

  const requireTrusted = (req) => {
    if (!isTrustedUploadRequest(req, trustedHosts)) throw new HttpError(403, "forbidden");
  };

  const api = async (req, res) => {
    try {
      requireTrusted(req);

      if (req.method === "GET" || req.method === "HEAD") {
        const files = await listUploadedFiles(root);
        const usedBytes = files.reduce((sum, file) => sum + file.size, 0);
        if (req.method === "HEAD") {
          res.writeHead(200, { "cache-control": "no-store", "content-length": 0 });
          res.end();
          return;
        }
        sendJson(res, 200, { root, maxFileBytes, totalMaxBytes, usedBytes, files });
        return;
      }

      if (req.method === "POST") {
        await enqueueMutation(async () => {
          await mkdir(root, { recursive: true, mode: 0o700 });
          const requestedName = uploadHeaderName(req);
          const declared = Number(header(req.headers, "content-length"));
          if (Number.isFinite(declared) && declared > maxFileBytes) {
            req.resume();
            throw new HttpError(413, `file exceeds ${maxFileBytes} bytes`);
          }

          const files = await listUploadedFiles(root);
          const usedBytes = files.reduce((sum, file) => sum + file.size, 0);
          const remainingBytes = totalMaxBytes - usedBytes;
          if (remainingBytes <= 0) {
            req.resume();
            throw new HttpError(507, "upload storage quota exceeded");
          }

          const allowedBytes = Math.min(maxFileBytes, remainingBytes);
          const quotaLimited = allowedBytes < maxFileBytes;
          const tempPath = join(root, `.upload-${randomUUID()}.tmp`);
          try {
            const size = await writeRequestToFile(
              req,
              tempPath,
              allowedBytes,
              quotaLimited ? 507 : 413,
              quotaLimited ? "upload storage quota exceeded" : `file exceeds ${maxFileBytes} bytes`,
            );
            const published = await publishUnique(tempPath, root, requestedName);
            const info = await stat(published.path);
            sendJson(res, 201, {
              root,
              file: fileRecord(root, published.name, { size, mtime: info.mtime }),
            });
          } finally {
            await unlink(tempPath).catch(() => {});
          }
        });
        return;
      }

      if (req.method === "DELETE") {
        await enqueueMutation(async () => {
          const fileName = queryName(req);
          const { target } = await requireRegularFile(root, fileName);
          await unlink(target);
          sendJson(res, 200, { deleted: fileName });
        });
        return;
      }

      methodNotAllowed(res, ["GET", "HEAD", "POST", "DELETE"]);
    } catch (error) {
      sendError(res, error, onError);
    }
  };

  const serveFile = async (req, res, disposition) => {
    try {
      requireTrusted(req);
      if (req.method !== "GET" && req.method !== "HEAD") {
        methodNotAllowed(res, ["GET", "HEAD"]);
        return;
      }
      const fileName = queryName(req);
      const { target, info } = await requireRegularFile(root, fileName);
      const dispositionValue = disposition === "inline"
        ? `inline; filename="${asciiDownloadName(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
        : contentDisposition(fileName);
      // Office 文档 inline 预览：返回渲染好的 HTML（保留原布局）
      if (disposition === "inline" && OFFICE_EXTS.has(extname(fileName).toLowerCase())) {
        const buffer = await readFile(target);
        const officeHtml = await officePreviewHtml(fileName, buffer);
        sendJson(res, 200, {
          ok: true,
          name: fileName,
          size: info.size,
          mtime: info.mtimeMs,
          binary: true,
          truncated: officeHtml !== null && officeHtml.length > PREVIEW_LIMIT,
          contentType: contentType(fileName),
          content: undefined,
          officeHtml: officeHtml ?? undefined,
        });
        return;
      }
      // Markdown inline 预览：返回渲染后的 HTML 页面（真实效果，而非源码文本）。
      if (disposition === "inline" && /\.(md|markdown)$/i.test(fileName)) {
        const buffer = await readFile(target);
        const body = `<article class="md">${markdownToHtml(buffer.toString("utf8"))}</article>`;
        const downloadHref = `${DOWNLOAD_PATH}?name=${encodeURIComponent(fileName)}&download=1`;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(previewPageHtml(fileName, fileName, info.size, downloadHref, body, `${PREVIEW_PATH}?name=${encodeURIComponent(fileName)}&inline=1`));
        return;
      }
      res.writeHead(200, {
        "content-type": contentType(fileName),
        "content-length": info.size,
        "content-disposition": dispositionValue,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      const stream = createReadStream(target);
      stream.on("error", (error) => res.destroy(error));
      stream.pipe(res);
    } catch (error) {
      sendError(res, error, onError);
    }
  };

  const download = (req, res) => serveFile(req, res, "attachment");
  const preview = (req, res) => serveFile(req, res, "inline");

  const workspaceRoot = resolveWorkspaceRoot();
  const workspaceExcluded = workspaceExcludedName();

  const workspaceList = async (req, res) => {
    try {
      requireTrusted(req);
      if (req.method !== "GET" && req.method !== "HEAD") {
        methodNotAllowed(res, ["GET", "HEAD"]);
        return;
      }
      const groups = await collectGroups(workspaceRoot, workspaceExcluded);
      sendJson(res, 200, { ok: true, root: workspaceRoot, groups });
    } catch (error) {
      sendError(res, error, onError);
    }
  };

  const workspaceFile = async (req, res) => {
    try {
      requireTrusted(req);
      if (req.method !== "GET" && req.method !== "HEAD") {
        methodNotAllowed(res, ["GET", "HEAD"]);
        return;
      }
      const rel = (() => {
        try {
          return decodeURIComponent(new URL(req.url || "/", "http://dsh.internal").searchParams.get("path") || "");
        } catch {
          return "";
        }
      })();
      const full = safeResolve(workspaceRoot, rel);
      if (full === undefined) throw new HttpError(400, "invalid path");
      const info = await stat(full);
      if (!info.isFile()) throw new HttpError(400, "not a regular file");
      const download = new URL(req.url || "/", "http://dsh.internal").searchParams.get("download") === "1";
      const inline = new URL(req.url || "/", "http://dsh.internal").searchParams.get("inline") === "1";
      const name = rel.split("/").pop() || "file";
      if (download || inline) {
        // inline=1: 流式返回原始文件（浏览器内嵌渲染，如 PDF 查看器），
        // download=1: attachment 下载。两者都跳过 JSON 包装。
        const disposition = inline
          ? `inline; filename="${asciiDownloadName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`
          : contentDisposition(name);
        res.writeHead(200, {
          "content-type": inline ? contentType(name) : "application/octet-stream",
          "content-disposition": disposition,
          "content-length": String(info.size),
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        });
        const stream = createReadStream(full);
        stream.on("error", (error) => res.destroy(error));
        stream.pipe(res);
        return;
      }
      const buffer = await readFile(full);
      const binary = buffer.subarray(0, 8192).includes(0);
      const truncated = buffer.length > PREVIEW_LIMIT;
      const officeHtml = binary && OFFICE_EXTS.has(extname(name).toLowerCase())
        ? await officePreviewHtml(name, buffer)
        : undefined;
      // Markdown 返回内联样式后的完整 HTML 片段（含 MD_CSS），供前端 srcDoc 渲染真实效果，
      // 避免内嵌带独立头部的 workspace-preview 页面导致按钮重复、放大失效。
      const mdHtml = !binary && /\.(md|markdown)$/i.test(name)
        ? `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${MD_CSS}</style></head><body><article class="md">${markdownToHtml(buffer.toString("utf8"))}</article></body></html>`
        : undefined;
      sendJson(res, 200, {
        ok: true,
        path: rel,
        name,
        size: info.size,
        mtime: info.mtimeMs,
        binary,
        truncated,
        contentType: contentType(extname(name)),
        content: binary ? undefined : buffer.subarray(0, PREVIEW_LIMIT).toString("utf8"),
        officeHtml: officeHtml ?? undefined,
        mdHtml: mdHtml ?? undefined,
      });
    } catch (error) {
      sendError(res, error, onError);
    }
  };

  const workspaceDelete = async (req, res) => {
    try {
      requireTrusted(req);
      if (req.method !== "POST") {
        methodNotAllowed(res, ["POST"]);
        return;
      }
      const body = await readJsonBody(req);
      const rel = typeof body === "object" && body !== null ? body.path : undefined;
      const full = safeResolve(workspaceRoot, rel);
      if (full === undefined) throw new HttpError(400, "invalid path");
      const info = await stat(full);
      if (!info.isFile()) throw new HttpError(400, "not a regular file");
      await unlink(full);
      sendJson(res, 200, { ok: true, deleted: rel });
    } catch (error) {
      sendError(res, error, onError);
    }
  };

  const workspaceSave = async (req, res) => {
    try {
      requireTrusted(req);
      if (req.method !== "POST") {
        methodNotAllowed(res, ["POST"]);
        return;
      }
      const body = await readJsonBody(req);
      const rel = typeof body === "object" && body !== null ? body.path : undefined;
      const content = typeof body === "object" && body !== null ? body.content : undefined;
      if (typeof content !== "string") throw new HttpError(400, "content required");
      const full = safeResolve(workspaceRoot, rel);
      if (full === undefined) throw new HttpError(400, "invalid path");
      const info = await stat(full);
      if (!info.isFile()) throw new HttpError(400, "not a regular file");
      await writeFile(full, content, "utf8");
      sendJson(res, 200, { ok: true, path: rel });
    } catch (error) {
      sendError(res, error, onError);
    }
  };

  const workspacePreview = async (req, res) => {
    try {
      requireTrusted(req);
      if (req.method !== "GET" && req.method !== "HEAD") {
        methodNotAllowed(res, ["GET", "HEAD"]);
        return;
      }
      const rel = (() => {
        try {
          return decodeURIComponent(new URL(req.url || "/", "http://dsh.internal").searchParams.get("path") || "");
        } catch {
          return "";
        }
      })();
      const full = safeResolve(workspaceRoot, rel);
      if (full === undefined) throw new HttpError(400, "invalid path");
      const info = await stat(full);
      if (!info.isFile()) throw new HttpError(400, "not a regular file");
      const name = rel.split("/").pop() || "file";
      const ext = extname(name).toLowerCase();
      const buffer = await readFile(full);
      const size = info.size;
      const downloadHref = `workspace-file?path=${encodeURIComponent(rel)}&download=1`;
      let body;
      if (OFFICE_EXTS.has(ext)) {
        const html = await officePreviewHtml(name, buffer);
        body = html ? `<div class="office">${html}</div>` : `<p class="unsupported">该 Office 文档无法渲染，请下载查看。</p>`;
      } else if (/\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(name)) {
        body = `<img class="image" src="data:${contentType(ext) || "image/png"};base64,${buffer.toString("base64")}" alt="${escapeHtml(name)}">`;
      } else if (ext === ".svg") {
        body = `<img class="image" src="data:image/svg+xml;base64,${buffer.toString("base64")}" alt="${escapeHtml(name)}">`;
      } else if (ext === ".pdf") {
        // 直接指向原始文件 inline 流（浏览器 PDF 查看器原生渲染），
        // 避免 base64 data URI 在 iframe 内被 Chrome 拒绝。
        body = `<iframe class="pdf" src="workspace-file?path=${encodeURIComponent(rel)}&inline=1"></iframe>`;
      } else if (/\.(txt|log)$/i.test(name)) {
        body = `<pre class="text">${escapeHtml(buffer.toString("utf8"))}</pre>`;
      } else if (/\.(md|markdown)$/i.test(name)) {
        // Markdown → 直接渲染成 HTML（真实效果），失败回退源码文本。
        body = `<article class="md">${markdownToHtml(buffer.toString("utf8"))}</article>`;
      } else if (/\.(json|ya?ml|py|js|mjs|cjs|ts|sh|css|html?|xml|csv|ini|conf|env|toml|sql|rs|go|c|h|cpp|java|kt|swift|rb|php|vue|jsx|tsx)$/i.test(name)) {
        body = `<pre class="text">${escapeHtml(buffer.toString("utf8"))}</pre>`;
      } else {
        body = `<p class="unsupported">该文件类型暂不支持预览，请点击右上角「下载」。</p>`;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(previewPageHtml(name, rel, size, downloadHref, body, `workspace-file?path=${encodeURIComponent(rel)}&inline=1`));
    } catch (error) {
      sendError(res, error, onError);
    }
  };

  const workspaceBrowse = async (req, res) => {
    try {
      requireTrusted(req);
      if (req.method !== "GET" && req.method !== "HEAD") {
        methodNotAllowed(res, ["GET", "HEAD"]);
        return;
      }
      const params = new URL(req.url || "/", "http://dsh.internal").searchParams;
      const ws = params.get("ws") || "";
      const all = params.get("all") === "1";
      const groups = await collectGroups(workspaceRoot, workspaceExcluded);
      const view = all ? groups : (ws ? groups.filter((g) => g.folder === ws) : groups);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(workspaceBrowseHtml(view, ws, all));
    } catch (error) {
      sendError(res, error, onError);
    }
  };

  // ---- docx-preview 真实预览（浏览器端渲染）----
  // 返回一个自包含 HTML：引 jszip + docx-preview，再 fetch workspace-file?inline=1
  // 拿 .docx 原始字节，用 docx-preview 真实渲染（所见即所得）。仅供 .docx 预览。
  const docxPreviewPage = async (req, res) => {
    try {
      requireTrusted(req);
      if (req.method !== "GET" && req.method !== "HEAD") {
        methodNotAllowed(res, ["GET", "HEAD"]);
        return;
      }
      const rel = (() => {
        try {
          return decodeURIComponent(new URL(req.url || "/", "http://dsh.internal").searchParams.get("path") || "");
        } catch {
          return "";
        }
      })();
      // 只允许 .docx（避免把别的文件喂给 docx-preview）
      if (!/\.docx$/i.test(rel)) throw new HttpError(400, "only .docx supported");
      const full = safeResolve(workspaceRoot, rel);
      if (full === undefined) throw new HttpError(400, "invalid path");
      const info = await stat(full);
      if (!info.isFile()) throw new HttpError(400, "not a regular file");
      const name = rel.split("/").pop() || "file";
      const downloadHref = `workspace-file?path=${encodeURIComponent(rel)}&download=1`;
      const inlineHref = `workspace-file?path=${encodeURIComponent(rel)}&inline=1`;
      const assetBase = "/api/dsh-uploads/docx-preview-asset";
      // 用 encodeURIComponent 但保留正斜杠，保证 query 里合法
      const q = encodeURIComponent(rel).replace(/%2F/g, "/");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>预览 - ${escapeHtml(name)}</title>
<style>
 body{margin:0;background:#313b48;color:#1f2937}
 #container{padding:16px 0;overflow:auto}
 /* docx-preview 分页：每页一张"纸"，页间留间隙（breakPages 模式下 .docx-wrapper 内每个 .docx 是一页） */
 #container .docx-wrapper{background:transparent;padding:0;margin:0}
 #container .docx-wrapper > .docx,
 #container .docx-wrapper > section.docx,
 #container .docx-wrapper section.docx{background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.28);max-width:900px;margin:0 0 24px;padding:56px 64px;box-sizing:border-box}
 #container .docx-wrapper > .docx{min-height:1100px}
 #container img{max-width:100%}
 #container ._dsh-docx-stage{width:max-content !important;display:block !important}
 #container ._dsh-docx-stage section.docx,
 #container ._dsh-docx-stage .docx,
 #container > .docx{margin:0 0 24px !important}
</style>
</head><body>
<div style="position:sticky;top:0;z-index:20;display:flex;gap:6px;padding:8px 12px;align-items:center;flex-wrap:wrap;background:#1a2530">
  <strong style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e5e7eb;font-size:13px">${escapeHtml(name)}</strong>
  <span style="display:flex;gap:4px;align-items:center;color:#9ca3af;font-size:12px">
    <button type="button" title="缩小" onclick="zoomBy(0.8)" style="padding:4px 9px;border:1px solid #2c3a47;border-radius:7px;color:#e5e7eb;background:transparent;font-size:12px;cursor:pointer">−</button>
    <button type="button" title="放大" onclick="zoomBy(1.25)" style="padding:4px 9px;border:1px solid #2c3a47;border-radius:7px;color:#e5e7eb;background:transparent;font-size:12px;cursor:pointer">＋</button>
    <button type="button" title="适合宽度" onclick="zoomFit()" style="padding:4px 9px;border:1px solid #2c3a47;border-radius:7px;color:#e5e7eb;background:transparent;font-size:12px;cursor:pointer">适合</button>
  </span>
  <a class="btn" href="${downloadHref}" download style="padding:5px 12px;border:1px solid #2c3a47;border-radius:8px;color:#e5e7eb;text-decoration:none;font-size:13px">下载</a>
  <button type="button" onclick="closePreview()" style="padding:5px 12px;border:1px solid #2c3a47;border-radius:8px;color:#e5e7eb;background:transparent;text-decoration:none;font-size:13px;cursor:pointer">✕ 关闭</button>
</div>
<div id="container"><div style="padding:40px;text-align:center;color:#999">加载中…</div></div>
<script src="${assetBase}?f=jszip.min.js"></script>
<script src="${assetBase}?f=docx-preview.min.js"></script>
<script>
// 「✕ 关闭」：预览页自带的关闭按钮（与 md 预览页一致的"两层关闭"行为）。
// 在切换式弹窗（父窗口）里 → 通知父窗口回到文件列表；独立标签页 → 尝试关窗。
function closePreview() {
  try {
    if (window.self !== window.top && window.parent) {
      window.parent.postMessage({ type: 'dsh-close-preview' }, location.origin);
      return;
    }
  } catch (e) { /* 跨域忽略 */ }
  window.close();
}
const c=document.getElementById('container');
// docx 按纸张固定宽度渲染，手机上屏窄。这里用 transform:scale（统一缩放，不破坏内部绝对定位
// 排版，不会像 CSS zoom 那样叠字）。默认「适合宽度」整页完整显示，可放大读数。
var zoom=1, fitMode=true;
function dw(){
  // 文档页可能在 .docx-wrapper / .docx-wrap / 或直接 #container 里。取承载页面的元素；
  // 若直接在 #container，就包一层，避免缩放影响容器自身。
  var host=c.querySelector('.docx-wrapper, .docx-wrap');
  if(!host){ var p=c.querySelector('section.docx, .docx'); host=p? p.parentElement : c; }
  if(host && host===c){
    var wrap=document.createElement('div'); wrap.className='_dsh-docx-stage';
    while(c.firstChild) wrap.appendChild(c.firstChild);
    c.appendChild(wrap); host=wrap;
  }
  if(host){ host.style.width='max-content'; host.style.margin='0 auto'; }
  return host || c;
}
function applyZoom(){
  var w=dw(); if(!w) return;
  w.style.transformOrigin='top left';
  w.style.transform='scale('+zoom+')';
}
function zoomFit(){
  var page=c.querySelector('section.docx, .docx'); if(!page) return;
  var natW=page.offsetWidth||1; var target=c.clientWidth||1;
  zoom=Math.min(1, target/natW); fitMode=true; applyZoom();
}
function zoom100(){ zoom=1; fitMode=false; applyZoom(); }
function zoomBy(f){ zoom=Math.min(8, Math.max(0.05, zoom*f)); fitMode=false; applyZoom(); }
(async()=>{
  try{
    const r=await fetch(${JSON.stringify(inlineHref)}, {cache:'no-store'});
    if(!r.ok) throw new Error('HTTP '+r.status);
    const buf=await r.arrayBuffer();
    c.innerHTML='';
    // styleContainer 传 null：docx-preview 用自带样式。分页靠下方 .docx-wrapper > .docx 的纸张 CSS 控制。
    await docx.renderAsync(buf, c, null, {inWrapper:true, breakPages:true, ignoreLastRenderedPageBreak:false, experimental:true, className:'docx', useBase64URL:false});
    zoomFit();   // 默认「适合宽度」：整页等比缩放（行距/字号比例按 word 原样），可再放大读数
  }catch(e){ c.innerHTML='<p style="color:#dc2626;padding:20px">渲染失败：'+(e&&e.message||e)+'</p>'; }
})();
window.addEventListener('resize', function(){ try{ if(fitMode) zoomFit(); else applyZoom(); }catch(e){} });
</script>
</body></html>`);
    } catch (error) {
      sendError(res, error, onError);
    }
  };

  // serve jszip / docx-preview 库文件（从 PACKAGE_DIR/client/vendor 读）
  const docxPreviewAsset = async (req, res) => {
    try {
      requireTrusted(req);
      if (req.method !== "GET" && req.method !== "HEAD") {
        methodNotAllowed(res, ["GET", "HEAD"]);
        return;
      }
      const f = decodeURIComponent(new URL(req.url || "/", "http://dsh.internal").searchParams.get("f") || "");
      // 允许的 vendor 前端库（docx-preview 与 pptx-preview 共用这一端点）
      if (!["jszip.min.js", "docx-preview.min.js", "pptxviewjs.min.js", "chart.umd.min.js"].includes(f)) throw new HttpError(400, "unknown asset");
      const target = join(VENDOR_DIR, f);
      const buf = await readFile(target);
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(buf);
    } catch (error) {
      sendError(res, error, onError);
    }
  };

  // ---- PptxViewJS 真实预览（浏览器端渲染，所见即所得）----
  // 返回一个自包含 HTML：引 jszip + chart.js + pptxviewjs，再 fetch workspace-file?inline=1
  // 拿 .pptx 原始字节，用 PptxViewJS 在 Canvas 上渲染每页幻灯片（可翻页）。仅供 .pptx 预览。
  const pptxPreviewPage = async (req, res) => {
    try {
      requireTrusted(req);
      if (req.method !== "GET" && req.method !== "HEAD") {
        methodNotAllowed(res, ["GET", "HEAD"]);
        return;
      }
      const rel = (() => {
        try {
          return decodeURIComponent(new URL(req.url || "/", "http://dsh.internal").searchParams.get("path") || "");
        } catch {
          return "";
        }
      })();
      // 只允许 .pptx（避免把别的文件喂给 PptxViewJS）
      if (!/\.pptx$/i.test(rel)) throw new HttpError(400, "only .pptx supported");
      const full = safeResolve(workspaceRoot, rel);
      if (full === undefined) throw new HttpError(400, "invalid path");
      const info = await stat(full);
      if (!info.isFile()) throw new HttpError(400, "not a regular file");
      const name = rel.split("/").pop() || "file";
      const downloadHref = `workspace-file?path=${encodeURIComponent(rel)}&download=1`;
      const inlineHref = `workspace-file?path=${encodeURIComponent(rel)}&inline=1`;
      const assetBase = "/api/dsh-uploads/docx-preview-asset";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>预览 - ${escapeHtml(name)}</title>
<style>
 body{margin:0;background:#1a2530;color:#e5e7eb;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
 .bar{position:sticky;top:0;z-index:20;display:flex;gap:8px;padding:10px 14px;align-items:center;background:#1a2530;border-bottom:1px solid #2c3a47;flex-wrap:wrap}
 .bar strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e5e7eb;font-size:13px}
 .bar button,.bar a{padding:6px 12px;border:1px solid #2c3a47;border-radius:8px;background:transparent;color:#e5e7eb;text-decoration:none;font-size:13px;cursor:pointer;white-space:nowrap}
 .bar button:disabled{opacity:.45;cursor:default}
 #stage{display:block;overflow:auto;padding:20px 16px 44px;min-height:calc(100vh - 60px)}
 #stage canvas{display:block;margin:0 auto;background:#fff;border-radius:8px;box-shadow:0 4px 22px rgba(0,0,0,.45)}
 #status{font-size:12px;color:#9ca3af;min-width:70px;text-align:center}
 #msg{color:#9ca3af}
 /* 电脑预览器式左右翻页箭头：浮在幻灯片两侧 */
 .pv-arrow{position:fixed;top:50%;transform:translateY(-50%);z-index:30;width:48px;height:48px;border-radius:50%;border:1px solid rgba(255,255,255,.28);background:rgba(18,28,42,.55);color:#fff;font-size:26px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none}
 .pv-arrow:hover{background:rgba(45,66,95,.85)}
 .pv-arrow:disabled{opacity:.28;cursor:default}
 .pv-prev{left:10px}
 .pv-next{right:10px}
 @media (max-width:767px){ .pv-arrow{width:40px;height:40px;font-size:22px} }
</style>
</head><body>
<div class="bar">
  <strong>${escapeHtml(name)}</strong>
  <span style="display:flex;gap:4px;align-items:center">
    <button type="button" title="缩小" onclick="zoomBy(0.8)">−</button>
    <button type="button" title="放大" onclick="zoomBy(1.25)">＋</button>
    <button type="button" title="适合宽度" onclick="zoomFit()">适合</button>
  </span>
  <button type="button" id="prev" disabled>‹ 上一页</button>
  <span id="status">— / —</span>
  <button type="button" id="next" disabled>下一页 ›</button>
  <a href="${downloadHref}" download>下载</a>
  <button type="button" onclick="closePreview()">✕ 关闭</button>
</div>
<div id="stage"><div id="msg">加载中…</div><canvas id="canvas" style="display:none"></canvas></div>
<button type="button" class="pv-arrow pv-prev" id="prevOverlay" title="上一页" disabled>‹</button>
<button type="button" class="pv-arrow pv-next" id="nextOverlay" title="下一页" disabled>›</button>
<script src="${assetBase}?f=jszip.min.js"></script>
<script src="${assetBase}?f=chart.umd.min.js"></script>
<script src="${assetBase}?f=pptxviewjs.min.js"></script>
<script>
// 「✕ 关闭」：预览页自带的关闭按钮（与 md/docx 预览一致的"两层关闭"行为）。
function closePreview(){
  try{ if(window.self!==window.top&&window.parent){ window.parent.postMessage({type:'dsh-close-preview'},location.origin); return; } }catch(e){ /* 跨域忽略 */ }
  window.close();
}
const canvas=document.getElementById('canvas');
const stage=document.getElementById('stage');
const msg=document.getElementById('msg');
const prevBtn=document.getElementById('prev');
const nextBtn=document.getElementById('next');
const prevOverlay=document.getElementById('prevOverlay');
const nextOverlay=document.getElementById('nextOverlay');
const status=document.getElementById('status');
let viewer=null,total=0;
var zoom=1, fitMode=true;
// 幻灯片缩放：控制 canvas 的 CSS 显示尺寸等比放大/缩小（transform 对 canvas 容易叠字/错位，
// 用 CSS width/height 更稳）。默认「适合宽度」看整页，可放大读数。
function applyZoom(){
  var nw=canvas.width||1280, nh=canvas.height||720;
  canvas.style.width=Math.round(nw*zoom)+'px';
  canvas.style.height=Math.round(nh*zoom)+'px';
}
function zoomFit(){
  var nw=canvas.width||1280;
  // 用「内容区宽度」(clientWidth - 左右 padding)，否则 canvas 会多出 padding 宽度、造成横向溢出，
  // 拖到手势里「有溢出=已放大」的误判，导致滑动翻页失效。
  var cs=getComputedStyle(stage); var pl=parseFloat(cs.paddingLeft)||0, pr=parseFloat(cs.paddingRight)||0;
  var t=(stage.clientWidth-pl-pr)||1;
  zoom=Math.min(1, t/nw); fitMode=true; applyZoom();
}
function zoom100(){ zoom=1; fitMode=false; applyZoom(); }
function zoomBy(f){ zoom=Math.min(2,Math.max(0.05,zoom*f)); fitMode=false; applyZoom(); }
function update(){
  if(!viewer)return;
  const cur=viewer.getCurrentSlideIndex();
  status.textContent='第 '+(cur+1)+' / '+total+' 页';
  prevBtn.disabled=cur<=0; prevOverlay.disabled=cur<=0;
  nextBtn.disabled=cur>=total-1; nextOverlay.disabled=cur>=total-1;
}
(async()=>{
  try{
    const r=await fetch(${JSON.stringify(inlineHref)},{cache:'no-store'});
    if(!r.ok) throw new Error('HTTP '+r.status);
    const blob=await r.blob();
    msg.style.display='none';
    canvas.style.display='block';
    // 给一个确定的初始尺寸，确保库能正常渲染；显示由 CSS 缩放（分辨率取高些，放大时更清晰）
    canvas.width=1920; canvas.height=1080;
    viewer=new window.PptxViewJS.PPTXViewer({canvas});
    await viewer.loadFile(new File([blob],${JSON.stringify(name)},{type:'application/vnd.openxmlformats-officedocument.presentationml.presentation'}));
    await viewer.render();
    total=viewer.getSlideCount();
    zoomFit();
    update();
  }catch(e){
    msg.style.display='';
    msg.textContent='渲染失败：'+((e&&e.message)||e);
    console.error(e);
  }
})();
prevBtn.addEventListener('click',async()=>{if(viewer){await viewer.previousSlide();update();}});
nextBtn.addEventListener('click',async()=>{if(viewer){await viewer.nextSlide();update();}});
prevOverlay.addEventListener('click',async()=>{if(viewer){await viewer.previousSlide();update();}});
nextOverlay.addEventListener('click',async()=>{if(viewer){await viewer.nextSlide();update();}});
window.addEventListener('resize',function(){ try{ if(fitMode) zoomFit(); else applyZoom(); }catch(e){} });
</script>
</body></html>`);
    } catch (error) {
      sendError(res, error, onError);
    }
  };

  return { root, maxFileBytes, totalMaxBytes, api, download, preview, workspaceList, workspaceFile, workspacePreview, workspaceBrowse, workspaceDelete, workspaceSave, docxPreviewPage, docxPreviewAsset, pptxPreviewPage };
}

/** 人类可读文件大小。 */
function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 人类可读相对时间。 */
function humanTime(ms) {
  if (!Number.isFinite(ms)) return "-";
  const diff = Date.now() - ms;
  if (diff < 60 * 1000) return "刚刚";
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 扩展名是否可内嵌预览（与前端 INLINE_PREVIEW_EXTS + 图片 + Office 一致）。 */
const INLINE_PREVIEW_EXTS = new Set([
  ".pdf", ".txt", ".md", ".markdown", ".json", ".yml", ".yaml", ".xml", ".html", ".htm",
  ".csv", ".tsv", ".log", ".ini", ".conf", ".env", ".toml", ".rtf",
  ".py", ".js", ".mjs", ".cjs", ".ts", ".sh", ".css", ".sql", ".rs", ".go", ".c", ".h", ".cpp",
  ".java", ".kt", ".swift", ".rb", ".php", ".vue", ".jsx", ".tsx",
]);
const INLINE_PREVIEW_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg"]);
function isInlinePreviewableName(name) {
  const ext = extname(name).toLowerCase();
  return OFFICE_EXTS.has(ext) || INLINE_PREVIEW_EXTS.has(ext) || INLINE_PREVIEW_IMAGE_EXTS.has(ext);
}

/** 工作区文件浏览页面。顶部并列切换：📁工作区文件 / 📂总文件；ws=所在工作区，all=1 显示全部。 */
function workspaceBrowseHtml(groups, ws = "", all = false) {
  const total = groups.reduce((sum, g) => sum + g.files.length, 0);
  const enc = encodeURIComponent(ws);
  const wsHref = ws ? `workspace-browse?ws=${enc}` : "";
  const allHref = ws ? `workspace-browse?ws=${enc}&all=1` : "workspace-browse";
  const refreshHref = all ? allHref : (wsHref || "workspace-browse");
  const metaText = all ? `全部工作区 · ${total} 个文件` : (ws ? `${escapeHtml(ws)} · ${total} 个文件` : `全部工作区 · ${total} 个文件`);
  const section = (group) => {
    if (group.files.length === 0) return "";
    const rows = group.files.map((f) => {
      const rel = encodeURIComponent(f.path);
      const previewable = isInlinePreviewableName(f.name);
      const isPdf = /\.pdf$/i.test(f.name);
      const isDocx = /\.docx$/i.test(f.name);
      const isPptx = /\.pptx$/i.test(f.name);
      // PDF 直接嵌原始流（单层 iframe，浏览器原生查看器可滚动翻页）；
      // docx 走 docx-preview、pptx 走 PptxViewJS 真实渲染页（浏览器端解析，所见即所得）；
      // 其它可预览类型走渲染页；不可预览 → 下载。
      const viewHref = previewable
        ? (isPdf ? `workspace-file?path=${rel}&inline=1` : isDocx ? `docx-preview?path=${rel}` : isPptx ? `pptx-preview?path=${rel}` : `workspace-preview?path=${rel}&from=list`)
        : `workspace-file?path=${rel}&download=1`;
      return `<tr data-ts="${Math.floor(f.mtime)}" data-name="${escapeHtml(f.name)}">
        <td class="name"><a class="flink" href="${viewHref}" data-preview="${escapeHtml(viewHref)}" title="${escapeHtml(f.path)}">${escapeHtml(f.name)}</a></td>
        <td class="size">${humanSize(f.size)}</td>
        <td class="time">${humanTime(f.mtime)}</td>
        <td class="acts">
          ${previewable ? `<a class="tag" href="${viewHref}" data-preview="${escapeHtml(viewHref)}">${ICON_EYE} 预览</a>` : `<a class="tag" href="${viewHref}">${ICON_DL} 下载</a>`}
          <a class="tag dl" href="workspace-file?path=${rel}&download=1">${ICON_DL} 下载</a>
        </td>
      </tr>`;
    }).join("");
    return `<div class="group"><h2 class="gtoggle">${escapeHtml(group.folder)} <span class="cnt">${group.files.length}</span></h2>
      <table><thead><tr><th>文件</th><th>大小</th><th>修改</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  };
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>工作区文件</title>
<style>
  * { box-sizing: border-box; }
  :root {
    --lp-bg:#0f1720; --lp-fg:#e5e7eb; --lp-bar-bg:#1a2530; --lp-border:#2c3a47;
    --lp-meta:#9ca3af; --lp-hover:#273449; --lp-btn-bg:#374151; --lp-btn-fg:#e5e7eb;
    --lp-btn-hover:#4b5563; --lp-h2:#93c5fd; --lp-accent:#93c5fd; --lp-ok:#86efac;
    --lp-table-bg:#111a24; --lp-table-border:#263241; --lp-cell-border:#1c2836;
    --lp-th-bg:#16222f; --lp-row-hover:#17232f; --lp-flink:#e5e7eb;
    --lp-tag-bg:#1e293b; --lp-tag-hover:#273449; --lp-seg-hover:#273449;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --lp-bg:#ffffff; --lp-fg:#1f2937; --lp-bar-bg:#f3f4f6; --lp-border:#e5e7eb;
      --lp-meta:#6b7280; --lp-hover:#e5e7eb; --lp-btn-bg:#e5e7eb; --lp-btn-fg:#374151;
      --lp-btn-hover:#d1d5db; --lp-h2:#1d4ed8; --lp-accent:#1d4ed8; --lp-ok:#15803d;
      --lp-table-bg:#ffffff; --lp-table-border:#e5e7eb; --lp-cell-border:#f3f4f6;
      --lp-th-bg:#f9fafb; --lp-row-hover:#f3f4f6; --lp-flink:#1f2937;
      --lp-tag-bg:#eff6ff; --lp-tag-hover:#dbeafe; --lp-seg-hover:#e5e7eb;
    }
  }
  body { margin:0; font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; background:var(--lp-bg); color:var(--lp-fg); }
  .bar { position:sticky; top:0; display:flex; align-items:center; gap:14px; padding:12px 20px; background:var(--lp-bar-bg); border-bottom:1px solid var(--lp-border); z-index:5; flex-wrap:wrap; }
  .seg { display:flex; border:1px solid var(--lp-border); border-radius:10px; overflow:hidden; flex:none; }
  .seg a { display:inline-flex; align-items:center; gap:6px; padding:8px 18px; font-size:14px; text-decoration:none; color:var(--lp-meta); background:transparent; }
  .seg a + a { border-left:1px solid var(--lp-border); }
  .seg a.on { background:#2563eb; color:#fff; }
  .seg a:hover:not(.on) { background:var(--lp-seg-hover); color:var(--lp-fg); }
  .bar .meta { color:var(--lp-meta); font-size:13px; }
  .bar .spacer { flex:1; }
  .btn { display:inline-flex; align-items:center; gap:6px; background:var(--lp-btn-bg); color:var(--lp-btn-fg); text-decoration:none; border-radius:8px; padding:7px 14px; font-size:13px; flex:none; }
  .btn:hover { background:var(--lp-btn-hover); }
  .wrap { max-width:980px; margin:0 auto; padding:20px; }
  .group { margin-bottom:26px; }
  .group h2 { font-size:15px; margin:0 0 8px; color:var(--lp-h2); }
  .cnt { color:var(--lp-meta); font-size:12px; font-weight:400; }
  .gtoggle { cursor:pointer; user-select:none; display:inline-flex; align-items:center; gap:8px; }
  .gtoggle:before { content:'▾'; font-size:11px; color:var(--lp-meta); transition:transform .15s; }
  .group.collapsed .gtoggle:before { content:'▸'; }
  .group.collapsed table { display:none; }
  .group.filtered-empty { display:none; }
  .daybox { display:inline-flex; align-items:center; gap:8px; flex:none; }
  .daylabel { color:var(--lp-meta); font-size:13px; }
  .dfilter { position:relative; display:inline-flex; align-items:center; gap:6px; min-width:118px; border:1px solid var(--lp-border); border-radius:8px; background:var(--lp-btn-bg); color:var(--lp-fg); padding:5px 8px; font-size:13px; cursor:pointer; }
  .dfilter:hover { border-color:var(--lp-accent); }
  .dfilter.has-value { border-color:var(--lp-accent); }
  .dfilter-icon { font-size:13px; flex:none; }
  .dfilter-text { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .dfilter-clear { position:relative; z-index:2; background:transparent; border:none; color:var(--lp-meta); font-size:12px; line-height:1; cursor:pointer; padding:0 2px; }
  .dfilter-clear:hover { color:var(--lp-fg); }
  .dfilter-native { position:absolute; inset:0; width:100%; height:100%; opacity:0; cursor:pointer; pointer-events:auto; z-index:1; }
  .fsearch-wrap { position:relative; display:inline-flex; align-items:center; flex:none; }
  .fsearch-btn { width:30px; height:30px; border:1px solid var(--lp-border); border-radius:8px; background:var(--lp-btn-bg); color:var(--lp-fg); font-size:14px; line-height:1; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; }
  .fsearch-btn:hover { background:var(--lp-btn-hover); }
  .fsearch-box { position:fixed; z-index:60; display:flex; align-items:center; gap:6px; background:var(--lp-bar-bg); border:1px solid var(--lp-border); border-radius:10px; padding:6px; box-shadow:var(--lp-shadow-lv3, 0 10px 30px rgba(0,0,0,.35)); max-width:calc(100vw - 16px); }
  .fsearch { background:var(--lp-btn-bg); color:var(--lp-fg); border:1px solid var(--lp-border); border-radius:8px; padding:5px 10px; font-size:13px; min-width:160px; }
  .fsearch::placeholder { color:var(--lp-meta); }
  .fsearch:focus { outline:none; border-color:var(--lp-accent); }
  .fsearch-clear { background:transparent; border:none; color:var(--lp-meta); font-size:13px; line-height:1; cursor:pointer; padding:0 3px; }
  .fsearch-clear:hover { color:var(--lp-fg); }
  .btn2 { display:inline-flex; align-items:center; background:var(--lp-btn-bg); color:var(--lp-btn-fg); border:1px solid var(--lp-border); border-radius:8px; padding:6px 11px; font-size:12px; cursor:pointer; }
  .btn2:hover { background:var(--lp-btn-hover); }
  .daybtn.active { background:#2563eb; color:#fff; }
  table { width:100%; border-collapse:collapse; background:var(--lp-table-bg); border:1px solid var(--lp-table-border); border-radius:10px; overflow:hidden; }
  th, td { text-align:left; padding:9px 14px; font-size:13px; border-bottom:1px solid var(--lp-cell-border); }
  th { background:var(--lp-th-bg); color:var(--lp-meta); font-weight:500; }
  tr:last-child td { border-bottom:none; }
  tr:hover td { background:var(--lp-row-hover); }
  .name { max-width:380px; }
  .flink { color:var(--lp-flink); text-decoration:none; word-break:break-all; }
  .flink:hover { color:var(--lp-accent); text-decoration:underline; }
  .size, .time { color:var(--lp-meta); white-space:nowrap; }
  .acts { white-space:nowrap; }
  .tag { display:inline-flex; align-items:center; gap:4px; text-decoration:none; font-size:12px; padding:4px 10px; border-radius:6px; margin-right:6px; background:var(--lp-tag-bg); color:var(--lp-accent); }
  .tag:hover { background:var(--lp-tag-hover); }
  .tag.dl { color:var(--lp-ok); }
  .empty { color:var(--lp-meta); text-align:center; padding:60px 0; }
  .ic { width:14px; height:14px; flex:none; }
  @media (max-width: 640px) {
    .bar { padding:10px 12px; gap:10px; }
    .seg a { padding:7px 14px; font-size:13px; }
    .group { margin-bottom:14px; }
    table, thead, tbody, tr, th, td { display:block; }
    thead { display:none; }
    tbody { display:block; }
    tr { background:var(--lp-table-bg); border:1px solid var(--lp-table-border); border-radius:10px; padding:10px 12px; margin-bottom:8px; }
    td { border:none; padding:2px 0; }
    .name { max-width:none; }
    .flink { font-size:14px; }
    .size, .time { display:inline-block; margin-right:12px; }
    .acts { margin-top:6px; }
  }
</style>
</head>
<body>
<div class="bar">
  <div class="seg">
    <a class="${!all && ws ? "on" : ""}" href="${wsHref || "#"}" ${wsHref ? "" : 'aria-disabled="true" title="从会话窗口的「📂 文件」进入可回到当前工作区"'}>${ICON_FOLDER} 工作区文件</a>
    <a class="${all ? "on" : ""}" href="${allHref}">${ICON_FOLDER_OPEN} 总文件</a>
  </div>
  <span class="meta">${metaText}</span>
  <span class="daybox">
    <label class="daylabel" for="dayFilter">日期</label>
    <span class="dfilter" id="dfilter">
      <span class="dfilter-icon">📅</span>
      <span class="dfilter-text" id="dfilterText">选择日期</span>
      <button type="button" class="dfilter-clear" id="dfilterClear" title="清除" aria-label="清除日期" style="display:none">✕</button>
      <input type="date" id="dayFilter" class="dfilter-native" aria-label="按日期筛选">
    </span>
    <button type="button" class="btn2 daybtn" id="dayToday">今天</button>
    <span class="fsearch-wrap" id="fsearchWrap">
      <button type="button" class="fsearch-btn" id="fsearchBtn" title="搜索文件名" aria-label="搜索文件名">🔍</button>
      <span class="fsearch-box" id="fsearchBox" style="display:none">
        <input type="text" class="fsearch" id="fsearch" placeholder="搜索文件名…" aria-label="搜索文件名">
        <button type="button" class="fsearch-clear" id="fsearchClear" title="清除" aria-label="清除搜索">✕</button>
      </span>
    </span>
  </span>
  <span class="spacer"></span>
  <a class="btn" href="${refreshHref}">⟳ 刷新</a>
</div>
<div class="wrap">
  ${groups.map(section).join("") || `<p class="empty">${ws && !all ? `工作区「${escapeHtml(ws)}」还没有文件` : "工作区还没有文件"}</p>`}
  <p class="empty" id="filterEmpty" style="display:none">没有匹配的文件</p>
</div>
<script>
// 预览链接点击 → 通知父窗口（wsOverlay）打开，父窗口用 embed/iframe 渲染，
// 避免在嵌套 iframe 内直接导航导致 PDF 无法滚动。
document.addEventListener('click', function (e) {
  var el = e.target && e.target.closest ? e.target.closest('[data-preview]') : null;
  if (!el) return;
  // el.href：浏览器解码 HTML 实体（&amp; → &）并绝对化，消除歧义
  var abs = el.href;
  if (!abs) return;
  e.preventDefault();
  e.stopPropagation();
  var name = (el.getAttribute('title') || el.textContent || '').trim().split('/').pop();
  try {
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'dsh-open-preview', url: abs, title: name }, location.origin);
      return;
    }
  } catch (err) { /* 跨域忽略 */ }
  location.href = abs;
});
// 按文件夹可折叠 + 按日期筛选（前端 JS；mtime 以浏览器本地时区算日期）
(function () {
  var groups = Array.prototype.slice.call(document.querySelectorAll('.group'));
  // 1) 文件夹头点击 → 折叠/展开
  groups.forEach(function (g) {
    var h = g.querySelector('.gtoggle');
    if (h) h.addEventListener('click', function () { g.classList.toggle('collapsed'); });
  });
  // 2) 日期筛选
  var dayInput = document.getElementById('dayFilter');
  var dayToday = document.getElementById('dayToday');
  var dfilter = document.getElementById('dfilter');
  var dfilterText = document.getElementById('dfilterText');
  var dfilterClear = document.getElementById('dfilterClear');
  var fsearch = document.getElementById('fsearch');
  var filterEmpty = document.getElementById('filterEmpty');
  // 预览后返回不丢检索：用 sessionStorage 记住检索词与检索框开/关状态。
  var savedSearch = '';
  var savedOpen = false;
  try { savedSearch = sessionStorage.getItem('wsb-search') || ''; } catch (e) {}
  try { savedOpen = sessionStorage.getItem('wsb-search-open') === '1'; } catch (e) {}
  if (fsearch) fsearch.value = savedSearch;
  var metaEl = document.querySelector('.bar .meta');
  var origMeta = metaEl ? metaEl.textContent : '';
  function pad(v) { return v < 10 ? '0' + v : v; }
  function fmtDate(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function matchName(tr) {
    var q = (fsearch && fsearch.value || '').trim().toLowerCase();
    if (!q) return true;
    var hay = String(tr.dataset.name || '').toLowerCase();
    return q.split(/\s+/).filter(Boolean).every(function (tok) { return hay.indexOf(tok) !== -1; });
  }
  // 预计算每行本地日期
  Array.prototype.forEach.call(document.querySelectorAll('tr[data-ts]'), function (tr) {
    tr.dataset.date = fmtDate(Number(tr.dataset.ts));
  });
  var todayStr = fmtDate(Date.now());
  function apply() {
    var sel = dayInput.value;
    var visTotal = 0;
    groups.forEach(function (g) {
      var vis = 0;
      Array.prototype.forEach.call(g.querySelectorAll('tr[data-date]'), function (tr) {
        var ok = (!sel || tr.dataset.date === sel) && matchName(tr);
        tr.style.display = ok ? '' : 'none';
        if (ok) vis++;
      });
      var cnt = g.querySelector('.cnt');
      if (cnt) cnt.textContent = vis;
      if (vis === 0) g.classList.add('filtered-empty'); else g.classList.remove('filtered-empty');
      visTotal += vis;
    });
    var searching = fsearch && fsearch.value.trim();
    if (metaEl) metaEl.textContent = (sel || searching) ? ('筛选 ' + (sel || '日期') + (searching ? ' · ' + searching : '') + ' · ' + visTotal + ' 个文件') : origMeta;
    if (dfilterText) dfilterText.textContent = sel || '选择日期';
    if (dfilterClear) dfilterClear.style.display = sel ? 'inline-block' : 'none';
    if (dfilter) dfilter.classList.toggle('has-value', !!sel);
    if (dayToday) dayToday.classList.toggle('active', sel === todayStr);
    if (filterEmpty) filterEmpty.style.display = ((sel || searching) && visTotal === 0) ? 'block' : 'none';
  }
  // 打开日期选择器：整个控件点击 → showPicker（兜底 focus）；点 ✕ 清除（阻止冒泡）。
  if (dfilter) dfilter.addEventListener('click', function () {
    var el = dayInput;
    if (!el) return;
    if (typeof el.showPicker === 'function') { try { el.showPicker(); return; } catch (e) {} }
    try { el.focus(); } catch (e) {}
  });
  if (dayInput) dayInput.addEventListener('input', apply);
  if (dayInput) dayInput.addEventListener('change', apply);
  if (fsearch) fsearch.addEventListener('input', function () { try { sessionStorage.setItem('wsb-search', fsearch.value); } catch (e) {} apply(); });
  // 🔍 搜索弹窗：点击图标开/关，点✕清除，点击外部关闭。
  var fsearchBtn = document.getElementById('fsearchBtn');
  var fsearchBox = document.getElementById('fsearchBox');
  var fsearchClear = document.getElementById('fsearchClear');
  var fsearchWrap = document.getElementById('fsearchWrap');
  var fsearchOpen = false;
  function setFsearchOpen(open) {
    fsearchOpen = open;
    try { sessionStorage.setItem('wsb-search-open', open ? '1' : '0'); } catch (e) {}
    if (fsearchBox) {
      fsearchBox.style.display = open ? 'flex' : 'none';
      if (open && fsearchBtn) {
        var r = fsearchBtn.getBoundingClientRect();
        fsearchBox.style.top = (r.bottom + 8) + 'px';
        fsearchBox.style.left = Math.max(8, Math.min(r.left, (window.innerWidth || 0) - 280)) + 'px';
      }
    }
    if (open && fsearch) { try { fsearch.focus(); } catch (e) {} }
  }
  if (fsearchBtn) fsearchBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); setFsearchOpen(!fsearchOpen); });
  if (fsearchClear) fsearchClear.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
  if (fsearchClear) fsearchClear.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); fsearch.value = ''; try { sessionStorage.removeItem('wsb-search'); sessionStorage.removeItem('wsb-search-open'); } catch (e2) {} apply(); setFsearchOpen(false); });
  if (dayToday) dayToday.addEventListener('click', function () { dayInput.value = todayStr; apply(); });
  if (dfilterClear) dfilterClear.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); dayInput.value = ''; apply(); });
  if (savedOpen) setFsearchOpen(true);
  apply();
})();
</script>
</body>
</html>`;
}

/** 内联 SVG 图标（眼睛/下载/文件夹，比 emoji 干净）。 */
const ICON_EYE = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_DL = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
const ICON_FOLDER = '<svg class="ic" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>';
const ICON_FOLDER_OPEN = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
const ICON_X = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
/** 独立可访问的 SVG 图标文件（供聊天 markdown 图片内联，颜色固定、尺寸 14px）。 */
const ICON_FILES = {
  "eye.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#93c5fd" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  "download.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#86efac" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
};

/** 渲染后 Markdown 的通用样式（供预览页与 mdHtml srcDoc 共用，跟随明暗主题）。 */
const MD_CSS = `
  :root { --lp-bg:#0f1720; --lp-fg:#e5e7eb; --lp-text-bg:#0b1219; --lp-border:#2c3a47; --lp-bar-bg:#1a2530; --lp-meta:#9ca3af; }
  @media (prefers-color-scheme: light) { :root { --lp-bg:#ffffff; --lp-fg:#1f2937; --lp-text-bg:#f9fafb; --lp-border:#e5e7eb; --lp-bar-bg:#f3f4f6; --lp-meta:#6b7280; } }
  body { margin:0; background:var(--lp-bg); color:var(--lp-fg); }
  .md { line-height:1.8; font-size:14px; word-break:break-word; padding:24px 32px 48px; max-width:820px; margin:0 auto; }
  .md h1,.md h2,.md h3,.md h4,.md h5,.md h6 { line-height:1.45; margin:1.7em 0 .8em; }
  .md h1 { font-size:1.5em; } .md h2 { font-size:1.3em; } .md h3 { font-size:1.15em; }
  .md h1:first-child,.md h2:first-child,.md h3:first-child { margin-top:.6em; }
  .md p { margin:1em 0; }
  .md a { color:#60a5fa; text-decoration:none; } .md a:hover { text-decoration:underline; }
  .md code { background:var(--lp-text-bg); border:1px solid var(--lp-border); border-radius:4px; padding:1px 5px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.9em; }
  .md pre.md-code { background:var(--lp-text-bg); border:1px solid var(--lp-border); border-radius:8px; padding:12px; overflow:auto; }
  .md pre.md-code code { background:none; border:none; padding:0; font-size:12px; line-height:1.6; }
  .md blockquote { margin:.8em 0; padding:.2em 1em; border-left:3px solid var(--lp-border); color:var(--lp-meta); }
  .md ul,.md ol { margin:.6em 0; padding-left:1.6em; } .md li { margin:.2em 0; }
  .md table { border-collapse:collapse; margin:.8em 0; max-width:100%; display:block; overflow:auto; }
  .md th,.md td { border:1px solid var(--lp-border); padding:6px 10px; font-size:13px; }
  .md th { background:var(--lp-bar-bg); font-weight:600; }
  .md img { max-width:100%; border-radius:8px; }
  .md hr { border:none; border-top:1px solid var(--lp-border); margin:1.5em 0; }
  .md del { color:var(--lp-meta); }
`;

/** HTML 转义。 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 最小 Markdown → HTML 渲染器（零依赖，供 md/markdown 预览用）。
 * 覆盖常见语法：标题、加粗/斜体、行内代码、代码块、有序/无序列表、
 * 表格、引用、分隔线、链接、图片、段落。仅用于预览，不做完整 GFM。
 * 任何解析失败都回退到源码文本（escape 后 <pre>），不会抛错。
 */
function markdownToHtml(md) {
  const esc = escapeHtml;
  let text = String(md).replace(/\r\n?/g, "\n");

  // 1) 代码块（多行 ``` 或 缩进 4 空格）——整体抽取，避免内部内容被后续规则误处理
  const codeBlocks = [];
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code) => {
    codeBlocks.push(code.replace(/^\n/, ""));
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });
  // 缩进代码块（连续 >=4 空格行）
  text = text.replace(/(?:^|\n)((?: {4}[^\n]*\n?)+)/g, (_m, block) => {
    codeBlocks.push(block.split("\n").filter((l) => l.trim()).map((l) => l.replace(/^ {4}/, "")).join("\n"));
    return `\n\u0000CODE${codeBlocks.length - 1}\u0000`;
  });

  // 2) 行内元素处理函数（在分段后应用）
  const inline = (s) =>
    s
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, alt, src, title) => {
        const t = title ? ` title="${esc(title)}"` : "";
        return `<img src="${esc(src)}" alt="${esc(alt)}"${t}>`;
      })
      .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, label, href, title) => {
        const t = title ? ` title="${esc(title)}"` : "";
        return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"${t}>${esc(label)}</a>`;
      })
      .replace(/`([^`]+)`/g, (_m, code) => `<code>${esc(code)}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, (_m, b) => `<strong>${esc(b)}</strong>`)
      .replace(/__([^_]+)__/g, (_m, b) => `<strong>${esc(b)}</strong>`)
      .replace(/(^|[^*])\*([^*]+)\*/g, (_m, pre, i) => `${pre}<em>${esc(i)}</em>`)
      .replace(/(^|[^_])_([^_]+)_/g, (_m, pre, i) => `${pre}<em>${esc(i)}</em>`)
      .replace(/~~([^~]+)~~/g, (_m, d) => `<del>${esc(d)}</del>`);
  // 注意：链接/图片的 URL 不转义内部空格，且 href 用 esc 防注入。

  // 3) 按块处理（保留代码块哨兵与表格）
  const lines = text.split("\n");
  const out = [];
  let para = []; // 累积段落行
  let list = null; // { ordered, items:[{indent,text}] }
  let table = null;

  const flushPara = () => {
    if (para.length) {
      const content = inline(para.join("\n"));
      out.push(`<p>${content}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? "ol" : "ul";
    const items = list.items.map((it) => `<li>${inline(it.text)}</li>`).join("");
    out.push(`<${tag}>${items}</${tag}>`);
    list = null;
  };
  const flushTable = () => {
    if (!table) return;
    const thead = table.header.map((c) => `<th>${inline(c)}</th>`).join("");
    const rows = table.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
    out.push(`<table><thead><tr>${thead}</tr></thead><tbody>${rows}</tbody></table>`);
    table = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 代码块哨兵
    const codeMatch = trimmed.match(/^\u0000CODE(\d+)\u0000$/);
    if (codeMatch) {
      flushPara(); flushList(); flushTable();
      out.push(`<pre class="md-code"><code>${esc(codeBlocks[Number(codeMatch[1])])}</code></pre>`);
      continue;
    }

    // 空行
    if (!trimmed) { flushPara(); flushList(); flushTable(); continue; }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushPara(); flushList(); flushTable(); out.push("<hr>"); continue; }

    // 标题
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara(); flushList(); flushTable();
      const n = h[1].length;
      out.push(`<h${n}>${inline(h[2])}</h${n}>`);
      continue;
    }

    // 引用（连续 > 行）
    if (/^>\s?/.test(trimmed)) {
      flushPara(); flushList(); flushTable();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quote.push(inline(lines[i].trim().replace(/^>\s?/, "")));
        i++;
      }
      i--;
      out.push(`<blockquote>${quote.join("<br>")}</blockquote>`);
      continue;
    }

    // 表格（含分隔行 |---|）
    if (trimmed.startsWith("|") && trimmed.endsWith("|") && i + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim())) {
      flushPara(); flushList();
      const header = trimmed.slice(1, -1).split("|").map((c) => c.trim());
      const alignRow = lines[i + 1].trim().slice(1, -1).split("|");
      // 只解析表头对齐（简化），行内容保持结构
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
        rows.push(lines[i].trim().slice(1, -1).split("|").map((c) => c.trim()));
        i++;
      }
      i--;
      table = { header, rows };
      flushTable();
      continue;
    }

    // 有序列表
    const ol = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (ol) {
      flushPara();
      if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] }; }
      list.items.push({ text: ol[2] });
      continue;
    }
    // 无序列表 - / * / +
    const ul = trimmed.match(/^[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] }; }
      list.items.push({ text: ul[1] });
      continue;
    }

    // 其他 → 段落累积（多行用 <br> 连接）
    flushList();
    para.push(trimmed);
  }
  flushPara(); flushList(); flushTable();

  return out.join("\n");
}


/** 工作区文件预览页面骨架（自包含，无外部依赖）。 */
function previewPageHtml(name, rel, size, downloadHref, body, inlineHref = "") {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>预览 - ${escapeHtml(name)}</title>
<style>
  * { box-sizing: border-box; }
  :root {
    --lp-bg:#0f1720; --lp-fg:#e5e7eb; --lp-bar-bg:#1a2530; --lp-border:#2c3a47;
    --lp-meta:#9ca3af; --lp-text-bg:#0b1219; --lp-hover:#2c3a47; --lp-btn2-fg:#e5e7eb;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --lp-bg:#ffffff; --lp-fg:#1f2937; --lp-bar-bg:#f3f4f6; --lp-border:#e5e7eb;
      --lp-meta:#6b7280; --lp-text-bg:#f9fafb; --lp-hover:#e5e7eb; --lp-btn2-fg:#374151;
    }
  }
  body { margin:0; font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; background:var(--lp-bg); color:var(--lp-fg); }
  html, body { height:100%; }
  .bar { position:sticky; top:0; display:flex; align-items:center; gap:12px; padding:10px 16px; background:var(--lp-bar-bg); border-bottom:1px solid var(--lp-border); }
  .bar .name { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .bar .meta { color:var(--lp-meta); font-size:12px; }
  .bar .spacer { flex:1; }
  .btn, .btn2 { display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 14px; border-radius:8px; font-size:13px; line-height:1; }
  .btn { background:#2563eb; color:#fff; text-decoration:none; }
  .btn:hover { background:#1d4ed8; }
  .btn2 { background:transparent; color:var(--lp-btn2-fg); border:1px solid var(--lp-border); cursor:pointer; }
  .btn2:hover { background:var(--lp-hover); }
  .btn .ic, .btn2 .ic { width:14px; height:14px; }
  .hint { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#7c2d12; color:#fdba74; border-radius:8px; padding:10px 18px; font-size:13px; display:none; z-index:9; }
  .content { padding:20px; max-width:960px; margin:0 auto; }
  .text { background:var(--lp-text-bg); border:1px solid var(--lp-border); border-radius:10px; padding:16px; overflow:auto; font-size:13px; line-height:1.7; white-space:pre-wrap; word-break:break-word; }
  .md { line-height:1.8; font-size:14px; word-break:break-word; }
  .md h1,.md h2,.md h3,.md h4,.md h5,.md h6 { line-height:1.45; margin:1.7em 0 .8em; }
  .md h1 { font-size:1.5em; }
  .md h2 { font-size:1.3em; }
  .md h3 { font-size:1.15em; }
  .md h1:first-child,.md h2:first-child,.md h3:first-child { margin-top:.6em; }
  .md p { margin:1em 0; }
  .md a { color:#60a5fa; text-decoration:none; }
  .md a:hover { text-decoration:underline; }
  .md code { background:var(--lp-text-bg); border:1px solid var(--lp-border); border-radius:4px; padding:1px 5px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.9em; }
  .md pre.md-code { background:var(--lp-text-bg); border:1px solid var(--lp-border); border-radius:8px; padding:12px; overflow:auto; }
  .md pre.md-code code { background:none; border:none; padding:0; font-size:12px; line-height:1.6; }
  .md blockquote { margin:.8em 0; padding:.2em 1em; border-left:3px solid var(--lp-border); color:var(--lp-meta); }
  .md ul,.md ol { margin:.6em 0; padding-left:1.6em; }
  .md li { margin:.2em 0; }
  .md table { border-collapse:collapse; margin:.8em 0; max-width:100%; display:block; overflow:auto; }
  .md th,.md td { border:1px solid var(--lp-border); padding:6px 10px; font-size:13px; }
  .md th { background:var(--lp-bar-bg); font-weight:600; }
  .md img { max-width:100%; border-radius:8px; }
  .md hr { border:none; border-top:1px solid var(--lp-border); margin:1.5em 0; }
  .md del { color:var(--lp-meta); }
  body.maximized .md { max-width:none; }
  .image { max-width:100%; border-radius:8px; }
  .pdf { display:block; width:100%; height:86vh; border:1px solid var(--lp-border); border-radius:8px; background:#fff; }
  .office { background:#fff; color:#111; border-radius:8px; padding:16px; overflow:auto; }
  .unsupported { color:#f59e0b; text-align:center; padding:40px 0; }
  /* 放大模式：顶栏常驻（固定悬浮），内容占满视口、PDF 全高 */
  body.maximized .bar { position:fixed; top:0; left:0; right:0; z-index:20; }
  body.maximized .content { max-width:none; padding:0; margin:0; height:100vh; padding-top:53px; }
  body.maximized .md { padding:24px 32px 48px; max-width:820px; margin:0 auto; }
  body.maximized .pdf { height:calc(100vh - 53px); border:none; border-radius:0; }
  body.maximized .text { height:calc(100vh - 53px); border:none; border-radius:0; overflow:auto; }
  body.maximized .office { height:calc(100vh - 53px); overflow:auto; }
  body.maximized .image { max-width:100vw; max-height:100vh; object-fit:contain; }
  @media (max-width: 767px) {
    .bar { flex-wrap:wrap; gap:8px; padding:8px 10px; }
    .bar .name { font-size:13px; }
    .btn, .btn2 { padding:4px 12px; font-size:12px; border-radius:7px; }
  }
</style>
</head>
<body>
<div class="bar">
  <span class="name">${escapeHtml(name)}</span>
  <span class="meta">${escapeHtml(rel)} · ${(size / 1024).toFixed(1)} KB</span>
  <span class="spacer"></span>
  ${inlineHref ? `<a class="btn" href="${escapeHtml(inlineHref)}" target="_blank" rel="noopener noreferrer">${ICON_EYE} 打开</a>` : ""}
  <a class="btn" href="${escapeHtml(downloadHref)}" download>${ICON_DL} 下载</a>
  <button class="btn2" type="button" id="maxBtn" onclick="toggleMax()">${ICON_FOLDER} 放大</button>
  <button class="btn2" type="button" onclick="closePreview()">${ICON_X} 关闭</button>
</div>
<div class="content">${body}</div>
<div class="hint" id="closeHint">浏览器不允许脚本直接关闭此标签页，请手动关闭本标签页（或按 Ctrl+W / ⌘+W）。</div>
<script>
function toggleMax() {
  var max = document.body.classList.toggle('maximized');
  document.getElementById('maxBtn').textContent = max ? '还原' : '放大';
}
function closePreview() {
  // 从文件列表页进入（URL 带 from=list）→ 返回列表页，只关掉当前文件
  var fromList = /[?&]from=list(&|$)/.test(location.search);
  try {
    if (window.self !== window.top && window.parent) {
      // 在 iframe（会话内联预览）里：
      // 从列表页进入 → 返回列表；直接打开 → 通知父窗口关闭整个面板
      if (fromList) { if (window.history.length > 1) { window.history.back(); return; } }
      window.parent.postMessage({ type: 'dsh-close-preview' }, location.origin);
      return;
    }
  } catch (e) { /* 跨域忽略 */ }
  if (fromList && window.history.length > 1) { window.history.back(); return; }
  window.close();
  setTimeout(function () { document.getElementById('closeHint').style.display = 'block'; }, 300);
}
</script>
</body>
</html>`;
}

/**
 * Mount every route once the profile composes the webServer and credentials
 * services.
 * @param ctx - host plugin context.
 * @param config - optional profile override (trustedHosts, skillsRoot).
 */
export async function apply(ctx, config = {}) {
  const trustedHosts = Array.isArray(config.trustedHosts) ? [...config.trustedHosts] : [];
  const skillsRoot = resolve(config.skillsRoot ?? DEFAULT_SKILLS_ROOT);
  const onError = (error) => ctx.logger.error(error instanceof Error ? error : new Error(String(error)));

  const handlers = createHandlers({ trustedHosts, onError });

  // ---- md2docx 工具: Markdown → Word (.docx, 带页码) ----
  // 调用 md2docx.py (pandoc-free, python-docx + 页脚 PAGE 字段)。
  // 默认脚本随插件包分发（lib/md2docx.py），换机器也可靠；可用 config.md2docxScript 覆盖。
  const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
  const MD2DOCX_SCRIPT = resolve(config.md2docxScript ?? join(PACKAGE_DIR, "md2docx.py"));
  const runScript = (script, args) => new Promise((resolvePromise) => {
    const child = spawn("python3", [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (error) => resolvePromise({ ok: false, error: String(error), stdout, stderr }));
    child.on("close", (code) => resolvePromise({ ok: code === 0, code, stdout, stderr }));
  });
  ctx.tools.register(defineTool({
    name: "md2docx",
    description: "Convert a Markdown file to a styled Word (.docx) document with a page-number footer. Ships a bundled python-docx script (lib/md2docx.py) that renders headings, tables, bold/italic, and lists; the docx includes a footer '第 N 页' field that updates when opened in Word or exported to PDF. Requires python3 and python-docx installed on the host. Override the script path via config.md2docxScript if needed.",
    parameters: {
      input: {
        type: "string",
        required: true,
        description: "Absolute path to the input .md file."
      },
      output: {
        type: "string",
        description: "Optional absolute path for the output .docx. Defaults to the input path with a .docx extension."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          docxPath: { type: "string" },
          error: { type: "string" }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value && value.ok === true
          ? `已生成 Word 文档：${value.docxPath}\n（含页码页脚，Word/另存 PDF 时自动更新）`
          : `md2docx 失败：${value?.error ?? "未知错误"}`
      }]
    },
    // 声明交付物：DSH 从 presentCall 的 locations 识别本工具产出的文件，
    // 从而把 docx 渲染成可点击的交付物卡片（消息里的文件引用也能打开）。
    presentCall: (args) => {
      const inPath = resolve(String(args.input ?? ""));
      const outPath = args.output ? resolve(String(args.output)) : inPath.replace(/\.md$/i, ".docx");
      return {
        card: "generic",
        title: "md2docx",
        kind: "edit",
        locations: [{ path: outPath }]
      };
    },
    async execute(args) {
      const inPath = resolve(String(args.input ?? ""));
      const outPath = args.output ? resolve(String(args.output)) : inPath.replace(/\.md$/i, ".docx");
      const result = await runScript(MD2DOCX_SCRIPT, [inPath, outPath]);
      if (!result.ok) {
        return { ok: false, error: (result.stderr || result.stdout || String(result.error)).trim() || `md2docx failed (exit ${result.code})` };
      }
      return { ok: true, docxPath: outPath };
    }
  }));

  await sweepUploadTemps(handlers.root);

  const requireTrusted = (req) => {
    if (!isTrustedUploadRequest(req, trustedHosts)) throw new HttpError(403, "forbidden");
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: API_PATH,
    handler: handlers.api,
  }), "dsh-long-plugins: upload/list/delete route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: DOWNLOAD_PATH,
    handler: handlers.download,
  }), "dsh-long-plugins: download route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: PREVIEW_PATH,
    handler: handlers.preview,
  }), "dsh-long-plugins: preview route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-uploads/workspace",
    handler: handlers.workspaceList,
  }), "dsh-long-plugins: workspace list route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-uploads/workspace-file",
    handler: handlers.workspaceFile,
  }), "dsh-long-plugins: workspace file route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-uploads/workspace-preview",
    handler: handlers.workspacePreview,
  }), "dsh-long-plugins: workspace preview route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-uploads/docx-preview",
    handler: handlers.docxPreviewPage,
  }), "dsh-long-plugins: docx real-preview route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-uploads/docx-preview-asset",
    handler: handlers.docxPreviewAsset,
  }), "dsh-long-plugins: docx-preview vendor assets");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-uploads/pptx-preview",
    handler: handlers.pptxPreviewPage,
  }), "dsh-long-plugins: pptx real-preview route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-uploads/workspace-browse",
    handler: handlers.workspaceBrowse,
  }), "dsh-long-plugins: workspace browse route");

  // 聊天 markdown 内联用的 SVG 图标文件（eye/download）
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/api/dsh-uploads/icons",
    handler: (req, res) => {
      try {
        requireTrusted(req);
        const name = new URL(req.url || "/", "http://dsh.internal").pathname.split("/").pop() || "";
        const svg = ICON_FILES[name];
        if (svg === undefined) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("not found");
          return;
        }
        res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" });
        res.end(svg);
      } catch (error) {
        sendError(res, error, onError);
      }
    },
  }), "dsh-long-plugins: chat icon files route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-uploads/workspace-file/delete",
    handler: handlers.workspaceDelete,
  }), "dsh-long-plugins: workspace delete route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-uploads/workspace-file/save",
    handler: handlers.workspaceSave,
  }), "dsh-long-plugins: workspace save route");

  // ---- 技能文档 (skill docs) routes ----
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/dsh-skill-docs/skill-docs",
    handler: async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        methodNotAllowed(res, ["GET", "HEAD"]);
        return;
      }
      try {
        requireTrusted(req);
        const groups = await collectGroups(skillsRoot, "__dsh_none__");
        sendJson(res, 200, { ok: true, root: skillsRoot, groups });
      } catch (error) {
        sendError(res, error, onError);
      }
    },
  }), "dsh-long-plugins: skill-docs list route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/dsh-skill-docs/skill-doc",
    handler: async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        methodNotAllowed(res, ["GET", "HEAD"]);
        return;
      }
      let rel;
      try {
        rel = decodeURIComponent(new URL(req.url || "/", "http://dsh.internal").searchParams.get("path") || "");
      } catch {
        rel = "";
      }
      try {
        requireTrusted(req);
        const full = safeResolve(skillsRoot, rel);
        if (full === undefined) throw new HttpError(400, "bad path");
        const info = await stat(full);
        if (!info.isFile()) throw new HttpError(400, "not a file");
        const download = new URL(req.url || "/", "http://dsh.internal").searchParams.get("download") === "1";
        const name = rel.split("/").pop() || "file";
        if (download) {
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-disposition": contentDisposition(name),
            "content-length": String(info.size),
            "cache-control": "no-store",
          });
          const stream = createReadStream(full);
          stream.on("error", (error) => res.destroy(error));
          stream.pipe(res);
          return;
        }
        const buffer = await readFile(full);
        const binary = buffer.subarray(0, 8192).includes(0);
        const truncated = buffer.length > PREVIEW_LIMIT;
        sendJson(res, 200, {
          ok: true,
          path: rel,
          name,
          size: info.size,
          mtime: info.mtimeMs,
          binary,
          truncated,
          contentType: contentType(name),
          content: binary || truncated ? undefined : buffer.subarray(0, PREVIEW_LIMIT).toString("utf8"),
        });
      } catch (error) {
        const code = error && typeof error === "object" && error.code;
        sendError(res, error, onError);
      }
    },
  }), "dsh-long-plugins: skill-doc route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/dsh-skill-docs/skill-doc/save",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        methodNotAllowed(res, ["POST"]);
        return;
      }
      try {
        requireTrusted(req);
        const body = await readJsonBody(req);
        const rel = typeof body === "object" && body !== null ? body.path : undefined;
        const content = typeof body === "object" && body !== null ? body.content : undefined;
        if (typeof content !== "string") throw new HttpError(400, "content required");
        const full = safeResolve(skillsRoot, rel);
        if (full === undefined) throw new HttpError(400, "bad path");
        const info = await stat(full);
        if (!info.isFile()) throw new HttpError(400, "not a file");
        await writeFile(full, content, "utf8");
        sendJson(res, 200, { ok: true, path: rel });
      } catch (error) {
        sendError(res, error, onError);
      }
    },
  }), "dsh-long-plugins: skill-doc save route");

  // ---- 余额 (account balance) route ----
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/dsh-token-usage/balance",
    handler: async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        methodNotAllowed(res, ["GET", "HEAD"]);
        return;
      }
      try {
        requireTrusted(req);
        const resolved = await ctx.credentials.resolve("DEEPSEEK_API_KEY");
        if (resolved === undefined) {
          sendJson(res, 503, { ok: false, error: "no-api-key" });
          return;
        }
        const upstream = await fetch(BALANCE_URL, {
          headers: {
            Authorization: `Bearer ${resolved.value}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(10000),
        });
        const text = await upstream.text();
        res.writeHead(upstream.status, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(text);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error instanceof Error ? error.message : error) });
      }
    },
  }), "dsh-long-plugins: balance route");

  // ---- 本会话消费 (session spend) route ----
  // Reads the live session's event log and prices every assistant/message
  // usage sample against DeepSeek V4-Flash official pricing (effective
  // 2026-08-17, peak/off-peak split). Peak hours are Beijing time
  // 09:00-12:00 and 14:00-18:00; off-peak is everything else.
  const SESSION_PRICE_PEAK = { input: 3, cache: 0.1, output: 9 };      // ¥ per 1M tokens
  const SESSION_PRICE_OFFPEAK = { input: 1.5, cache: 0.05, output: 4.5 };
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/dsh-token-usage/session-cost",
    handler: async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        methodNotAllowed(res, ["GET", "HEAD"]);
        return;
      }
      try {
        requireTrusted(req);
        const url = new URL(req.url ?? "", "http://localhost");
        const sessionId = url.searchParams.get("session");
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          sendJson(res, 400, { ok: false, error: "session required" });
          return;
        }
        const session = ctx.sessions?.get(sessionId);
        let events;
        if (session !== undefined) {
          events = session.events;
        } else if (ctx.sessionPersistence !== undefined) {
          // Cold (historical) session: restore through the durable persistence
          // backend. inspect() prefers the live store and falls back to disk.
          const inspected = await ctx.sessionPersistence.inspect(sessionId);
          events = inspected && Array.isArray(inspected.events) ? inspected.events : undefined;
        }
        if (events === undefined) {
          sendJson(res, 404, { ok: false, error: "session not found" });
          return;
        }
        let input = 0, output = 0, cacheRead = 0;
        let peakCny = 0, offPeakCny = 0;
        for (const ev of events) {
          if (ev.type !== "assistant/message") continue;
          const usage = ev.data && ev.data.usage;
          if (usage == null || typeof usage !== "object") continue;
          const inT = Number(usage.inputTokens) || 0;
          const outT = Number(usage.outputTokens) || 0;
          const cR = Number(usage.cacheReadTokens) || 0;
          if (inT + outT + cR <= 0) continue;
          input += inT; output += outT; cacheRead += cR;
          // Beijing-time peak check (server local time is CST on this host,
          // but compute against UTC+8 explicitly to be safe).
          const d = new Date(ev.time);
          const bjHour = (d.getUTCHours() + 8) % 24;
          const isPeak = (bjHour >= 9 && bjHour < 12) || (bjHour >= 14 && bjHour < 18);
          const price = isPeak ? SESSION_PRICE_PEAK : SESSION_PRICE_OFFPEAK;
          const cny = (inT * price.input + cR * price.cache + outT * price.output) / 1e6;
          if (isPeak) peakCny += cny; else offPeakCny += cny;
        }
        sendJson(res, 200, {
          ok: true,
          sessionId,
          tokens: { input, output, cacheRead },
          cny: { peak: Number(peakCny.toFixed(4)), offPeak: Number(offPeakCny.toFixed(4)), total: Number((peakCny + offPeakCny).toFixed(4)) },
        });
      } catch (error) {
        sendError(res, error, onError);
      }
    },
  }), "dsh-long-plugins: session-cost route");
}
