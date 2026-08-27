const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const dns = require("dns/promises");
const net = require("net");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const root = __dirname;

function loadDotEnv(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    content.split(/\r?\n/u).forEach(line => {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/u);
      if (!match || process.env[match[1]]) return;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/gu, "");
    });
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`读取 .env 失败：${error.message}`);
  }
}

loadDotEnv(path.join(root, ".env"));
const importDirectory = path.join(root, "imports");
const extractor = path.join(root, "tools", "lesson-text-extract");
const extractorSource = path.join(root, "tools", "lesson-text-extract.swift");
let extractorBuild = null;
const port = Number(process.env.PORT || 8010);
const host = process.env.HOST || "127.0.0.1";
const allowLanImageApi = process.env.ALLOW_LAN_IMAGE_API === "1";
const maxUploadBytes = 20 * 1024 * 1024;
const imageApiKey = process.env.IMAGE_API_KEY || process.env.ARK_API_KEY || "";
const imageApiBaseUrl = (process.env.IMAGE_API_BASE_URL || process.env.ARK_BASE_URL || "https://ark.ap-southeast.bytepluses.com/api/v3").replace(/\/$/u, "");
const imageModel = process.env.IMAGE_MODEL || process.env.ARK_MODEL || "";
const imageApiTimeoutMs = Number(process.env.IMAGE_API_TIMEOUT_MS || 180000);
const imageSearchApiUrl = (process.env.IMAGE_SEARCH_API_URL || "https://api.openverse.org/v1/images/").replace(/\/$/u, "");
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8"
};
const textExtensions = new Set([".txt", ".md"]);
const wordExtensions = new Set([".doc", ".docx", ".odt", ".rtf"]);
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".heic", ".heif"]);
const acceptedExtensions = new Set([".pdf", ...textExtensions, ...wordExtensions, ...imageExtensions]);
const publicFiles = new Set([
  "index.html", "workspace.html", "styles.css", "workspace.css", "app.js", "workspace.js",
  "course-store.js", "manifest.webmanifest", "sw.js", "assets/app/icon-512.png"
]);

function isLoopbackAddress(address = "") {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") ||
      /^fe[89ab]/u.test(value) || value.startsWith("ff") || value.startsWith("::ffff:127.");
  }
  return true;
}

async function assertPublicHttpsUrl(url) {
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("只允许公开的 HTTPS 图片地址。");
  if (url.hostname === "localhost" || url.hostname.endsWith(".local")) throw new Error("不允许访问本机或局域网地址。");
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new Error("不允许访问本机或局域网地址。");
}

async function downloadPublicImage(initialUrl, signal, redirects = 0) {
  if (redirects > 4) throw new Error("图片地址重定向次数过多。");
  await assertPublicHttpsUrl(initialUrl);
  const upstream = await fetch(initialUrl, { signal, redirect: "manual", headers: { "User-Agent": "ClassicalTextMemory/1.0" } });
  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get("location");
    if (!location) throw new Error("图片地址重定向无效。");
    return downloadPublicImage(new URL(location, initialUrl), signal, redirects + 1);
  }
  if (!upstream.ok) throw new Error(`图片下载返回 HTTP ${upstream.status}。`);
  const contentType = String(upstream.headers.get("content-type") || "").split(";")[0];
  if (!contentType.startsWith("image/")) throw new Error("远程地址不是图片文件。");
  const declaredSize = Number(upstream.headers.get("content-length") || 0);
  if (declaredSize > 8 * 1024 * 1024) throw new Error("图片超过 8 MB，本地课程库暂不保存。");
  const chunks = [];
  let size = 0;
  for await (const chunk of upstream.body) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error("图片超过 8 MB，本地课程库暂不保存。");
    chunks.push(chunk);
  }
  return { contentType, buffer: Buffer.concat(chunks) };
}

function safeFileName(name) {
  const base = path.basename(name || "导入文件").replace(/[^\w.\-\u4e00-\u9fff]/g, "_");
  return base || "导入文件";
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxUploadBytes) throw new Error("文件超过 20 MB 的本地导入上限。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function ensureExtractor() {
  try {
    await fsp.access(extractor, fs.constants.X_OK);
    return;
  } catch {}
  if (!extractorBuild) {
    extractorBuild = execFileAsync("/usr/bin/xcrun", ["swiftc", extractorSource, "-o", extractor], { maxBuffer: 12 * 1024 * 1024 })
      .catch(error => { extractorBuild = null; throw new Error(`无法编译本地文字提取工具：${error.message}`); });
  }
  await extractorBuild;
}

async function extractText(filePath, extension) {
  if (textExtensions.has(extension)) return fsp.readFile(filePath, "utf8");
  if (wordExtensions.has(extension)) {
    const { stdout } = await execFileAsync("/usr/bin/textutil", ["-convert", "txt", "-stdout", filePath], { maxBuffer: 12 * 1024 * 1024 });
    return stdout;
  }
  if (extension === ".pdf" || imageExtensions.has(extension)) {
    await ensureExtractor();
    const { stdout } = await execFileAsync(extractor, [filePath], { maxBuffer: 12 * 1024 * 1024 });
    return stdout;
  }
  throw new Error("暂不支持这个文件格式。");
}

