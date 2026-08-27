const MAX_SCENES = 12;
const IS_STATIC_DEMO = location.hostname.endsWith(".github.io") || new URLSearchParams(location.search).get("static-demo") === "1";
const VISUAL_WORDS = [
  ["日", "日光"], ["月", "月色"], ["山", "山势"], ["水", "水面"], ["云", "云雾"], ["雨", "雨势"],
  ["风", "风势"], ["花", "花朵"], ["木", "树木"], ["林", "树林"], ["鸟", "飞鸟"], ["舟", "舟船"],
  ["人", "人物"], ["门", "门楼"], ["城", "城郭"], ["草", "草木"], ["霜", "霜色"], ["雪", "积雪"]
];
const SEARCH_WORDS = [
  ["日", "sunrise sunlight"], ["月", "moonlight moon"], ["山", "mountain landscape"], ["水", "river water"],
  ["云", "cloud mist fog"], ["雨", "rain"], ["风", "wind trees"], ["花", "flowers blossom"], ["木", "tree"],
  ["林", "forest woods"], ["鸟", "bird"], ["舟", "boat"], ["人", "person"], ["门", "gate pavilion"],
  ["城", "ancient city"], ["草", "grass"], ["霜", "frost"], ["雪", "snow"]
];

let currentCourse = null;
let currentSource = null;
let currentScenes = [];
let pendingSource = null;
let activeView = "library";
let imageConfig = null;
let autoGenerationStartedForCourseId = null;
let pendingImagesOnly = false;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalize(text) {
  return String(text ?? "").replace(/\s+/g, "").trim();
}

function localTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = number => String(number).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function clauseCore(part) {
  return String(part || "").replace(/[。！？；，、]/gu, "");
}

function isSummaryTail(part) {
  const core = clauseCore(part);
  if (core.length > 10) return false;
  if (/也$/u.test(core)) return true;
  return /者$/u.test(core) && !core.includes("而");
}

function isSubstantialParallel(part) {
  const core = clauseCore(part);
  return core.length >= 5 && core.includes("而") && !isSummaryTail(part);
}

function splitSentence(sentence) {
  const clauses = sentence.split(/(?<=[，、；])/u).filter(Boolean);
  if (clauses.length <= 1) return [sentence];
  const parallelCount = clauses.filter(isSubstantialParallel).length;
  if (parallelCount < 2) return [sentence];
  const units = [];
  let buffer = "";
  clauses.forEach(part => {
    if (!buffer) {
      buffer = part;
      return;
    }
    if (isSummaryTail(part) || clauseCore(buffer).length <= 3) {
      buffer += part;
      return;
    }
    units.push(buffer);
    buffer = part;
  });
  if (buffer) units.push(buffer);
  return units.filter(Boolean);
}

function splitUnits(text) {
  const source = normalize(text);
  if (!source) return [];
  const sentences = source.split(/(?<=[。！？；])/u).filter(Boolean);
  const units = sentences.flatMap(splitSentence).filter(Boolean);
  if (units.length > 1) return units.slice(0, MAX_SCENES);
  const clauses = source.split(/(?<=[，、；])/u).filter(Boolean);
  return (clauses.length > 1 ? clauses : [source]).slice(0, MAX_SCENES);
}

function memoryChunks(original) {
  const chunks = original.replace(/[。！？]$/u, "").split(/(?<=[，、；])/u).filter(Boolean);
  return chunks.length > 1 ? chunks : [original.replace(/[。！？]$/u, "")];
}

function visualAnchors(original) {
  return [...new Set(VISUAL_WORDS.filter(([word]) => original.includes(word)).map(([, label]) => label))].slice(0, 4);
}

function explainScene(original, anchors) {
  if (anchors.length) {
    return `这一句写的是${anchors.join("、")}。用自己的话讲出原文意思，不要添原文没有的情节。`;
  }
  const cleaned = original.replace(/[。！？；，、]+$/u, "");
  return `用自己的话讲出「${cleaned}」的意思，只讲原文里有的人物、景物和动作。`;
}

function buildScenes(text) {
  return splitUnits(text).map((original, index) => {
    const anchors = visualAnchors(original);
    const subject = anchors.length ? anchors.join("、") : "本句写到的人物、景物与动作";
    return {
      id: CourseStore.id("scene"),
      order: index + 1,
      original,
      explanation: explainScene(original, anchors),
      visualAnchors: anchors,
      visualBrief: `画面必须清楚表现：${subject}。不加入原文没有的情节、文字或人物身份。`,
      memoryChunks: memoryChunks(original),
      imageAssetId: null,
      imageStatus: "待确认图卡"
    };
  });
}

function friendlyImageError(message) {
  const text = String(message || "");
  if (/timeout|超时|AbortError/i.test(text)) return "开放素材检索超时，请稍后重试，或上传本地图卡。";
  if (/SSL|curl|ECONN|ENOTFOUND|ENETUNREACH|Command failed|Failed to fetch|NetworkError|network/i.test(text)) {
    return "开放素材暂时连不上，请稍后重试，或直接上传本地图卡。";
  }
  return text.length > 72 ? "图卡处理失败，请稍后重试，或上传本地图卡。" : text;
}

function setMessage(id, message, error = false) {
  const target = document.querySelector(`#${id}`);
  if (!target) return;
  target.textContent = message;
  target.classList.toggle("is-error", error);
}

