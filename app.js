let bundle = null;
let imageUrls = new Map();
let stage = "understand";
let sceneIndex = 0;
let recallResults = {};
let orderSelection = [];
let orderCorrect = false;
let startedAt = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalize(value) {
  return String(value ?? "").replace(/[\s，、；。！？,.!?]/gu, "").trim();
}

function queryCourseId() {
  return new URLSearchParams(location.search).get("course");
}

function setLearnerNavVisible(visible) {
  const nav = document.querySelector("#learner-mobile-nav");
  if (nav) nav.hidden = !visible;
}

function setStage(next) {
  stage = next;
  document.querySelectorAll("[data-stage]").forEach(panel => {
    panel.hidden = panel.dataset.stage !== next;
  });
  renderProgress();
  if (next === "understand") renderUnderstand();
  if (next === "recall") renderRecall();
  if (next === "order") renderOrder();
  if (next === "result") renderResult();
}

function renderProgress() {
  if (!bundle) return;
  const labels = ["理解", "回忆", "闯关", "结果"];
  const current = ["understand", "recall", "order", "result"].indexOf(stage);
  document.querySelector("#lesson-progress").innerHTML = labels.map((label, index) => `<span class="${index === current ? "is-active" : index < current ? "is-done" : ""}"><i>${index + 1}</i>${label}</span>`).join("");
}

function imageUrl(scene) {
  return imageUrls.get(scene.id) || "";
}

async function prepareImages() {
  await Promise.all(bundle.scenes.map(async scene => {
    // 图卡是可选项。没有图片时不能把 undefined 传给 IndexedDB，否则孩子端会直接白屏。
    if (!scene.imageAssetId) return;
    const asset = await CourseStore.get(CourseStore.stores.assets, scene.imageAssetId);
    if (asset?.blob) imageUrls.set(scene.id, URL.createObjectURL(asset.blob));
  }));
}

function imageMarkup(scene, className = "scene-image") {
  const url = imageUrl(scene);
  return url ? `<img class="${className}" src="${url}" alt="图卡">` : `<div class="${className} missing-image">本句图卡待完成<br><small>可先按文字理解和背诵</small></div>`;
}

function renderUnderstand() {
  const scene = bundle.scenes[sceneIndex];
  const card = document.querySelector("#understand-card");
  card.innerHTML = `
    <div class="study-kicker">图卡 ${sceneIndex + 1} / ${bundle.scenes.length}</div>
    ${imageMarkup(scene, "understand-image")}
    <div class="understand-copy">
      <p class="eyebrow">先看画面，说说你看到了什么</p>
      <h2>${escapeHtml(scene.explanation)}</h2>
      <p class="anchor-copy">画面里要找到：${scene.visualAnchors.map(escapeHtml).join("、") || "人物、景物和动作"}</p>
      <details class="source-reveal"><summary>查看这一句原文</summary><p>${escapeHtml(scene.original)}</p></details>
    </div>
    <div class="stage-actions"><button id="understand-next" class="primary-action" type="button">${sceneIndex === bundle.scenes.length - 1 ? "开始无提示回忆" : "下一张图卡"}</button></div>`;
  card.querySelector("#understand-next").addEventListener("click", () => {
    if (sceneIndex < bundle.scenes.length - 1) {
      sceneIndex += 1;
      renderUnderstand();
    } else {
      sceneIndex = 0;
      setStage("recall");
    }
  });
}

function currentResult(scene) {
  return recallResults[scene.id] || { attempts: 0, hints: 0, correct: false, revealed: false, feedback: null };
}

const FEEDBACK_OPTIONS = [
  { value: "remembered", label: "记住了", className: "feedback-remembered" },
  { value: "hesitant", label: "有点卡", className: "feedback-hesitant" },
  { value: "forgotten", label: "忘记了", className: "feedback-forgotten" }
];

