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
import { randomUUID } from "node:crypto";

export const name = "dsh-long-plugins";

/** Server services required: the web route carrier and the credential seam. */
export const inject = ["webServer", "credentials"];

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
      const name = rel.split("/").pop() || "file";
      if (download) {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${name.replace(/["\\]/g, "_")}"`,
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
        contentType: contentType(extname(name)),
        content: binary || truncated ? undefined : buffer.subarray(0, PREVIEW_LIMIT).toString("utf8"),
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

  return { root, maxFileBytes, totalMaxBytes, api, download, preview, workspaceList, workspaceFile, workspaceDelete, workspaceSave };
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
            "content-disposition": `attachment; filename="${name.replace(/["\\]/g, "_")}"`,
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
}