function showView(view) {
  activeView = view;
  document.querySelectorAll("[data-view-panel]").forEach(panel => {
    panel.hidden = panel.dataset.viewPanel !== view;
  });
  document.querySelectorAll("[data-view]").forEach(button => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
  if (view === "library") renderLibrary();
  if (view === "reports") renderReports();
}

function showBuildStep(step) {
  document.querySelectorAll("[data-build-panel]").forEach(panel => {
    panel.hidden = panel.dataset.buildPanel !== step;
  });
  document.querySelectorAll("[data-step]").forEach(item => {
    item.classList.toggle("is-active", item.dataset.step === step);
    item.classList.toggle("is-complete", ["source", "scenes", "images", "publish"].indexOf(item.dataset.step) < ["source", "scenes", "images", "publish"].indexOf(step));
  });
  if (step === "scenes") renderSceneEditor();
  if (step === "images") renderImageEditor();
  if (step === "publish") renderPublishChecklist();
}

function resetBuilder() {
  currentCourse = null;
  currentSource = null;
  currentScenes = [];
  pendingSource = null;
  imageConfig = null;
  autoGenerationStartedForCourseId = null;
  pendingImagesOnly = false;
  document.querySelector("#builder-title").textContent = "从教材到学习包";
  document.querySelector("#source-form").reset();
  setMessage("source-import-message", "");
  setMessage("source-status-message", "");
  showBuildStep("source");
}

async function seedStaticDemo() {
  if (!IS_STATIC_DEMO || (await CourseStore.list(CourseStore.stores.courses)).length) return;
  const fullText = "若夫日出而林霏开，云归而岩穴暝，晦明变化者，山间之朝暮也。野芳发而幽香，佳木秀而繁阴，风霜高洁，水落而石出者，山间之四时也。朝而往，暮而归，四时之景不同，而乐亦无穷也。";
  let course = await CourseStore.createCourse({ title: "醉翁亭记（在线示例）", author: "欧阳修", dynasty: "北宋", grade: "九年级", fullText });
  course = await CourseStore.saveCourse({ ...course, sourceStatus: "已校对" });
  await CourseStore.saveSource(course.id, { kind: "sample", extractedText: fullText, confirmedText: fullText, confirmedAt: new Date().toISOString() });
  await CourseStore.saveScenes(course.id, buildScenes(fullText));
  await CourseStore.publish(course.id);
}

async function renderLibrary() {
  const courses = (await CourseStore.list(CourseStore.stores.courses)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const published = courses.filter(course => course.status === "published").length;
  const due = await CourseStore.dueCourses();
  document.querySelector("#library-summary").innerHTML = `
    <div><span>课程总数</span><strong>${courses.length}</strong></div>
    <div><span>已发布</span><strong>${published}</strong></div>
    <div><span>今日待复习</span><strong>${due.length}</strong></div>`;
  const container = document.querySelector("#course-library");
  if (!courses.length) {
    container.innerHTML = `<div class="empty-state"><h3>先做第一份学习包</h3><p>导入教材、校对原文并拆分意群后即可发布到背诗练习，图卡可以之后再补。</p><button class="button button-primary" type="button" data-open-build>新建课程</button></div>`;
    bindBuildOpeners(container);
    return;
  }
  container.innerHTML = courses.map(course => `
    <article class="course-card">
      <div><p class="card-status ${course.status}">${course.status === "published" ? "已发布" : "待制作"}</p><h3>${escapeHtml(course.title)}</h3><p>${escapeHtml([course.dynasty, course.author].filter(Boolean).join(" · ") || "作者信息待补充")}</p></div>
      <p class="course-card-text">${escapeHtml(course.fullText.slice(0, 70))}${course.fullText.length > 70 ? "…" : ""}</p>
      <div class="card-footer"><span>更新于 ${localTime(course.updatedAt)}</span><div>
        <button class="icon-text" type="button" data-edit-course="${course.id}">编辑</button>
        ${course.status === "published" ? `<a class="button button-primary" href="index.html?course=${encodeURIComponent(course.id)}">开始背诗</a>` : ""}
      </div></div>
    </article>`).join("");
  container.querySelectorAll("[data-edit-course]").forEach(button => button.addEventListener("click", () => openCourse(button.dataset.editCourse)));
}

function bindBuildOpeners(root = document) {
  root.querySelectorAll("[data-open-build]").forEach(button => button.addEventListener("click", () => {
    resetBuilder();
    showView("build");
  }));
}

async function openCourse(courseId) {
  const bundle = await CourseStore.getBundle(courseId);
  if (!bundle) return;
  currentCourse = bundle.course;
  currentSource = bundle.sources[0] || null;
  currentScenes = bundle.scenes;
  pendingSource = currentSource;
  imageConfig = null;
  autoGenerationStartedForCourseId = null;
  pendingImagesOnly = false;
  document.querySelector("#builder-title").textContent = `编辑：${currentCourse.title}`;
  document.querySelector("#course-title").value = currentCourse.title;
  document.querySelector("#course-author").value = currentCourse.author;
  document.querySelector("#course-dynasty").value = currentCourse.dynasty;
  document.querySelector("#course-grade").value = currentCourse.grade;
  document.querySelector("#course-text").value = currentCourse.fullText;
  showView("build");
  showBuildStep(currentScenes.length ? "scenes" : "source");
}

function syncSceneFields() {
  document.querySelectorAll("[data-scene-field]").forEach(input => {
    const scene = currentScenes.find(item => item.id === input.dataset.sceneId);
    if (!scene) return;
    scene[input.dataset.sceneField] = input.value;
    if (input.dataset.sceneField === "original") {
      scene.memoryChunks = memoryChunks(input.value);
      scene.visualAnchors = visualAnchors(input.value);
    }
  });
}

async function persistScenes() {
  syncSceneFields();
  if (!currentCourse) return;
  await CourseStore.saveScenes(currentCourse.id, currentScenes);
}

function renderSceneEditor() {
  const editor = document.querySelector("#scene-editor");
  if (!currentScenes.length) {
    editor.innerHTML = `<p class="empty-state">请先完成原文校对。</p>`;
    return;
  }
  editor.innerHTML = currentScenes.map(scene => `
    <article class="scene-edit-card">
      <div class="scene-number">${String(scene.order).padStart(2, "0")}</div>
      <div class="scene-edit-body">
        <label>对应原文<textarea rows="3" data-scene-field="original" data-scene-id="${scene.id}">${escapeHtml(scene.original)}</textarea></label>
        <label>理解提示<textarea rows="2" data-scene-field="explanation" data-scene-id="${scene.id}">${escapeHtml(scene.explanation)}</textarea></label>
        <label>图像脚本<textarea rows="2" data-scene-field="visualBrief" data-scene-id="${scene.id}">${escapeHtml(scene.visualBrief)}</textarea></label>
        <p class="anchor-line"><strong>画面锚点</strong> ${scene.visualAnchors.map(anchor => `<span>${escapeHtml(anchor)}</span>`).join("") || "请补充具体对象或动作"}</p>
      </div>
    </article>`).join("");
}

async function getImageConfig() {
  if (imageConfig) return imageConfig;
  if (IS_STATIC_DEMO) {
    imageConfig = { configured: false, error: "在线体验版不连接图片生成服务；可上传本地图片或先使用文字学习。" };
    return imageConfig;
  }
  try {
    const response = await fetch("/api/image-config", { cache: "no-store" });
    imageConfig = response.ok ? await response.json() : { configured: false, error: "无法读取图片服务配置。" };
  } catch (error) {
    imageConfig = { configured: false, error: `无法连接图片服务：${error.message}` };
  }
  return imageConfig;
}

function imagePrompt(scene) {
  return `为中国古诗文学习制作一张无文字的记忆图卡，画幅 4:3，儿童可理解，清晰表现原文中的对象、动作和关系。原文：${scene.original}。画面脚本：${scene.visualBrief}。要求：古典山水彩绘与写实细节结合，主体明确、层次清楚、色彩自然；只表现原文证据，不添加原文没有的人物身份、情节或现代物品；画面内不要出现汉字、字幕、题字、边框、答案或教学 UI。`;
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  if (!response.ok) throw new Error("无法读取图卡文件。");
  return response.blob();
}

function imageSearchQuery(scene) {
  const terms = SEARCH_WORDS.filter(([word]) => scene.original.includes(word)).map(([, english]) => english);
  return [...new Set([...terms, "Chinese landscape"])] .join(" ").slice(0, 220);
}

async function searchSceneImages(scene, autoGenerate = true) {
  scene.imageSearchStatus = "搜索中";
  scene.imageSearchError = "";
  await persistScenes();
  await renderImageEditor({ auto: false });
  try {
    const response = await fetch("/api/search-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: imageSearchQuery(scene) })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "图片素材检索失败。");
    scene.imageCandidates = result.results || [];
    scene.imageSearchStatus = scene.imageCandidates.length ? "找到候选" : "未找到候选";
  } catch (error) {
    scene.imageCandidates = [];
    scene.imageSearchStatus = "搜索失败";
    scene.imageSearchError = friendlyImageError(error.message);
  }
  await persistScenes();
  await renderImageEditor({ auto: false });
  const config = await getImageConfig();
  if (autoGenerate && !scene.imageCandidates.length && config.configured && !scene.imageAssetId) {
    setMessage("image-generation-message", `第 ${scene.order} 句没有找到合适的开放素材，开始生成图卡……`);
    await generateSceneImage(scene);
  }
}

async function selectImageCandidate(scene, candidate) {
  scene.imageStatus = "正在保存素材";
  scene.imageError = "";
  await persistScenes();
  await renderImageEditor({ auto: false });
  try {
    const response = await fetch("/api/fetch-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: candidate.url })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "无法保存这张网络图片。");
    const blob = await dataUrlToBlob(result.dataUrl);
    const file = new File([blob], `开放素材-${scene.order}.png`, { type: blob.type || "image/jpeg" });
    const asset = await CourseStore.saveAsset(file);
    scene.imageAssetId = asset.id;
    scene.imageStatus = "图卡已确认";
    scene.imageSource = candidate;
    scene.imageError = "";
  } catch (error) {
    scene.imageStatus = "素材保存失败";
    scene.imageError = friendlyImageError(error.message);
  }
  await persistScenes();
  await renderImageEditor({ auto: false });
}

async function generateSceneImage(scene) {
  scene.imageStatus = "生成中";
  scene.imageError = "";
  await persistScenes();
  await renderImageEditor({ auto: false });
  try {
    const response = await fetch("/api/generate-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: imagePrompt(scene), size: "1K" })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "图片生成失败。");
    const blob = await dataUrlToBlob(result.dataUrl);
    const file = new File([blob], `古诗记忆图卡-${scene.order}.png`, { type: blob.type || "image/png" });
    const asset = await CourseStore.saveAsset(file);
    scene.imageAssetId = asset.id;
    scene.imageStatus = "已生成待确认";
    scene.generatedModel = result.model || null;
    scene.imageError = "";
  } catch (error) {
    scene.imageStatus = "生成失败";
    scene.imageError = friendlyImageError(error.message);
  }
  await persistScenes();
  await renderImageEditor({ auto: false });
}

async function discoverImagesFirst() {
  const courseId = currentCourse?.id;
  if (!courseId) return;
  if (IS_STATIC_DEMO) {
    setMessage("image-generation-message", "在线体验版不连接素材和生成服务；可以上传本地图卡，也可以暂不做图卡直接发布。 ");
    await renderImageEditor({ auto: false });
    return;
  }
  const config = await getImageConfig();
  const pending = currentScenes.filter(scene => !scene.imageAssetId && !["找到候选", "未找到候选", "搜索失败", "生成失败"].includes(scene.imageSearchStatus));
  for (const scene of pending) {
    if (currentCourse?.id !== courseId) return;
    setMessage("image-generation-message", `正在为第 ${scene.order} 句检索开放授权配图……`);
    await searchSceneImages(scene, config.configured);
  }
  const candidates = currentScenes.filter(scene => scene.imageCandidates?.length && !scene.imageAssetId).length;
  const failedSearch = currentScenes.filter(scene => scene.imageSearchStatus === "搜索失败").length;
  const failed = currentScenes.filter(scene => scene.imageStatus === "生成失败").length;
  if (candidates) setMessage("image-generation-message", `已找到 ${candidates} 句的开放素材候选，请逐张选择；不合适时再生成。`);
  else if (failed) setMessage("image-generation-message", `${failed} 张图卡生成失败，请重试或上传本地图卡。`, true);
  else if (failedSearch) setMessage("image-generation-message", `有 ${failedSearch} 句没能连上开放素材，可以稍后重试，或直接上传本地图卡。`, true);
  else if (config.configured) setMessage("image-generation-message", "开放素材检索和自动生成已完成，请逐张确认图卡。 ");
  else setMessage("image-generation-message", "没有找到合适的开放素材。没有生成服务时，可以上传本地图卡，也可以先发布。", true);
}

async function renderImageEditor({ auto = true } = {}) {
  await persistScenes();
  const editor = document.querySelector("#image-editor");
  if (!currentScenes.length) {
    editor.innerHTML = `<p class="empty-state">请先确认记忆意群。</p>`;
    return;
  }
  const config = await getImageConfig();
  const visibleScenes = pendingImagesOnly ? currentScenes.filter(scene => !scene.imageAssetId || scene.imageStatus !== "图卡已确认") : currentScenes;
  if (!visibleScenes.length) {
    editor.innerHTML = `<div class="empty-state"><h3>没有待完成图卡</h3><p>这份课程的图卡都已完成。你可以返回发布学习包。</p><button class="button button-secondary" type="button" data-back-publish>返回发布步骤</button></div>`;
    editor.querySelector("[data-back-publish]").addEventListener("click", () => { pendingImagesOnly = false; showBuildStep("publish"); });
    return;
  }
  if (pendingImagesOnly) setMessage("image-generation-message", `待完成图卡：${visibleScenes.length} 张。可以逐张补图，也可以直接生成。`);
  const cards = await Promise.all(visibleScenes.map(async scene => {
    const asset = scene.imageAssetId ? await CourseStore.get(CourseStore.stores.assets, scene.imageAssetId) : null;
    const imageUrl = asset ? URL.createObjectURL(asset.blob) : null;
    const canUpload = !scene.imageAssetId || scene.imageStatus === "生成失败";
    const preview = imageUrl
      ? `<button class="image-preview image-preview-button has-image" type="button" data-image-preview="${scene.id}" aria-label="查看第 ${scene.order} 句图卡全图"><img src="${imageUrl}" alt="第 ${scene.order} 句图卡预览"><span class="preview-zoom-hint">点击查看全图</span></button>`
      : `<div class="image-preview"><span>${scene.imageSearchStatus === "搜索中" ? "正在检索开放素材" : scene.imageStatus === "生成中" ? "正在生成图卡" : "尚未确认图卡"}</span></div>`;
    const candidates = (scene.imageCandidates || []).map((candidate, index) => `<figure class="source-candidate"><img src="${escapeHtml(candidate.thumbnail || candidate.url)}" alt="候选图片：${escapeHtml(candidate.title)}" loading="lazy"><figcaption><strong>${escapeHtml(candidate.title)}</strong><span>${escapeHtml(candidate.creator)} · ${escapeHtml(candidate.license)}${candidate.licenseVersion ? ` ${escapeHtml(candidate.licenseVersion)}` : ""}</span><small>${escapeHtml(candidate.source)}</small><button class="button button-primary" type="button" data-image-candidate="${scene.id}" data-candidate-index="${index}">选用这张</button></figcaption></figure>`).join("");
    const candidatePanel = candidates && !scene.imageAssetId ? `<div class="source-candidates"><p class="source-label">开放授权素材候选（请确认画面适合本句）</p><div class="source-candidate-grid">${candidates}</div><button class="button button-secondary" type="button" data-image-no-match="${scene.id}">没有合适，生成图卡</button></div>` : "";
    const confirmButton = scene.imageStatus === "已生成待确认" ? `<button class="button button-primary" type="button" data-image-confirm="${scene.id}">确认使用生成图卡</button>` : "";
    const searchButton = !IS_STATIC_DEMO && !scene.imageAssetId && scene.imageSearchStatus !== "搜索中" ? `<button class="button button-secondary" type="button" data-image-search="${scene.id}">${scene.imageSearchStatus === "搜索失败" ? "重新检索素材" : "重新检索素材"}</button>` : "";
    const directGenerate = config.configured && !scene.imageAssetId && scene.imageStatus !== "生成中" ? `<button class="button button-secondary" type="button" data-image-generate="${scene.id}">直接生成图卡</button>` : "";
    const retryButton = config.configured && (scene.imageStatus === "生成失败" || scene.imageStatus === "已生成待确认" || scene.imageStatus === "图卡已确认") ? `<button class="button button-secondary" type="button" data-image-generate="${scene.id}">${scene.imageStatus === "生成失败" ? "重新生成" : "重新生成一张"}</button>` : "";
    const uploadLabel = scene.imageStatus === "生成失败" ? "生成失败时上传备用" : "上传本地图卡";
    const upload = canUpload ? `<label class="upload-button" for="image-scene-${scene.id}"><input id="image-scene-${scene.id}" type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/heif" data-image-scene="${scene.id}" hidden>${uploadLabel}</label>` : "";
    const error = scene.imageError || scene.imageSearchError ? `<p class="image-error">${escapeHtml(scene.imageError || scene.imageSearchError)}</p>` : "";
    const source = scene.imageSource ? `<p class="image-source">素材来源：${escapeHtml(scene.imageSource.source)} · ${escapeHtml(scene.imageSource.creator)}${scene.imageSource.landingUrl ? ` · <a href="${escapeHtml(scene.imageSource.landingUrl)}" target="_blank" rel="noreferrer">查看原页</a>` : ""}</p>` : "";
    return `<article class="image-card">
      ${preview}
      <div><p class="eyebrow">第 ${scene.order} 句</p><h4>${escapeHtml(scene.original)}</h4><p>${escapeHtml(scene.visualBrief)}</p>
      ${candidatePanel}
      <div class="image-actions">${confirmButton}${searchButton}${directGenerate}${retryButton}${upload}</div>
      <p class="image-state">${escapeHtml(scene.imageStatus || "待检索素材")}</p>${source}${error}</div>
    </article>`;
  }));
  editor.innerHTML = cards.join("");
  editor.querySelectorAll("[data-image-preview]").forEach(button => button.addEventListener("click", () => {
    const scene = currentScenes.find(item => item.id === button.dataset.imagePreview);
    const image = button.querySelector("img");
    if (scene && image) openImageLightbox(image.src, `第 ${scene.order} 句 · ${scene.original}`, scene.imageSource);
  }));
  editor.querySelectorAll("[data-image-search]").forEach(button => button.addEventListener("click", async () => {
    const scene = currentScenes.find(item => item.id === button.dataset.imageSearch);
    if (scene) await searchSceneImages(scene, false);
  }));
  editor.querySelectorAll("[data-image-no-match]").forEach(button => button.addEventListener("click", async () => {
    const scene = currentScenes.find(item => item.id === button.dataset.imageNoMatch);
    if (scene) await generateSceneImage(scene);
  }));
  editor.querySelectorAll("[data-image-candidate]").forEach(button => button.addEventListener("click", async () => {
    const scene = currentScenes.find(item => item.id === button.dataset.imageCandidate);
    const candidate = scene?.imageCandidates?.[Number(button.dataset.candidateIndex)];
    if (scene && candidate) await selectImageCandidate(scene, candidate);
  }));
  editor.querySelectorAll("[data-image-confirm]").forEach(button => button.addEventListener("click", async () => {
    const scene = currentScenes.find(item => item.id === button.dataset.imageConfirm);
    if (!scene) return;
    scene.imageStatus = "图卡已确认";
    await persistScenes();
    renderImageEditor({ auto: false });
  }));
  editor.querySelectorAll("[data-image-generate]").forEach(button => button.addEventListener("click", async () => {
    const scene = currentScenes.find(item => item.id === button.dataset.imageGenerate);
    if (scene) await generateSceneImage(scene);
  }));
  editor.querySelectorAll("[data-image-scene]").forEach(input => input.addEventListener("change", async event => {
    const [file] = event.target.files;
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      window.alert("单张图卡请控制在 8 MB 内。");
      return;
    }
    const asset = await CourseStore.saveAsset(file);
    const scene = currentScenes.find(item => item.id === input.dataset.imageScene);
    scene.imageAssetId = asset.id;
    scene.imageStatus = "图卡已确认";
    scene.imageSource = { source: "本地上传", creator: "家长/老师提供", license: "待自行确认", landingUrl: null };
    scene.imageError = "";
    await persistScenes();
    renderImageEditor({ auto: false });
  }));
  if (auto && currentCourse && autoGenerationStartedForCourseId !== currentCourse.id) {
    autoGenerationStartedForCourseId = currentCourse.id;
    discoverImagesFirst();
  }
}

async function renderPublishChecklist() {
  await persistScenes();
  const target = document.querySelector("#publish-checklist");
  const textReady = currentCourse?.sourceStatus === "已校对";
  const imagesReady = currentScenes.filter(scene => scene.imageAssetId && scene.imageStatus === "图卡已确认").length;
  const imagesPending = Math.max(0, currentScenes.length - imagesReady);
  target.innerHTML = `
    <div class="check-row ${textReady ? "ready" : ""}"><strong>${textReady ? "已完成" : "待完成"}</strong><span>教材原文已校对</span></div>
    <div class="check-row ${currentScenes.length >= 2 ? "ready" : ""}"><strong>${currentScenes.length >= 2 ? "已完成" : "待完成"}</strong><span>${currentScenes.length} 个记忆意群</span></div>
    <div class="check-row optional ${imagesPending ? "has-pending" : "ready"}"><strong>${imagesPending ? "可选" : "已完成"}</strong><span>${imagesReady} / ${currentScenes.length} 张图卡已完成${imagesPending ? `，还有 ${imagesPending} 张待完成` : ""}</span>${imagesPending ? `<button class="pending-link" type="button" data-open-pending-images>查看待完成</button>` : ""}</div>
    ${imagesPending ? `<p class="optional-note">图卡不是发布硬门槛。没有额度也可以先发布，之后再回来补做；有额度时可以在待完成列表中直接生成。</p>` : ""}`;
  target.querySelector("[data-open-pending-images]")?.addEventListener("click", () => {
    pendingImagesOnly = true;
    showBuildStep("images");
  });
}

function openImageLightbox(src, title, source) {
  const lightbox = document.querySelector("#image-lightbox");
  const image = document.querySelector("#image-lightbox-image");
  const titleTarget = document.querySelector("#image-lightbox-title");
  const sourceTarget = document.querySelector("#image-lightbox-source");
  if (!lightbox || !image) return;
  image.src = src;
  image.alt = title;
  titleTarget.textContent = title;
  sourceTarget.innerHTML = source ? `素材来源：${escapeHtml(source.source)} · ${escapeHtml(source.creator)}${source.landingUrl ? ` · <a href="${escapeHtml(source.landingUrl)}" target="_blank" rel="noreferrer">查看原页</a>` : ""}` : "本地上传或课程库图卡";
  lightbox.hidden = false;
  document.body.classList.add("lightbox-open");
  document.querySelector("#close-image-lightbox")?.focus();
}

function closeImageLightbox() {
  const lightbox = document.querySelector("#image-lightbox");
  if (!lightbox) return;
  lightbox.hidden = true;
  document.querySelector("#image-lightbox-image").src = "";
  document.body.classList.remove("lightbox-open");
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("浏览器无法读取这个文件。"));
    reader.readAsDataURL(file);
  });
}

async function importSourceFile(file) {
  if (!file) return;
  setMessage("source-import-message", `正在在本机提取“${file.name}”的文字……`);
  try {
    const content = await readAsDataUrl(file);
    const response = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, type: file.type, content })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "导入失败。 ");
    pendingSource = { fileName: result.name, kind: result.kind, extractedText: result.text, confirmedText: result.text, sourceUrl: result.sourceUrl };
    if (!document.querySelector("#course-title").value.trim()) document.querySelector("#course-title").value = result.name.replace(/\.[^.]+$/, "");
    document.querySelector("#course-text").value = result.text;
    setMessage("source-import-message", "文字已提取。请对照教材校对后再生成学习包。");
  } catch (error) {
    setMessage("source-import-message", error.message, true);
  }
}