function renderRecall() {
  const scene = bundle.scenes[sceneIndex];
  const result = currentResult(scene);
  const card = document.querySelector("#recall-card");
  const feedback = result.correct
    ? `<p class="feedback good">这一句已经记住了。</p>`
    : result.revealed
      ? `<div class="answer-reveal"><p>对照原文，再读一遍：</p><strong>${escapeHtml(scene.original)}</strong></div>`
      : `<p class="feedback">看图后，在下面写出这一句。</p>`;
  card.innerHTML = `
    <div class="study-kicker">无提示回忆 ${sceneIndex + 1} / ${bundle.scenes.length}</div>
    ${imageMarkup(scene, "recall-image")}
    <div class="recall-copy"><p class="eyebrow">只看图，试着背出原文</p>${feedback}
      <label class="visually-hidden" for="recall-input">写出本句原文</label>
      <textarea id="recall-input" rows="3" placeholder="在这里写出你背到的原文" ${result.correct ? "disabled" : ""}></textarea>
      <div class="stage-actions">
        ${result.correct || result.revealed ? `<button id="recall-next" class="primary-action" type="button">${sceneIndex === bundle.scenes.length - 1 ? "进入整段闯关" : "下一句"}</button>` : `<button id="recall-check" class="primary-action" type="button">检查这一句</button><button id="recall-hint" class="secondary-action" type="button">查看提示</button>`}
      </div>
    </div>`;
  if (!result.correct && !result.revealed) {
    card.querySelector("#recall-check").addEventListener("click", () => {
      const answer = card.querySelector("#recall-input").value;
      result.attempts += 1;
      result.correct = normalize(answer) === normalize(scene.original);
      recallResults[scene.id] = result;
      renderRecall();
    });
    card.querySelector("#recall-hint").addEventListener("click", () => {
      result.hints += 1;
      result.revealed = true;
      recallResults[scene.id] = result;
      renderRecall();
    });
  }
  card.querySelector("#recall-next")?.addEventListener("click", () => {
    if (sceneIndex < bundle.scenes.length - 1) {
      sceneIndex += 1;
      renderRecall();
    } else {
      setStage("order");
    }
  });
}

function shuffledScenes() {
  const scenes = [...bundle.scenes];
  for (let index = scenes.length - 1; index > 0; index -= 1) {
    const swap = (index * 7 + 3) % (index + 1);
    [scenes[index], scenes[swap]] = [scenes[swap], scenes[index]];
  }
  return scenes;
}

function renderOrder() {
  const card = document.querySelector("#order-card");
  const options = shuffledScenes();
  const selected = orderSelection.map(id => bundle.scenes.find(scene => scene.id === id));
  card.innerHTML = `
    <div class="study-kicker">整段闯关</div>
    <div class="order-copy"><p class="eyebrow">不看原文，按课文顺序选图</p><h2>把图卡排成正确的背诵顺序</h2>
      <div class="selected-order" aria-label="已选择的顺序">${selected.length ? selected.map((scene, index) => `<button type="button" data-remove-order="${index}">${imageMarkup(scene, "order-thumb")}</button>`).join("") : "<span>还没有选择图卡</span>"}</div>
      <div class="order-options">${options.map(scene => `<button class="order-option" type="button" data-order-scene="${scene.id}" ${orderSelection.includes(scene.id) ? "disabled" : ""}>${imageMarkup(scene, "order-option-image")}</button>`).join("")}</div>
      <div class="stage-actions"><button id="clear-order" class="secondary-action" type="button">重新排列</button><button id="check-order" class="primary-action" type="button">提交闯关</button></div><p id="order-feedback" class="feedback"></p>
    </div>`;
  card.querySelectorAll("[data-order-scene]").forEach(button => button.addEventListener("click", () => {
    orderSelection.push(button.dataset.orderScene);
    renderOrder();
  }));
  card.querySelectorAll("[data-remove-order]").forEach(button => button.addEventListener("click", () => {
    orderSelection.splice(Number(button.dataset.removeOrder), 1);
    renderOrder();
  }));
  card.querySelector("#clear-order").addEventListener("click", () => { orderSelection = []; renderOrder(); });
  card.querySelector("#check-order").addEventListener("click", () => {
    const feedback = card.querySelector("#order-feedback");
    if (orderSelection.length !== bundle.scenes.length) {
      feedback.textContent = `还差 ${bundle.scenes.length - orderSelection.length} 张图卡。`;
      return;
    }
    orderCorrect = orderSelection.every((id, index) => id === bundle.scenes[index].id);
    feedback.textContent = orderCorrect ? "顺序正确，完成闯关。" : "顺序还不对，本次结果会把排序表现一并记录。";
    feedback.classList.toggle("good", orderCorrect);
    window.setTimeout(() => setStage("result"), 450);
  });
}