async function generateImage(request, response) {
  if (!isLoopbackAddress(request.socket.remoteAddress) && !allowLanImageApi) {
    sendJson(response, 403, { error: "局域网设备默认不能调用付费图片生成接口；如确认网络可信，请在本地显式设置 ALLOW_LAN_IMAGE_API=1。" });
    return;
  }
  if (!imageApiKey) {
    sendJson(response, 503, { error: "未配置图片生成密钥。请在项目 .env 中设置 IMAGE_API_KEY 和 IMAGE_MODEL。" });
    return;
  }
  if (!imageModel) {
    sendJson(response, 503, { error: "未配置图片模型。请在项目 .env 中设置 IMAGE_MODEL。" });
    return;
  }
  const rawBody = await readRequestBody(request);
  const body = JSON.parse(rawBody.toString("utf8"));
  const prompt = String(body.prompt || "").trim();
  if (!prompt || prompt.length > 6000) {
    sendJson(response, 400, { error: "图卡提示词不能为空，且不能超过 6000 个字符。" });
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), imageApiTimeoutMs);
  try {
    const upstream = await fetch(`${imageApiBaseUrl}/images/generations`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Authorization": `Bearer ${imageApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: imageModel,
        prompt,
        size: body.size || "1K",
        output_format: "png",
        response_format: "b64_json",
        watermark: false
      })
    });
    const text = await upstream.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { error: { message: text.slice(0, 500) } }; }
    if (!upstream.ok) {
      const detail = payload.error?.message || payload.message || `图片服务返回 HTTP ${upstream.status}`;
      sendJson(response, 502, { error: `图片生成失败：${detail}` });
      return;
    }
    const image = (payload.data || []).find(item => item.b64_json || item.url);
    if (!image) {
      sendJson(response, 502, { error: "图片服务没有返回图像结果。" });
      return;
    }
    if (image.b64_json) {
      sendJson(response, 200, { dataUrl: `data:image/${image.output_format || "png"};base64,${image.b64_json}`, model: payload.model || imageModel });
      return;
    }
    const imageResponse = await fetch(image.url, { signal: controller.signal });
    if (!imageResponse.ok) throw new Error(`无法下载图片结果（HTTP ${imageResponse.status}）。`);
    const buffer = Buffer.from(await imageResponse.arrayBuffer());
    const contentType = imageResponse.headers.get("content-type") || "image/png";
    sendJson(response, 200, { dataUrl: `data:${contentType};base64,${buffer.toString("base64")}`, model: payload.model || imageModel });
  } catch (error) {
    const message = error.name === "AbortError" ? "图片生成超时，请稍后重试。" : error.message;
    sendJson(response, 502, { error: `图片生成失败：${message}` });
  } finally {
    clearTimeout(timeout);
  }
}

async function imageConfig(request, response) {
  const generationAllowed = isLoopbackAddress(request.socket.remoteAddress) || allowLanImageApi;
  sendJson(response, 200, {
    configured: Boolean(imageApiKey && imageModel && generationAllowed),
    provider: "BytePlus ModelArk",
    model: imageModel || null,
    endpoint: `${imageApiBaseUrl}/images/generations`,
    imageSearch: { provider: "Openverse", configured: true, endpoint: imageSearchApiUrl }
  });
}