async function saveConfirmedSource(event) {
  event.preventDefault();
  const values = {
    title: document.querySelector("#course-title").value,
    author: document.querySelector("#course-author").value,
    dynasty: document.querySelector("#course-dynasty").value,
    grade: document.querySelector("#course-grade").value,
    fullText: document.querySelector("#course-text").value
  };
  if (!normalize(values.fullText)) return;
  const now = new Date().toISOString();
  if (currentCourse) {
    currentCourse = await CourseStore.saveCourse({ ...currentCourse, ...values, fullText: normalize(values.fullText), sourceStatus: "已校对", status: currentCourse.status === "published" ? "draft" : currentCourse.status });
  } else {
    currentCourse = await CourseStore.createCourse({ ...values, fullText: normalize(values.fullText) });
    currentCourse = await CourseStore.saveCourse({ ...currentCourse, sourceStatus: "已校对" });
  }
  currentSource = await CourseStore.saveSource(currentCourse.id, {
    ...(currentSource || pendingSource || {}),
    confirmedText: currentCourse.fullText,
    confirmedAt: now
  });
  currentScenes = buildScenes(currentCourse.fullText);
  await CourseStore.saveScenes(currentCourse.id, currentScenes);
  document.querySelector("#builder-title").textContent = `编辑：${currentCourse.title}`;
  setMessage("source-status-message", `已拆分为 ${currentScenes.length} 个候选意群。`);
  showBuildStep("scenes");
}