async function renderResult() {
  const units = bundle.scenes.map(scene => ({ sceneId: scene.id, ...currentResult(scene) }));
  const recalled = units.filter(unit => unit.correct).length;
  const recallScore = Math.round((recalled / units.length) * 70);
  const total = recallScore + (orderCorrect ? 30 : 0);
  const weakSceneIds = units.filter(unit => !unit.correct || unit.hints > 0 || unit.feedback !== "remembered").map(unit => unit.sceneId);
  const selectedCount = units.filter(unit => unit.feedback).length;
  const card = document.querySelector("#result-card");
  card.innerHTML = `<div class="result-copy"><p class="eyebrow">本次学习完成</p><h2>${total} 分</h2><p>无提示回忆 ${recalled} / ${units.length} 句 · 整段排序 ${orderCorrect ? "通过" : "待重练"}</p><div class="result-feedback-note"><strong>逐句复习评价</strong><span>请按自己的真实感受为每一句选择评价；它会决定下一次复习日期。</span></div><div class="result-list">${bundle.scenes.map(scene => { const unit = currentResult(scene); return `<div class="result-unit ${unit.feedback || "unrated"}"><div class="result-unit-copy"><span>${unit.correct && !unit.hints ? "严格回忆通过" : unit.revealed ? "使用了提示" : "严格回忆未通过"}</span><p>${escapeHtml(scene.original)}</p><small>尝试 ${unit.attempts} 次 · 提示 ${unit.hints} 次</small></div><div class="feedback-choices" role="group" aria-label="${escapeHtml(scene.original)} 的复习评价">${FEEDBACK_OPTIONS.map(option => `<button class="feedback-choice ${option.className} ${unit.feedback === option.value ? "is-selected" : ""}" type="button" data-feedback-scene="${scene.id}" data-feedback-value="${option.value}">${option.label}</button>`).join("")}</div></div>`; }).join("")}</div><div class="stage-actions"><button id="save-result" class="primary-action" type="button" ${selectedCount < units.length ? "disabled" : ""}>${selectedCount < units.length ? `还需评价 ${units.length - selectedCount} 句` : "生成复习任务"}</button></div><p id="result-message" class="feedback"></p></div>`;
  card.querySelectorAll("[data-feedback-scene]").forEach(button => button.addEventListener("click", () => {
    const result = currentResult(bundle.scenes.find(scene => scene.id === button.dataset.feedbackScene));
    result.feedback = button.dataset.feedbackValue;
    recallResults[button.dataset.feedbackScene] = result;
    renderResult();
  }));
  card.querySelector("#save-result").addEventListener("click", async () => {
    const finalUnits = bundle.scenes.map(scene => ({ sceneId: scene.id, ...currentResult(scene) }));
    const attempt = {
      id: CourseStore.id("attempt"),
      courseId: bundle.course.id,
      createdAt: new Date().toISOString(),
      studyDate: CourseStore.today(),
      durationSeconds: Math.round((Date.now() - startedAt) / 1000),
      score: total,
      units: finalUnits,
      sequenceCorrect: orderCorrect,
      weakSceneIds
    };
    const saved = await CourseStore.recordAttempt(attempt);
    card.querySelector("#save-result").disabled = true;
    const dates = [...new Set(saved.reviewSummary.map(item => item.nextReviewDate))].join("、");
    card.querySelector("#result-message").textContent = `已记录 ${saved.reviewSummary.length} 句反馈；下一次复习日期：${dates}。历史不会被同日学习覆盖。`;
  });
}

