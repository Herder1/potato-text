const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function normalizeSelectionRules(value, questionIds) {
  const allowedIds = new Set(questionIds);
  const usedIds = new Set();
  return (Array.isArray(value) ? value : []).slice(0, 20).map((rule, index) => {
    const ruleQuestionIds = [...new Set((Array.isArray(rule && rule.questionIds) ? rule.questionIds : [])
      .map(String).filter((id) => allowedIds.has(id)))];
    const requiredCount = Number(rule && rule.requiredCount);
    if (ruleQuestionIds.length < 2 || !Number.isInteger(requiredCount) || requiredCount < 1 || requiredCount >= ruleQuestionIds.length) {
      throw new Error("exam_selection_rule_invalid");
    }
    if (ruleQuestionIds.some((id) => usedIds.has(id))) throw new Error("exam_selection_rule_overlap");
    ruleQuestionIds.forEach((id) => usedIds.add(id));
    return {
      id: String(rule.id || `selection-rule-${index + 1}`).slice(0, 80),
      title: String(rule.title || `选答规则 ${index + 1}`).trim().slice(0, 100),
      requiredCount,
      questionIds: ruleQuestionIds,
      scoringOrder: "first_answered",
    };
  });
}

function seedExams() {
  const now = Date.now();
  return [{
    id: "exam-official-001",
    title: "汉语言文学学科基础综合测试",
    description: "覆盖五科基础知识，交卷或到时后统一显示答案与解析。",
    kind: "official_mock",
    year: 2026,
    questionIds: Array.from({ length: 10 }, (_, index) => `demo-modern-chinese-${String(index + 1).padStart(3, "0")}`),
    durationMinutes: 120,
    totalScore: 20,
    freePreviewQuestionCount: 10,
    status: "draft",
    attempts: 0,
    version: 1,
    versions: [{ version: 1, actor: "系统种子数据", note: "创建演示模拟卷", createdAt: now }],
    createdAt: now,
    updatedAt: now,
    createdBy: "系统种子数据",
    updatedBy: "系统种子数据",
  }];
}

function normalizeExam(payload, existing = null) {
  const title = String(payload.title ?? existing?.title ?? "").trim().slice(0, 120);
  const description = String(payload.description ?? existing?.description ?? "").trim().slice(0, 1000);
  const sourceLabel = String(payload.sourceLabel ?? existing?.sourceLabel ?? "").trim().slice(0, 120);
  const summary = String(payload.summary ?? existing?.summary ?? "").trim().slice(0, 300);
  const kind = ["official_mock", "past_paper"].includes(payload.kind ?? existing?.kind) ? (payload.kind ?? existing.kind) : "official_mock";
  const origin = (payload.origin ?? existing?.origin) === "imported" ? "imported" : "manual";
  const questionIds = [...new Set((Array.isArray(payload.questionIds) ? payload.questionIds : (existing?.questionIds || []))
    .map((item) => String(item).trim()).filter(Boolean))].slice(0, 300);
  const durationMinutes = Number(payload.durationMinutes ?? existing?.durationMinutes);
  const freePreviewQuestionCount = Math.max(0, Math.min(questionIds.length, Number(payload.freePreviewQuestionCount ?? existing?.freePreviewQuestionCount) || 0));
  const totalScore = Number(payload.totalScore ?? existing?.totalScore) || 0;
  const rawTotalScore = Number(payload.rawTotalScore ?? existing?.rawTotalScore) || totalScore;
  const calculatedTotalScore = Number(payload.calculatedTotalScore ?? existing?.calculatedTotalScore) || totalScore;
  const declaredTotalScore = Math.max(0, Number(payload.declaredTotalScore ?? existing?.declaredTotalScore) || 0);
  const selectionRules = normalizeSelectionRules(payload.selectionRules ?? existing?.selectionRules, questionIds);
  if (!title || !questionIds.length) throw new Error("exam_required_fields_missing");
  if (!Number.isFinite(durationMinutes) || durationMinutes < 10 || durationMinutes > 300) throw new Error("exam_duration_invalid");
  return { title, description, sourceLabel, summary, kind, origin, year: Math.max(2000, Math.min(2100, Number(payload.year ?? existing?.year) || new Date().getFullYear())), questionIds, durationMinutes, totalScore, rawTotalScore, calculatedTotalScore, declaredTotalScore, selectionRules, freePreviewQuestionCount };
}