async function regenerateScenes() {
  const text = document.querySelector("#course-text").value;
  if (!normalize(text)) return;
  currentScenes = buildScenes(text);
  if (currentCourse) await CourseStore.saveScenes(currentCourse.id, currentScenes);
  renderSceneEditor();
}

async function publishCurrentCourse() {
  try {
    await persistScenes();
    currentCourse = await CourseStore.publish(currentCourse.id);
    setMessage("publish-message", "课程已发布。现在可从选诗计划进入背诗练习页。");
    await showView("library");
  } catch (error) {
    setMessage("publish-message", error.message, true);
  }
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatReportDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function formatReportDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = number => String(number).padStart(2, "0");
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function download(content, type, filename) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function reportModel(bundle, data) {
  const latest = data.attempts[0] || null;
  const sceneMap = new Map(bundle.scenes.map(scene => [scene.id, scene]));
  const reviewStates = data.reviewStates || [];
  const stateMap = new Map(reviewStates.map(state => [state.sceneId, state]));
  const pendingReviews = data.reviews.filter(review => review.status === "pending");
  const feedbackHistory = reviewStates.flatMap(state => (state.history || state.feedbackHistory || []).map(entry => ({ ...entry, sceneId: state.sceneId }))).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const latestUnits = new Map((latest?.units || []).map(unit => [unit.sceneId, unit]));
  const weakScenes = bundle.scenes.filter(scene => {
    const unit = latestUnits.get(scene.id);
    const state = stateMap.get(scene.id);
    return unit ? (!unit.correct || unit.hints > 0 || unit.feedback !== "remembered") : Boolean(state && state.lastFeedback !== "remembered");
  });
  return {
    bundle,
    data,
    latest,
    pendingReviews,
    reviewStates,
    sceneMap,
    stateMap,
    feedbackHistory,
    latestUnits,
    weakScenes,
    weakCount: weakScenes.length,
    masteredCount: latest ? latest.units.filter(unit => unit.correct && unit.hints === 0 && (unit.feedback || "remembered") === "remembered").length : 0
  };
}

function feedbackText(value) {
  return CourseStore.feedbackLabels?.[value] || ({ remembered: "记住了", hesitant: "有点卡", forgotten: "忘记了" }[value] || "未评价");
}

function buildCurveSvg(model) {
  const attempts = [...model.data.attempts].reverse();
  if (!attempts.length) return `<div class="curve-empty">完成闯关后，这里会显示每次实际严格回忆率。</div>`;
  const width = 680;
  const height = 220;
  const left = 44;
  const right = 18;
  const top = 18;
  const bottom = 34;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const x = index => attempts.length === 1 ? left + plotWidth / 2 : left + (index / (attempts.length - 1)) * plotWidth;
  const y = value => top + (100 - Math.max(0, Math.min(100, value))) / 100 * plotHeight;
  const actualPoints = attempts.map((attempt, index) => {
    const units = Array.isArray(attempt.units) ? attempt.units : [];
    const value = units.length ? Math.round(units.filter(unit => unit.correct).length / units.length * 100) : 0;
    return { x: x(index), y: y(value), value };
  });
  const actualPath = actualPoints.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const theoretical = Array.from({ length: 25 }, (_, index) => {
    const progress = index / 24;
    const value = 92 * Math.exp(-progress * 2.1) + 8;
    return `${index ? "L" : "M"}${(left + progress * plotWidth).toFixed(1)},${y(value).toFixed(1)}`;
  }).join(" ");
  return `<svg class="curve-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="实际严格回忆率和 MVP 示意趋势"><line x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}"/><line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}"/><text x="8" y="${top + 5}">100%</text><text x="15" y="${height - bottom + 5}">0%</text><path class="curve-theory" d="${theoretical}"/><path class="curve-actual" d="${actualPath}"/>${actualPoints.map((point, index) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4"><title>第 ${index + 1} 次：${point.value}%</title></circle>`).join("")}<text x="${left}" y="${height - 8}">第 1 次</text><text x="${width - right - 42}" y="${height - 8}">最近</text></svg><div class="curve-legend"><span><i class="legend-actual"></i>实际严格回忆率</span><span><i class="legend-theory"></i>MVP 示意趋势（非精确科学曲线）</span></div>`;
}

function reportTableRows(model) {
  const { bundle, latestUnits, stateMap } = model;
  return bundle.scenes.map((scene, index) => {
    const unit = latestUnits.get(scene.id) || {};
    const state = stateMap.get(scene.id);
    const feedback = unit.feedback || state?.lastFeedback;
    const historyCount = state?.history?.length || state?.feedbackHistory?.length || 0;
    return `<tr><td>${index + 1}</td><td>${escapeHtml(scene.original)}</td><td>${unit.correct && unit.hints === 0 ? "严格通过" : unit.correct ? "使用提示" : unit.attempts ? "未通过" : "尚未学习"}</td><td>${unit.attempts ?? "—"}</td><td>${unit.hints ?? "—"}</td><td>${escapeHtml(feedbackText(feedback))}</td><td>${state ? `${state.stage}（${state.intervalDays}天）` : "—"}</td><td>${escapeHtml(state?.firstLearnedAt || "—")}</td><td>${escapeHtml(state?.nextReviewDate || "—")}</td><td>${historyCount}</td></tr>`;
  }).join("");
}

function buildReportDashboard(model) {
  const { bundle, data, latest, pendingReviews, reviewStates, weakScenes, masteredCount } = model;
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const todayKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const dueKeys = new Set(pendingReviews.map(review => String(review.dueAt || "").slice(0, 10)));
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: 42 }, (_, index) => {
    const day = index - firstDay + 1;
    if (day < 1 || day > daysInMonth) return `<span class="calendar-day is-empty"></span>`;
    const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const classes = ["calendar-day", key === todayKey ? "is-today" : "", dueKeys.has(key) ? "has-review" : ""].filter(Boolean).join(" ");
    return `<span class="${classes}" title="${dueKeys.has(key) ? "有待复习任务" : ""}">${day}</span>`;
  }).join("");
  const sceneCount = bundle.scenes.length;
  const notStarted = bundle.scenes.filter(scene => !model.stateMap.has(scene.id)).length;
  const latestScore = latest ? `${latest.score}%` : "—";
  const dueToday = pendingReviews.filter(review => String(review.dueAt || "").slice(0, 10) === todayKey).length;
  const laterDue = Math.max(0, pendingReviews.length - dueToday);
  const ratio = value => sceneCount ? `${Math.round(value / sceneCount * 100)}%` : "—";
  return `<section class="report-dashboard"><div class="report-widget report-calendar-widget"><div class="report-widget-head"><div><small>复习日历</small><strong>${year}年${month + 1}月</strong></div><span class="calendar-key"><i></i>待复习</span></div><div class="calendar-week"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div><div class="calendar-days">${cells}</div></div><div class="report-widget"><h3>整体统计</h3><table class="mini-table"><tbody><tr><td>已掌握</td><td>${masteredCount}</td><td>${ratio(masteredCount)}</td></tr><tr><td>需巩固</td><td>${weakScenes.length}</td><td>${ratio(weakScenes.length)}</td></tr><tr><td>尚未开始</td><td>${notStarted}</td><td>${ratio(notStarted)}</td></tr><tr class="total"><td>合计</td><td>${sceneCount}</td><td>100%</td></tr></tbody></table></div><div class="report-widget"><h3>复习提醒</h3><table class="mini-table"><tbody><tr><td>今日复习</td><td>${dueToday}</td><td>${dueToday ? "请完成" : "暂无"}</td></tr><tr><td>后续任务</td><td>${laterDue}</td><td>${laterDue ? "已安排" : "暂无"}</td></tr><tr><td>学习次数</td><td>${data.attempts.length}</td><td>${latestScore}</td></tr><tr class="total"><td>当前阶段</td><td colspan="2">${reviewStates.length ? "进行中" : "待开始"}</td></tr></tbody></table></div></section>`;
}

function buildReportMarkup(model, printable = false) {
  const { bundle, data, latest, pendingReviews, sceneMap, reviewStates, feedbackHistory, weakScenes, masteredCount } = model;
  const courseTitle = escapeHtml(bundle.course.title);
  const pendingRows = pendingReviews.length ? pendingReviews.map((review, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(formatReportDate(review.dueAt))}</td><td>${escapeHtml(sceneMap.get(review.sceneId)?.original || "—")}</td><td>${escapeHtml(review.feedbackLabel || feedbackText(review.feedback))}</td><td>${escapeHtml(review.reason || "复习")}</td><td>${escapeHtml(review.status === "pending" ? "待复习" : review.status)}</td></tr>`).join("") : `<tr><td colspan="6" class="empty">暂无待复习任务</td></tr>`;
  const attemptRows = data.attempts.length ? data.attempts.map((attempt, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(formatReportDateTime(attempt.createdAt))}</td><td>${attempt.score}%</td><td>${attempt.sequenceCorrect ? "通过" : "待重练"}</td><td>${attempt.units?.filter(unit => unit.correct).length || 0} / ${attempt.units?.length || 0}</td><td>${attempt.units?.reduce((sum, unit) => sum + (unit.hints || 0), 0) || 0}</td><td>${attempt.weakSceneIds?.length || 0}</td></tr>`).join("") : `<tr><td colspan="7" class="empty">尚未完成闯关</td></tr>`;
  const historyRows = feedbackHistory.length ? feedbackHistory.map((entry, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(formatReportDateTime(entry.createdAt))}</td><td>${escapeHtml(sceneMap.get(entry.sceneId)?.original || "—")}</td><td>${escapeHtml(entry.feedbackLabel || feedbackText(entry.feedback))}</td><td>${entry.strictCorrect ? "通过" : "未通过"}</td><td>${entry.hints || 0}</td><td>${entry.stageBefore} → ${entry.stageAfter}</td><td>${escapeHtml(entry.nextReviewDate || "—")}</td></tr>`).join("") : `<tr><td colspan="8" class="empty">尚未记录逐句反馈</td></tr>`;
  const planRows = reviewStates.flatMap(state => (state.plan || []).map(plan => ({ state, plan }))).sort((a, b) => String(a.plan.date).localeCompare(String(b.plan.date))).map((item, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(sceneMap.get(item.state.sceneId)?.original || "—")}</td><td>${item.plan.stage}</td><td>${item.plan.intervalDays} 天</td><td>${escapeHtml(item.plan.date)}</td><td>${escapeHtml(item.plan.label)}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">完成闯关并评价后生成完整预测计划</td></tr>`;
  const weakList = weakScenes.length ? weakScenes.map(scene => `<li><strong>${escapeHtml(scene.original)}</strong><span>${escapeHtml(feedbackText(model.stateMap.get(scene.id)?.lastFeedback))} · ${model.stateMap.get(scene.id)?.nextReviewDate ? `下次 ${escapeHtml(model.stateMap.get(scene.id).nextReviewDate)}` : "待首次评价"}</span></li>`).join("") : "<li>最近一次闯关暂未发现薄弱句。</li>";
  return `<article class="full-report ${printable ? "print-report" : ""}"><header class="report-banner"><div><p class="eyebrow">${escapeHtml(bundle.course.status === "published" ? "已发布课程 · 完整学习报告" : "草稿课程 · 完整学习报告")}</p><h2>${courseTitle}</h2><p>${escapeHtml([bundle.course.dynasty, bundle.course.author, bundle.course.grade].filter(Boolean).join(" · ") || "学习表现与复习安排")}</p></div><div class="report-generated">生成于 ${escapeHtml(formatReportDateTime(new Date().toISOString()))}</div></header>${buildReportDashboard(model)}<section class="report-stats"><div><small>学习次数</small><strong>${data.attempts.length}</strong></div><div><small>最近闯关</small><strong>${latest ? latest.score + "%" : "—"}</strong></div><div><small>最近掌握</small><strong>${latest ? masteredCount + " / " + bundle.scenes.length : "—"}</strong></div><div><small>待复习任务</small><strong>${pendingReviews.length}</strong></div></section><section class="report-section"><h3>按句掌握情况</h3><div class="table-scroll"><table><thead><tr><th>序号</th><th>原文</th><th>严格回忆</th><th>尝试</th><th>提示</th><th>最近评价</th><th>阶段</th><th>首次学习</th><th>下一次</th><th>历史次数</th></tr></thead><tbody>${reportTableRows(model)}</tbody></table></div></section><section class="report-section"><h3>最近闯关</h3><div class="table-scroll"><table><thead><tr><th>序号</th><th>时间</th><th>总分</th><th>整段排序</th><th>严格通过</th><th>提示总数</th><th>薄弱句</th></tr></thead><tbody>${attemptRows}</tbody></table></div></section><section class="report-section"><h3>逐句反馈历史</h3><div class="table-scroll"><table><thead><tr><th>序号</th><th>时间</th><th>原文</th><th>反馈</th><th>严格回忆</th><th>提示</th><th>阶段变化</th><th>下一次</th></tr></thead><tbody>${historyRows}</tbody></table></div></section><section class="report-section"><h3>下一次复习</h3><div class="table-scroll"><table><thead><tr><th>序号</th><th>日期</th><th>原文</th><th>反馈</th><th>原因</th><th>状态</th></tr></thead><tbody>${pendingRows}</tbody></table></div></section><section class="report-section"><h3>完整预测计划</h3><p class="section-note">计划按每句当前阶段生成；“若下次记住了”只是便于安排的预测，不代表固定结果。</p><div class="table-scroll"><table><thead><tr><th>序号</th><th>原文</th><th>阶段</th><th>间隔</th><th>预测日期</th><th>口径</th></tr></thead><tbody>${planRows}</tbody></table></div></section><section class="report-section"><h3>薄弱句</h3><ul class="weak-list">${weakList}</ul></section><section class="report-section"><h3>遗忘曲线可视化</h3><p class="section-note">实线来自每次闯关的严格回忆率；虚线仅为 MVP 说明用的趋势示意，不是科学精确曲线。</p><div class="curve-wrap">${buildCurveSvg(model)}</div></section><section class="report-rule report-method-note"><strong>规则口径</strong><span>阶段间隔 ${CourseStore.reviewIntervals.join("、")} 天；反馈会影响下一次复习安排。这是可调整的 MVP 产品规则，不是科学精确模型。</span></section><p class="report-foot">数据保存在当前浏览器 IndexedDB；同一天重复学习会新增闯关和反馈历史，不覆盖旧记录。</p></article>`;
}