async function searchImages(request, response) {
  const rawBody = await readRequestBody(request);
  const body = JSON.parse(rawBody.toString("utf8"));
  const query = String(body.query || "").trim();
  if (!query || query.length > 240) {
    sendJson(response, 400, { error: "图片检索关键词不能为空，且不能超过 240 个字符。" });
    return;
  }
  const url = new URL(imageSearchApiUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("page_size", "6");
  url.searchParams.set("license_type", "all");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const { stdout } = await execFileAsync("/usr/bin/curl", ["-fsSL", "--max-time", "20", "-A", "ClassicalTextMemory/1.0", url.toString()], { maxBuffer: 12 * 1024 * 1024 });
    const payload = JSON.parse(stdout);
    if (payload.detail) throw new Error(payload.detail);
    const results = (payload.results || []).filter(item => item.url || item.thumbnail).map(item => ({
      id: item.id,
      title: item.title || "未命名图片",
      thumbnail: item.thumbnail || item.url,
      url: item.url || item.thumbnail,
      creator: item.creator || "作者未注明",
      creatorUrl: item.creator_url || null,
      license: item.license || "许可信息未注明",
      licenseVersion: item.license_version || "",
      licenseUrl: item.license_url || null,
      source: item.source || item.provider || "Openverse",
      landingUrl: item.foreign_landing_url || item.detail_url || item.url
    }));
    sendJson(response, 200, { query, results });
  } catch (error) {
    const raw = String(error && error.message ? error.message : "");
    const message = error.name === "AbortError" || /timeout|超时/i.test(raw)
      ? "图片素材检索超时，请稍后重试。"
      : /SSL|curl|ECONN|ENOTFOUND|ENETUNREACH|Command failed/i.test(raw)
        ? "开放素材暂时连不上，请稍后重试，或直接上传本地图卡。"
        : "图片素材检索失败，请稍后重试，或直接上传本地图卡。";
    sendJson(response, 502, { error: message });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRemoteImage(request, response) {
  const rawBody = await readRequestBody(request);
  const body = JSON.parse(rawBody.toString("utf8"));
  let remoteUrl;
  try { remoteUrl = new URL(String(body.url || "")); } catch { sendJson(response, 400, { error: "图片地址无效。" }); return; }
  if (remoteUrl.protocol !== "https:") {
    sendJson(response, 400, { error: "只允许下载 HTTPS 图片地址。" });
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const { contentType, buffer } = await downloadPublicImage(remoteUrl, controller.signal);
    sendJson(response, 200, { dataUrl: `data:${contentType};base64,${buffer.toString("base64")}` });
  } catch (error) {
    const message = error.name === "AbortError" ? "图片下载超时。" : error.message;
    sendJson(response, 502, { error: `图片下载失败：${message}` });
  } finally {
    clearTimeout(timeout);
  }
}

async function importFile(request, response) {
  const rawBody = await readRequestBody(request);
  const body = JSON.parse(rawBody.toString("utf8"));
  const name = safeFileName(body.name);
  const extension = path.extname(name).toLowerCase();
  if (!acceptedExtensions.has(extension)) {
    sendJson(response, 415, { error: "支持 PDF、Word、图片、TXT 与 Markdown 文件。" });
    return;
  }
  if (typeof body.content !== "string" || !body.content.includes(",")) {
    sendJson(response, 400, { error: "没有读取到文件内容。" });
    return;
  }
  const content = Buffer.from(body.content.slice(body.content.indexOf(",") + 1), "base64");
  if (content.length > maxUploadBytes) {
    sendJson(response, 413, { error: "文件超过 20 MB 的本地导入上限。" });
    return;
  }
  await fsp.mkdir(importDirectory, { recursive: true });
  const storedName = `${Date.now()}-${name}`;
  const filePath = path.join(importDirectory, storedName);
  await fsp.writeFile(filePath, content);
  try {
    const text = (await extractText(filePath, extension)).replace(/\r\n/g, "\n").trim();
    if (!text) throw new Error("没有从文件中识别出可用文字，请确认图片或 PDF 清晰且包含正文。");
    sendJson(response, 200, {
      name,
      kind: imageExtensions.has(extension) ? "image" : extension === ".pdf" ? "pdf" : wordExtensions.has(extension) ? "word" : "text",
      text,
      sourceUrl: `imports/${encodeURIComponent(storedName)}`
    });
  } catch (error) {
    sendJson(response, 422, { error: `文件已保留在 imports 目录，但文字提取失败：${error.message}` });
  }
}

async function serveStatic(request, response) {
  const requestPath = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
  const relativePath = requestPath === "/" ? "workspace.html" : requestPath.replace(/^\/+/, "");
  if (!publicFiles.has(relativePath)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
    response.end("Not found");
    return;
  }
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${root}${path.sep}`) && target !== root) {
    response.writeHead(403); response.end("Forbidden"); return;
  }
  try {
    const stat = await fsp.stat(target);
    if (!stat.isFile()) { response.writeHead(404); response.end("Not found"); return; }
    response.writeHead(200, { "Content-Type": mimeTypes[path.extname(target).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(target).pipe(response);
  } catch {
    response.writeHead(404); response.end("Not found");
  }
}

async function handler(request, response) {
  try {
    if (request.method === "POST" && request.url === "/api/import") return importFile(request, response);
    if (request.method === "POST" && request.url === "/api/generate-image") return generateImage(request, response);
    if (request.method === "POST" && request.url === "/api/search-images") return searchImages(request, response);
    if (request.method === "POST" && request.url === "/api/fetch-image") return fetchRemoteImage(request, response);
    if (request.method === "GET" && request.url === "/api/image-config") return imageConfig(request, response);
    if (request.method === "GET" || request.method === "HEAD") return serveStatic(request, response);
    response.writeHead(405); response.end("Method not allowed");
  } catch (error) {
    sendJson(response, 500, { error: error.message || "本地导入服务发生错误。" });
  }
}

fsp.mkdir(importDirectory, { recursive: true }).then(() => {
  http.createServer(handler).listen(port, host, () => {
    console.log(`古诗文工作台：http://${host === "0.0.0.0" ? "localhost" : host}:${port}/workspace.html`);
    if (host === "0.0.0.0") console.log("已显式开启局域网访问；付费图片生成仍默认仅限本机。");
  });
});