function createExamStore(adapter) {
  const read = () => adapter.read().map(clone);
  const write = (items) => adapter.write(items.map(clone));
  return {
    exportState: () => clone(adapter.read()),
    replaceState(state) {
      if (!Array.isArray(state)) throw new Error("exam_state_invalid");
      write(state);
      return clone(adapter.read());
    },
    list(filters = {}) {
      const query = String(filters.query || "").trim().toLowerCase();
      const status = String(filters.status || "all");
      const kind = String(filters.kind || "all");
      const all = read();
      const exams = all.filter((item) => {
        if (status !== "all" && item.status !== status) return false;
        if (kind !== "all" && item.kind !== kind) return false;
        return !query || [item.title, item.description, item.id].join(" ").toLowerCase().includes(query);
      }).sort((left, right) => right.updatedAt - left.updatedAt);
      return { exams, counts: { total: all.length, draft: all.filter((item) => item.status === "draft").length, published: all.filter((item) => item.status === "published").length, offline: all.filter((item) => item.status === "offline").length } };
    },
    get(id) { const item = read().find((exam) => exam.id === id); return item ? clone(item) : null; },
    create(payload, actor = "超级管理员") {
      const exams = read();
      const now = Date.now();
      const exam = { id: String(payload.id || `exam-${crypto.randomUUID()}`), ...normalizeExam(payload), status: "draft", attempts: 0, version: 1, versions: [{ version: 1, actor, note: "创建试卷", createdAt: now }], createdAt: now, updatedAt: now, createdBy: actor, updatedBy: actor };
      write([exam, ...exams]);
      return clone(exam);
    },
    update(id, payload, actor = "超级管理员") {
      const exams = read();
      const index = exams.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("exam_not_found");
      const current = exams[index];
      const now = Date.now();
      const version = current.version + 1;
      exams[index] = { ...current, ...normalizeExam(payload, current), version, updatedAt: now, updatedBy: actor, versions: [{ version, actor, note: String(payload.changeNote || "编辑试卷").slice(0, 300), createdAt: now }, ...current.versions].slice(0, 50) };
      write(exams);
      return clone(exams[index]);
    },
    action(id, action, actor = "超级管理员") {
      const exams = read();
      const index = exams.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("exam_not_found");
      const statuses = { publish: "published", offline: "offline", restore: "draft" };
      if (!statuses[action]) throw new Error("exam_action_invalid");
      const current = exams[index];
      const now = Date.now();
      const version = current.version + 1;
      exams[index] = { ...current, status: statuses[action], version, updatedAt: now, updatedBy: actor, versions: [{ version, actor, note: ({ publish: "发布试卷", offline: "下架试卷", restore: "恢复为草稿" })[action], createdAt: now }, ...current.versions].slice(0, 50) };
      write(exams);
      return clone(exams[index]);
    },
    remove(id) {
      const exams = read();
      const index = exams.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("exam_not_found");
      if (exams[index].status !== "draft") throw new Error("exam_delete_status_invalid");
      const [removed] = exams.splice(index, 1);
      write(exams);
      return clone(removed);
    },
  };
}

function createFileExamStore(filePath = path.resolve(__dirname, "../../../.runtime/exams.json")) {
  return createExamStore({ read() { try { const value = JSON.parse(fs.readFileSync(filePath, "utf8")); return Array.isArray(value) ? value : seedExams(); } catch (error) { if (error.code !== "ENOENT") throw error; return seedExams(); } }, write(items) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); const temporaryPath = `${filePath}.tmp`; fs.writeFileSync(temporaryPath, `${JSON.stringify(items, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporaryPath, filePath); } });
}

function createMemoryExamStore(initialItems = seedExams()) { let items = clone(initialItems); return createExamStore({ read: () => clone(items), write: (next) => { items = clone(next); } }); }

module.exports = { createFileExamStore, createMemoryExamStore };