function printReport(model) {
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    setMessage("report-export-message", "浏览器阻止了报告窗口，请允许弹出窗口后重试。", true);
    return;
  }
  const title = escapeHtml(model.bundle.course.title);
  printWindow.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title} · 学习报告</title><style>${reportPrintStyles()}</style></head><body><main class="sheet">${buildReportMarkup(model, true)}</main><script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));<\/script></body></html>`);
  printWindow.document.close();
}

function reportPrintStyles() {
  return `*{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#1d2938;font:12px/1.55,-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}.sheet{width:210mm;min-height:297mm;margin:0 auto;padding:12mm;background:#fff}.report-banner{padding:18px 22px;background:#173f70;color:#fff;display:flex;justify-content:space-between;gap:20px}.report-banner .eyebrow{color:#d9e8f8}.report-banner h2{margin:3px 0;font-size:24px}.report-banner p{margin:0}.report-generated{color:#d9e8f8}.report-rule{margin:12px 0;padding:10px 12px;border-left:4px solid #e1b94d;background:#fff8dd}.report-rule strong,.report-rule span{display:block}.report-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0}.report-stats div{padding:10px;background:#f4f7fb;border:1px solid #d8e0e9}.report-stats small,.report-stats strong{display:block}.report-stats strong{font-size:18px;color:#173f70}.report-section{margin-top:16px;break-inside:avoid}.report-section h3{margin:0 0 7px;padding:7px 10px;border-left:4px solid #e1b94d;background:#edf4fb;color:#173f70;font-size:15px}.section-note,.report-foot{color:#687787}.table-scroll{overflow:visible}table{width:100%;border-collapse:collapse}th,td{padding:5px 6px;border:1px solid #d8e0e9;text-align:left;vertical-align:top;word-break:break-word}th{background:#173f70;color:#fff}tr:nth-child(even) td{background:#fbfcfe}.empty{text-align:center;color:#7b8794;padding:15px}.weak-list{margin:0;padding-left:22px}.weak-list li{margin:4px 0}.weak-list span{margin-left:8px;color:#687787}.curve-svg{width:100%;height:auto;border:1px solid #d8e0e9}.curve-svg line{stroke:#aeb9c3}.curve-svg text{fill:#687787;font-size:11px}.curve-actual{fill:none;stroke:#174d3c;stroke-width:3}.curve-theory{fill:none;stroke:#bd8730;stroke-width:2;stroke-dasharray:6 5}.curve-svg circle{fill:#174d3c}.curve-legend{display:flex;gap:15px;margin-top:5px;color:#687787;font-size:11px}.curve-legend i{display:inline-block;width:18px;border-top:3px solid #174d3c;margin:0 4px 3px 0}.curve-legend .legend-theory{border-color:#bd8730;border-top-style:dashed}.curve-empty{padding:25px;border:1px dashed #aeb9c3;color:#687787;text-align:center}.report-dashboard{display:grid;grid-template-columns:1.18fr 1fr 1fr;gap:8px;padding:10px;background:#f4f7fb;border-bottom:1px solid #d8e0e9}.report-widget{min-width:0;padding:9px 10px;border:1px solid #d8e0e9;border-radius:4px;background:#fff}.report-widget h3{margin:0 0 6px;color:#173f70;font-size:12px}.report-widget-head{display:flex;align-items:end;justify-content:space-between;gap:8px;margin-bottom:6px}.report-widget-head small,.report-widget-head strong{display:block}.report-widget-head small{color:#687787;font-size:9px}.report-widget-head strong{color:#173f70;font-size:13px}.calendar-key{color:#687787;font-size:9px}.calendar-key i{display:inline-block;width:5px;height:5px;margin-right:3px;border-radius:50%;background:#3c83b8}.calendar-week,.calendar-days{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center}.calendar-week{margin-bottom:2px;color:#7b8794;font-size:8px}.calendar-day{min-height:17px;display:grid;place-items:center;position:relative;border-radius:3px;color:#3a4a5b;font-size:9px}.calendar-day.is-empty{visibility:hidden}.calendar-day.is-today{background:#e4f0fa;color:#173f70;font-weight:700}.calendar-day.has-review:after{position:absolute;bottom:1px;width:3px;height:3px;content:"";border-radius:50%;background:#3c83b8}.mini-table{width:100%;border-collapse:collapse;color:#3b4a58;font-size:9px}.mini-table td{padding:3px;border-bottom:1px solid #edf0f3}.mini-table td:nth-child(2),.mini-table td:nth-child(3){text-align:right;color:#173f70}.mini-table tr.total td{border-top:1px solid #bfcbd6;border-bottom:0;font-weight:700}.report-method-note{margin:6px 12px 0;padding:0 0 0 5px;display:flex;gap:5px;border-left:2px solid #d5aa48;background:transparent;color:#8a96a2;font-size:8px;line-height:1.35}.report-method-note strong{color:#6f7d8a;font-size:8px}.report-stats{display:none}.report-section{margin-top:14px}.report-section+.report-section{margin-top:18px}.report-section h3{margin-bottom:5px;padding:5px 7px;border-left:3px solid #3c83b8;background:#edf4fb;color:#173f70;font-size:11px}.full-report table{table-layout:fixed;font-size:8px}.full-report th,.full-report td{line-height:1.4;overflow-wrap:anywhere}.full-report td:nth-child(2),.full-report th:nth-child(2){width:22%}.report-method-note{max-width:calc(100% - 24px);margin:15px 12px 0;font-size:8px}.report-foot{margin:12px 12px 0;color:#8a96a2;font-size:8px}@media print{body{background:#fff}.sheet{width:auto;min-height:auto;margin:0;padding:0}.report-banner{break-inside:avoid}.report-dashboard{break-inside:avoid}.report-section{break-inside:avoid}}`;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32(value) {
  return new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]);
}

