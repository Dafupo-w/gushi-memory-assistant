const CourseStore = (() => {
  const DB_NAME = "classical-text-memory-db";
  const DB_VERSION = 1;
  const STORES = {
    courses: "courses",
    sources: "sources",
    scenes: "scenes",
    assets: "assets",
    attempts: "attempts",
    reviews: "reviews"
  };
  // MVP 暂定间隔：0 代表首次学习当天。它是可调整的产品规则，不是科学精确的遗忘曲线。
  const REVIEW_INTERVALS = [0, 1, 2, 4, 7, 14, 30];
  const FEEDBACK = { remembered: "记住了", hesitant: "有点卡", forgotten: "忘记了" };

  function id(prefix) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("本地数据操作失败。"));
    });
  }

  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORES.courses)) db.createObjectStore(STORES.courses, { keyPath: "id" });
        if (!db.objectStoreNames.contains(STORES.sources)) {
          const store = db.createObjectStore(STORES.sources, { keyPath: "id" });
          store.createIndex("courseId", "courseId");
        }
        if (!db.objectStoreNames.contains(STORES.scenes)) {
          const store = db.createObjectStore(STORES.scenes, { keyPath: "id" });
          store.createIndex("courseId", "courseId");
          store.createIndex("courseOrder", ["courseId", "order"]);
        }
        if (!db.objectStoreNames.contains(STORES.assets)) db.createObjectStore(STORES.assets, { keyPath: "id" });
        if (!db.objectStoreNames.contains(STORES.attempts)) {
          const store = db.createObjectStore(STORES.attempts, { keyPath: "id" });
          store.createIndex("courseId", "courseId");
          store.createIndex("courseCreated", ["courseId", "createdAt"]);
        }
        if (!db.objectStoreNames.contains(STORES.reviews)) {
          const store = db.createObjectStore(STORES.reviews, { keyPath: "id" });
          store.createIndex("courseId", "courseId");
          store.createIndex("dueAt", "dueAt");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开本地课程库。"));
    });
  }

  async function get(storeName, key) {
    const db = await open();
    try {
      return await requestResult(db.transaction(storeName, "readonly").objectStore(storeName).get(key));
    } finally {
      db.close();
    }
  }

  async function list(storeName) {
    const db = await open();
    try {
      return await requestResult(db.transaction(storeName, "readonly").objectStore(storeName).getAll());
    } finally {
      db.close();
    }
  }

  async function listByIndex(storeName, indexName, value) {
    const db = await open();
    try {
      const index = db.transaction(storeName, "readonly").objectStore(storeName).index(indexName);
      return await requestResult(index.getAll(value));
    } finally {
      db.close();
    }
  }

  async function put(storeName, value) {
    const db = await open();
    try {
      await requestResult(db.transaction(storeName, "readwrite").objectStore(storeName).put(value));
      return value;
    } finally {
      db.close();
    }
  }

  async function remove(storeName, key) {
    const db = await open();
    try {
      await requestResult(db.transaction(storeName, "readwrite").objectStore(storeName).delete(key));
    } finally {
      db.close();
    }
  }

  function today() {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function addDays(value, days) {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(year, month - 1, day, 12);
    date.setDate(date.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  async function saveCourse(course) {
    return put(STORES.courses, { ...course, updatedAt: new Date().toISOString() });
  }

  async function createCourse(values) {
    const now = new Date().toISOString();
    const course = {
      id: id("course"),
      title: values.title.trim(),
      author: values.author.trim(),
      dynasty: values.dynasty.trim(),
      grade: values.grade.trim(),
      fullText: values.fullText.trim(),
      sourceStatus: "待校对",
      status: "draft",
      createdAt: now,
      updatedAt: now,
      publishedAt: null
    };
    return saveCourse(course);
  }

  async function saveSource(courseId, source) {
    return put(STORES.sources, {
      id: source.id || id("source"),
      courseId,
      fileName: source.fileName || null,
      kind: source.kind || "pasted",
      extractedText: source.extractedText || "",
      sourceUrl: source.sourceUrl || null,
      confirmedText: source.confirmedText || "",
      confirmedAt: source.confirmedAt || null,
      createdAt: source.createdAt || new Date().toISOString()
    });
  }

  async function saveScenes(courseId, scenes) {
    const existing = await listByIndex(STORES.scenes, "courseId", courseId);
    await Promise.all(existing.map(scene => remove(STORES.scenes, scene.id)));
    await Promise.all(scenes.map(scene => put(STORES.scenes, { ...scene, id: scene.id || id("scene"), courseId })));
  }

  async function saveAsset(file) {
    const asset = {
      id: id("asset"),
      type: file.type || "image/png",
      name: file.name || "图卡",
      blob: file,
      createdAt: new Date().toISOString()
    };
    return put(STORES.assets, asset);
  }

  async function getBundle(courseId) {
    const course = await get(STORES.courses, courseId);
    if (!course) return null;
    const [sources, scenes] = await Promise.all([
      listByIndex(STORES.sources, "courseId", courseId),
      listByIndex(STORES.scenes, "courseId", courseId)
    ]);
    return { course, sources, scenes: scenes.sort((a, b) => a.order - b.order) };
  }

  async function publish(courseId) {
    const bundle = await getBundle(courseId);
    if (!bundle) throw new Error("课程不存在。");
    if (!bundle.course.fullText || bundle.course.sourceStatus !== "已校对") {
      throw new Error("请先完成教材原文校对。 ");
    }
    if (bundle.scenes.length < 2) throw new Error("至少需要两个记忆意群才能发布课程。 ");
    return saveCourse({ ...bundle.course, status: "published", publishedAt: new Date().toISOString() });
  }

  function feedbackForUnit(unit) {
    if (Object.prototype.hasOwnProperty.call(FEEDBACK, unit.feedback)) return unit.feedback;
    if (unit.correct && unit.hints === 0) return "remembered";
    if (unit.correct || unit.hints > 0) return "hesitant";
    return "forgotten";
  }

  function reviewStateId(courseId, sceneId) {
    return `review-state-${courseId}-${sceneId}`;
  }

  function predictionPlan(firstDate, stage, nextDate) {
    const plan = [{ stage: 0, intervalDays: 0, date: firstDate, label: "首次学习" }];
    let cursor = nextDate;
    let currentStage = Math.max(0, Math.min(REVIEW_INTERVALS.length - 1, Number(stage) || 0));
    if (!cursor) cursor = addDays(firstDate, REVIEW_INTERVALS[currentStage]);
    if (cursor !== firstDate || currentStage !== 0) {
      plan.push({ stage: currentStage, intervalDays: REVIEW_INTERVALS[currentStage], date: cursor, label: "当前下一次" });
    }
    for (let nextStage = currentStage + 1; nextStage < REVIEW_INTERVALS.length; nextStage += 1) {
      cursor = addDays(cursor, REVIEW_INTERVALS[nextStage]);
      plan.push({ stage: nextStage, intervalDays: REVIEW_INTERVALS[nextStage], date: cursor, label: "若下次记住了" });
    }
    return plan;
  }

  function nextReviewForFeedback(feedback, stage, date) {
    const before = Math.max(0, Math.min(REVIEW_INTERVALS.length - 1, Number(stage) || 0));
    let after = before;
    let days = 1;
    let reason = "";
    if (feedback === "remembered") {
      after = Math.min(REVIEW_INTERVALS.length - 1, before + 1);
      days = REVIEW_INTERVALS[after];
      reason = "记住了，进入下一阶段";
    } else if (feedback === "hesitant") {
      after = before;
      days = Math.max(1, REVIEW_INTERVALS[after]);
      reason = "有点卡，保持阶段并尽快复习";
    } else {
      after = Math.max(0, before - 1);
      days = 1;
      reason = "忘记了，退回短间隔并安排次日复习";
    }
    return { before, after, days, dueAt: addDays(date, days), reason };
  }

  async function recordAttempt(attempt) {
    const reviewedDate = attempt.studyDate || today();
    const createdAt = attempt.createdAt || new Date().toISOString();
    const existing = await listByIndex(STORES.reviews, "courseId", attempt.courseId);
    const states = new Map(existing.filter(item => item.kind === "state").map(item => [item.sceneId, item]));
    const priorTasks = existing.filter(item => item.kind !== "state");
    const safeUnits = Array.isArray(attempt.units) ? attempt.units : [];
    const tasks = [];
    const stateSummaries = [];

    await put(STORES.attempts, { ...attempt, createdAt, studyDate: reviewedDate });
    for (const unit of safeUnits) {
      const feedback = feedbackForUnit(unit);
      const previous = states.get(unit.sceneId);
      const firstLearnedAt = previous?.firstLearnedAt || reviewedDate;
      const transition = nextReviewForFeedback(feedback, previous?.stage ?? previous?.currentStage ?? 0, reviewedDate);
      const historyEntry = {
        id: id("feedback"),
        attemptId: attempt.id,
        date: reviewedDate,
        createdAt,
        feedback,
        feedbackLabel: FEEDBACK[feedback],
        strictCorrect: Boolean(unit.correct),
        attempts: Number(unit.attempts) || 0,
        hints: Number(unit.hints) || 0,
        sequenceCorrect: Boolean(attempt.sequenceCorrect),
        score: Number(attempt.score) || 0,
        stageBefore: transition.before,
        stageAfter: transition.after,
        nextReviewDate: transition.dueAt,
        reason: transition.reason
      };
      const history = [...(previous?.history || previous?.feedbackHistory || []), historyEntry];
      const state = {
        id: previous?.id || reviewStateId(attempt.courseId, unit.sceneId),
        kind: "state",
        courseId: attempt.courseId,
        sceneId: unit.sceneId,
        firstLearnedAt,
        stage: transition.after,
        currentStage: transition.after,
        intervalDays: REVIEW_INTERVALS[transition.after],
        nextReviewDate: transition.dueAt,
        lastFeedback: feedback,
        lastFeedbackLabel: FEEDBACK[feedback],
        lastReviewedAt: createdAt,
        history,
        feedbackHistory: history,
        plan: predictionPlan(firstLearnedAt, transition.after, transition.dueAt),
        updatedAt: createdAt,
        status: "pending"
      };
      states.set(unit.sceneId, state);
      await put(STORES.reviews, state);

      // 同一句再次学习不会覆盖旧任务：旧任务标记为 superseded，反馈历史和本次任务都保留。
      await Promise.all(priorTasks.filter(task => task.sceneId === unit.sceneId && task.status === "pending").map(task => put(STORES.reviews, { ...task, status: "superseded", supersededAt: createdAt })));
      const task = {
        id: id("review"),
        kind: "task",
        courseId: attempt.courseId,
        sceneId: unit.sceneId,
        dueAt: transition.dueAt,
        nextReviewDate: transition.dueAt,
        firstLearnedAt,
        stage: transition.after,
        intervalDays: REVIEW_INTERVALS[transition.after],
        feedback,
        feedbackLabel: FEEDBACK[feedback],
        reason: transition.reason,
        status: "pending",
        reviewStateId: state.id,
        historyEntryId: historyEntry.id,
        createdAt
      };
      tasks.push(task);
      stateSummaries.push({ sceneId: unit.sceneId, feedback, feedbackLabel: FEEDBACK[feedback], nextReviewDate: transition.dueAt, stage: transition.after });
    }
    await Promise.all(tasks.map(task => put(STORES.reviews, task)));
    return { ...attempt, createdAt, studyDate: reviewedDate, reviewSummary: stateSummaries };
  }

  async function reports(courseId) {
    const [attempts, reviews] = await Promise.all([
      listByIndex(STORES.attempts, "courseId", courseId),
      listByIndex(STORES.reviews, "courseId", courseId)
    ]);
    return {
      attempts: attempts.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      reviews: reviews.filter(review => review.kind !== "state").sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.createdAt.localeCompare(b.createdAt)),
      reviewStates: reviews.filter(review => review.kind === "state").sort((a, b) => a.sceneId.localeCompare(b.sceneId))
    };
  }

  async function dueCourses() {
    const [courses, reviews] = await Promise.all([list(STORES.courses), list(STORES.reviews)]);
    const due = today();
    const ids = new Set(reviews.filter(review => review.kind !== "state" && review.status === "pending" && review.dueAt <= due).map(review => review.courseId));
    return courses.filter(course => course.status === "published" && ids.has(course.id));
  }

  async function deleteCourse(courseId) {
    const bundle = await getBundle(courseId);
    const [attempts, reviews] = await Promise.all([
      listByIndex(STORES.attempts, "courseId", courseId),
      listByIndex(STORES.reviews, "courseId", courseId)
    ]);
    await Promise.all([
      ...bundle.sources.map(item => remove(STORES.sources, item.id)),
      ...bundle.scenes.map(item => remove(STORES.scenes, item.id)),
      ...attempts.map(item => remove(STORES.attempts, item.id)),
      ...reviews.map(item => remove(STORES.reviews, item.id)),
      ...bundle.scenes.filter(item => item.imageAssetId).map(item => remove(STORES.assets, item.imageAssetId)),
      remove(STORES.courses, courseId)
    ]);
  }

  async function exportAll() {
    const [courses, sources, scenes, attempts, reviews] = await Promise.all([
      list(STORES.courses), list(STORES.sources), list(STORES.scenes), list(STORES.attempts), list(STORES.reviews)
    ]);
    return { version: 1, exportedAt: new Date().toISOString(), courses, sources, scenes, attempts, reviews };
  }

  return {
    id, today, addDays, get, list, put, remove,
    createCourse, saveCourse, saveSource, saveScenes, saveAsset,
    getBundle, publish, recordAttempt, reports, dueCourses, deleteCourse, exportAll,
    reviewIntervals: REVIEW_INTERVALS, feedbackLabels: FEEDBACK,
    stores: STORES
  };
})();