async function startCourse(courseId) {
  try {
    bundle = await CourseStore.getBundle(courseId);
    if (!bundle || bundle.course.status !== "published") {
      bundle = null;
      return;
    }
    await prepareImages();
    document.title = `${bundle.course.title} · 古诗记忆助手`;
    document.querySelector("#learner-home").hidden = true;
    document.querySelector("#learning-shell").hidden = false;
    setLearnerNavVisible(false);
    document.querySelector("#lesson-title").textContent = bundle.course.title;
    document.querySelector("#lesson-meta").textContent = [bundle.course.dynasty, bundle.course.author].filter(Boolean).join(" · ");
    startedAt = Date.now();
    sceneIndex = 0;
    recallResults = {};
    orderSelection = [];
    orderCorrect = false;
    setStage("understand");
  } catch (error) {
    console.error("无法打开课程", error);
    bundle = null;
    document.querySelector("#learning-shell").hidden = true;
    const home = document.querySelector("#learner-home");
    home.hidden = false;
    setLearnerNavVisible(true);
    home.innerHTML = `<section class="home-empty"><h3>课程暂时无法打开</h3><p>请返回备课端重试；本地课程数据没有被删除。</p><button class="primary-action" type="button" id="reload-course">重新打开</button></section>`;
    home.querySelector("#reload-course").addEventListener("click", () => startCourse(courseId));
  }
}

async function renderHome() {
  const [courses, due] = await Promise.all([CourseStore.list(CourseStore.stores.courses), CourseStore.dueCourses()]);
  const published = courses.filter(course => course.status === "published");
  const target = document.querySelector("#learner-home");
  setLearnerNavVisible(true);
  target.innerHTML = `<section class="home-hero"><p>古诗记忆助手</p><h1>今天背什么</h1><span>先理解画面，再背出课文。</span></section><section class="home-list"><h2>${due.length ? "今天要复习" : "可以开始学习"}</h2>${published.length ? published.map(course => `<article class="home-course"><div><p>${due.some(item => item.id === course.id) ? "到期复习" : "新课程"}</p><h3>${escapeHtml(course.title)}</h3><span>${escapeHtml([course.dynasty, course.author].filter(Boolean).join(" · "))}</span></div><button class="primary-action" type="button" data-start-course="${course.id}">${due.some(item => item.id === course.id) ? "开始复习" : "开始学习"}</button></article>`).join("") : `<div class="home-empty"><h3>还没有可学习的课程</h3><p>请让家长先在备课端完成原文校对并发布课程，图卡不是开始学习的必要条件。</p></div>`}</section>`;
  target.querySelectorAll("[data-start-course]").forEach(button => button.addEventListener("click", () => {
    history.replaceState(null, "", `?course=${encodeURIComponent(button.dataset.startCourse)}`);
    startCourse(button.dataset.startCourse);
  }));
}

function leaveLearning() {
  imageUrls.forEach(url => URL.revokeObjectURL(url));
  imageUrls = new Map();
  history.replaceState(null, "", location.pathname);
  document.querySelector("#learning-shell").hidden = true;
  document.querySelector("#learner-home").hidden = false;
  setLearnerNavVisible(true);
  renderHome();
}

document.querySelector("#leave-learning").addEventListener("click", leaveLearning);
const courseId = queryCourseId();
if (courseId) startCourse(courseId).then(() => { if (!bundle) renderHome(); });
else renderHome();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