function uint16(value) {
  return new Uint8Array([value & 255, (value >>> 8) & 255]);
}

function concatBytes(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  chunks.forEach(chunk => { result.set(chunk, offset); offset += chunk.length; });
  return result;
}

function zipStored(files) {
  const encoder = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;
  files.forEach(file => {
    const name = encoder.encode(file.name);
    const data = typeof file.content === "string" ? encoder.encode(file.content) : file.content;
    const crc = crc32(data);
    const header = concatBytes([new Uint8Array([80, 75, 3, 4]), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0), uint32(crc), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), name]);
    local.push(header, data);
    central.push({ name, crc, size: data.length, offset });
    offset += header.length + data.length;
  });
  const centralBytes = [];
  let centralSize = 0;
  central.forEach(file => {
    const record = concatBytes([new Uint8Array([80, 75, 1, 2]), uint16(20), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0), uint32(file.crc), uint32(file.size), uint32(file.size), uint16(file.name.length), uint16(0), uint16(0), uint16(0), uint16(0), uint32(0), uint32(file.offset), file.name]);
    centralBytes.push(record);
    centralSize += record.length;
  });
  const centralOffset = offset;
  const end = concatBytes([new Uint8Array([80, 75, 5, 6]), uint16(0), uint16(0), uint16(files.length), uint16(files.length), uint32(centralSize), uint32(centralOffset), uint16(0)]);
  return concatBytes([...local, ...centralBytes, end]);
}

function xlsxCell(ref, value, style = 0) {
  if (value === null || value === undefined || value === "") return `<c r="${ref}" s="${style}"/>`;
  if (typeof value === "number") return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function excelColumn(index) {
  let value = index + 1;
  let result = "";
  while (value) { const remainder = (value - 1) % 26; result = String.fromCharCode(65 + remainder) + result; value = Math.floor((value - 1) / 26); }
  return result;
}

function makeWorksheet(rows, widths = [], merges = []) {
  const xmlRows = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, columnIndex) => { const item = typeof cell === "object" ? cell : { value: cell }; return xlsxCell(`${excelColumn(columnIndex)}${rowIndex + 1}`, item.value, item.style || 0); }).join("")}</row>`).join("");
  const cols = widths.length ? `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>` : "";
  const mergeXml = merges.length ? `<mergeCells count="${merges.length}">${merges.map(range => `<mergeCell ref="${range}"/>`).join("")}</mergeCells>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>${cols}<sheetData>${xmlRows}</sheetData>${mergeXml}</worksheet>`;
}

function excelStyles() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="0"/><fonts count="3"><font><sz val="11"/><name val="PingFang SC"/></font><font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="PingFang SC"/></font><font><b/><sz val="11"/><name val="PingFang SC"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF173F70"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEAF3FA"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FFD8E0E9"/></left><right style="thin"><color rgb="FFD8E0E9"/></right><top style="thin"><color rgb="FFD8E0E9"/></top><bottom style="thin"><color rgb="FFD8E0E9"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="2" fillId="2" borderId="0" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

function buildExcelReport(model) {
  const { bundle, data, latest, pendingReviews, sceneMap, reviewStates, feedbackHistory, masteredCount } = model;
  const course = bundle.course;
  const header = values => values.map(value => ({ value, style: 4 }));
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const todayKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const dueKeys = new Set(pendingReviews.map(review => String(review.dueAt || "").slice(0, 10)));
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const calendarCells = Array.from({ length: 42 }, (_, index) => {
    const day = index - firstDay + 1;
    if (day < 1 || day > daysInMonth) return "";
    const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return { value: dueKeys.has(key) ? `${day} ·` : day, style: dueKeys.has(key) || key === todayKey ? 6 : 7 };
  });
  const dueToday = pendingReviews.filter(review => String(review.dueAt || "").slice(0, 10) === todayKey).length;
  const laterDue = Math.max(0, pendingReviews.length - dueToday);
  const notStarted = bundle.scenes.filter(scene => !model.stateMap.has(scene.id)).length;
  const sceneCount = bundle.scenes.length;
  const percent = value => sceneCount ? `${Math.round(value / sceneCount * 100)}%` : "—";
  const calendarHeader = ["日", "一", "二", "三", "四", "五", "六", "状态", "数量", "比例", "类型", "数量", "比例"].map(value => ({ value, style: 4 }));
  const calendarRows = [calendarHeader, ...Array.from({ length: 6 }, (_, row) => {
    const days = calendarCells.slice(row * 7, row * 7 + 7);
    return [...days, row === 0 ? "已掌握" : row === 1 ? "需巩固" : row === 2 ? "尚未开始" : row === 3 ? "合计" : "", row === 0 ? masteredCount : row === 1 ? model.weakScenes.length : row === 2 ? notStarted : row === 3 ? sceneCount : "", row === 0 ? percent(masteredCount) : row === 1 ? percent(model.weakScenes.length) : row === 2 ? percent(notStarted) : row === 3 ? "100%" : "", row === 0 ? "今日复习" : row === 1 ? "后续任务" : row === 2 ? "学习次数" : row === 3 ? "当前阶段" : "", row === 0 ? dueToday : row === 1 ? laterDue : row === 2 ? data.attempts.length : row === 3 ? (reviewStates.length ? "进行中" : "待开始") : "", row === 0 ? (dueToday ? "请完成" : "暂无") : row === 1 ? (laterDue ? "已安排" : "暂无") : row === 2 ? (latest ? `${latest.score}%` : "—") : "" ];
  })];
  const summaryRows = [
    [{ value: `${course.title} · 复习计划看板`, style: 1 }],
    [{ value: `生成时间：${formatReportDateTime(new Date().toISOString())}　${[course.dynasty, course.author, course.grade].filter(Boolean).join(" · ")}`, style: 2 }],
    [],
    [{ value: "复习日历", style: 4 }, {}, {}, {}, {}, {}, {}, { value: "整体统计", style: 4 }, {}, {}, { value: "复习提醒", style: 4 }, {}, {}],
    ...calendarRows,
    [{ value: "说明：蓝色小圆点表示该日期有待复习任务；详细记录见其他工作表。", style: 2 }]
  ];
  const sentenceRows = [
    [{ value: `${course.title} · 按句掌握情况`, style: 1 }],
    header(["序号", "原文", "严格回忆", "尝试", "提示", "最近反馈", "当前阶段", "首次学习", "下一次复习", "反馈历史次数"]),
    ...bundle.scenes.map((scene, index) => {
      const unit = model.latestUnits.get(scene.id) || {};
      const state = model.stateMap.get(scene.id);
      return [index + 1, scene.original, unit.correct && unit.hints === 0 ? "严格通过" : unit.correct ? "使用提示" : unit.attempts ? "未通过" : "尚未学习", unit.attempts ?? "—", unit.hints ?? "—", feedbackText(unit.feedback || state?.lastFeedback), state ? `${state.stage}（${state.intervalDays}天）` : "—", state?.firstLearnedAt || "—", state?.nextReviewDate || "—", state?.history?.length || 0];
    })
  ];
  const attemptRows = [
    [{ value: `${course.title} · 最近闯关`, style: 1 }],
    header(["序号", "学习时间", "总分", "整段排序", "严格通过句数", "提示总数", "薄弱句数", "用时（秒）"]),
    ...data.attempts.map((attempt, index) => [index + 1, formatReportDateTime(attempt.createdAt), `${attempt.score}%`, attempt.sequenceCorrect ? "通过" : "待重练", attempt.units?.filter(unit => unit.correct).length || 0, attempt.units?.reduce((sum, unit) => sum + (unit.hints || 0), 0) || 0, attempt.weakSceneIds?.length || 0, attempt.durationSeconds || 0])
  ];
  const historyRows = [
    [{ value: `${course.title} · 逐句反馈历史`, style: 1 }],
    header(["序号", "时间", "原文", "反馈", "严格回忆", "提示", "阶段变化", "下一次复习", "闯关排序"]),
    ...feedbackHistory.map((entry, index) => [index + 1, formatReportDateTime(entry.createdAt), sceneMap.get(entry.sceneId)?.original || "—", entry.feedbackLabel || feedbackText(entry.feedback), entry.strictCorrect ? "通过" : "未通过", entry.hints || 0, `${entry.stageBefore} → ${entry.stageAfter}`, entry.nextReviewDate || "—", entry.sequenceCorrect ? "通过" : "待重练"])
  ];
  const planRows = [
    [{ value: `${course.title} · 下一次与完整预测计划`, style: 1 }],
    header(["类型", "原文", "阶段", "间隔", "日期", "口径", "反馈/状态"]),
    ...pendingReviews.map(review => ["下一次任务", sceneMap.get(review.sceneId)?.original || "—", review.stage ?? "—", `${review.intervalDays ?? "—"} 天`, review.dueAt, review.reason || "复习", review.status === "pending" ? "待复习" : review.status]),
    ...reviewStates.flatMap(state => (state.plan || []).map(plan => ["预测计划", sceneMap.get(state.sceneId)?.original || "—", plan.stage, `${plan.intervalDays} 天`, plan.date, plan.label, state.lastFeedbackLabel || "—"]))
  ];
  const rows = [summaryRows, sentenceRows, attemptRows, historyRows, planRows];
  const sheetNames = ["复习计划看板", "按句掌握", "最近闯关", "反馈历史", "复习计划"];
  const overrides = rows.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const sheets = sheetNames.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`;
  const worksheetRels = sheetNames.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${worksheetRels}<Relationship Id="rId${sheetNames.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const bytes = zipStored([
    { name: "[Content_Types].xml", content: contentTypes },
    { name: "_rels/.rels", content: rels },
    { name: "xl/workbook.xml", content: workbook },
    { name: "xl/_rels/workbook.xml.rels", content: workbookRels },
    { name: "xl/styles.xml", content: excelStyles() },
    ...rows.map((sheetRows, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, content: makeWorksheet(sheetRows, index === 0 ? [10, 10, 10, 10, 10, 10, 10, 15, 15, 15, 15, 15, 15] : [12, 28, 24, 18, 18, 18, 18, 24, 24, 18], index === 0 ? ["A1:M1", "A2:M2", "A4:G4", "H4:J4", "K4:M4", "A12:M12"] : ["A1:J1"]) }))
  ]);
  return new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

async function exportReport(courseId, format) {
  const bundle = await CourseStore.getBundle(courseId);
  if (!bundle) return;
  const data = await CourseStore.reports(bundle.course.id);
  const model = reportModel(bundle, data);
  if (format === "pdf") {
    printReport(model);
    return;
  }
  download(buildExcelReport(model), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", `${bundle.course.title}-复习报告.xlsx`);
}

async function renderReports() {
  const courses = (await CourseStore.list(CourseStore.stores.courses)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const target = document.querySelector("#reports-content");
  if (!courses.length) {
    target.innerHTML = `<div class="empty-state"><h3>还没有课程记录</h3><p>发布课程并完成一次学习后，报告会显示每句的掌握结果、反馈历史、曲线与完整复习计划。</p></div>`;
    return;
  }
  const reports = await Promise.all(courses.map(async course => {
    const data = await CourseStore.reports(course.id);
    return reportModel(await CourseStore.getBundle(course.id), data);
  }));
  target.innerHTML = reports.map(model => {
    const courseId = model.bundle.course.id;
    const title = escapeHtml(model.bundle.course.title);
    if (!model.data.attempts.length) {
      return `<section class="report-entry" data-report-entry="${courseId}"><div class="empty-state"><p class="eyebrow">${title} · 选诗计划报告</p><h3>还没有学习记录</h3><p>课程已发布，但还没有完成一次背诗练习。走完一轮后，这里会显示掌握情况、薄弱句和复习计划。</p><a class="button button-primary" href="index.html?course=${encodeURIComponent(courseId)}">打开背诗练习</a></div></section>`;
    }
    return `<section class="report-entry" data-report-entry="${courseId}"><div class="report-entry-actions"><div><p class="eyebrow">${title} · 选诗计划报告</p><p class="report-entry-hint">报告包含总体摘要、按句掌握、最近闯关、反馈历史、下一次复习、完整预测计划、薄弱句和遗忘曲线。</p></div><div class="report-export"><button class="button button-primary" type="button" data-toggle-report-menu="${courseId}" aria-expanded="false">导出报告</button><div class="report-menu" data-report-menu="${courseId}" hidden><button type="button" data-report-pdf="${courseId}">PDF（打印 / 保存）</button><button type="button" data-report-xlsx="${courseId}">XLSX（可编辑）</button></div></div></div>${buildReportMarkup(model)}</section>`;
  }).join("");
  target.querySelectorAll("[data-toggle-report-menu]").forEach(button => button.addEventListener("click", () => {
    const menu = target.querySelector(`[data-report-menu="${button.dataset.toggleReportMenu}"]`);
    const open = menu.hidden;
    target.querySelectorAll(".report-menu").forEach(item => { item.hidden = true; });
    target.querySelectorAll("[data-toggle-report-menu]").forEach(item => item.setAttribute("aria-expanded", "false"));
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  }));
  target.querySelectorAll("[data-report-pdf]").forEach(button => button.addEventListener("click", () => exportReport(button.dataset.reportPdf, "pdf")));
  target.querySelectorAll("[data-report-xlsx]").forEach(button => button.addEventListener("click", () => exportReport(button.dataset.reportXlsx, "xlsx")));
}

async function bindEvents() {
  document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
  document.querySelectorAll("[data-view-target]").forEach(button => button.addEventListener("click", () => showView(button.dataset.viewTarget)));
  bindBuildOpeners();
  document.querySelector("#source-form").addEventListener("submit", saveConfirmedSource);
  document.querySelector("#regenerate-scenes").addEventListener("click", regenerateScenes);
  document.querySelector("#publish-course").addEventListener("click", publishCurrentCourse);
  document.querySelectorAll("[data-next-build]").forEach(button => button.addEventListener("click", () => {
    if (button.dataset.nextBuild === "images") pendingImagesOnly = false;
    showBuildStep(button.dataset.nextBuild);
  }));
  const input = document.querySelector("#source-file");
  const zone = document.querySelector("#source-drop");
  if (IS_STATIC_DEMO) {
    input.disabled = true;
    zone.classList.add("is-disabled");
    zone.setAttribute("aria-disabled", "true");
    zone.setAttribute("role", "note");
    zone.removeAttribute("tabindex");
    zone.querySelector("strong").textContent = "在线体验版请直接粘贴教材原文";
    document.querySelector("#source-drop-help").textContent = "PDF、Word、图片 OCR 和开放素材/图片生成需要下载本地完整版。";
  } else {
    zone.addEventListener("click", () => input.click());
    zone.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); input.click(); } });
    input.addEventListener("change", () => importSourceFile(input.files[0]));
    ["dragenter", "dragover"].forEach(type => zone.addEventListener(type, event => { event.preventDefault(); zone.classList.add("is-dragging"); }));
    ["dragleave", "drop"].forEach(type => zone.addEventListener(type, event => { event.preventDefault(); zone.classList.remove("is-dragging"); }));
    zone.addEventListener("drop", event => importSourceFile(event.dataTransfer.files[0]));
  }
  document.querySelector("#export-backup").addEventListener("click", async () => {
    const backup = await CourseStore.exportAll();
    download(JSON.stringify(backup, null, 2), "application/json", `古诗记忆助手备份-${CourseStore.today()}.json`);
  });
  document.querySelector("#close-image-lightbox").addEventListener("click", closeImageLightbox);
  document.querySelector("#image-lightbox").addEventListener("click", event => { if (event.target.matches("[data-close-lightbox]")) closeImageLightbox(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape") closeImageLightbox(); });
}

bindEvents().then(async () => {
  await seedStaticDemo();
  const requestedView = new URLSearchParams(location.search).get("view");
  showView(["library", "build", "reports"].includes(requestedView) ? requestedView : "library");
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
