const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DOC_DEFINITIONS,
  createFilePlatformContentStore,
  createMemoryPlatformContentStore,
  seedPlatformContent,
} = require("../apps/api/src/platform-content-store");

const BODY = "第一条 本协议用于说明平台与用户之间的权利义务。\n第二条 用户在使用本平台服务前应完整阅读本协议。";

test("七份平台文档默认全部未发布，用户端拿不到任何正文", () => {
  const store = createMemoryPlatformContentStore(seedPlatformContent());

  assert.deepEqual(DOC_DEFINITIONS.map((item) => item.key), [
    "terms",
    "privacy",
    "ai-service",
    "refund",
    "account-deletion",
    "operator",
    "personal-info",
  ]);
  assert.deepEqual(store.definitions().map((item) => item.title), [
    "用户协议",
    "隐私政策",
    "AI 服务说明",
    "退款政策",
    "账号注销说明",
    "运营主体与客服信息",
    "个人信息收集清单",
  ]);
  assert.equal(store.publicList().length, 0, "没有任何已发布版本时清单必须为空");
  for (const definition of DOC_DEFINITIONS) {
    const document = store.publicDocument(definition.key);
    assert.equal(document.published, false, `${definition.key} 不能伪装成已发布`);
    assert.equal(document.status, "empty");
    assert.equal(Object.prototype.hasOwnProperty.call(document, "body"), false, "未发布时不得下发正文");
  }
  assert.equal(store.summaries().every((item) => item.status === "empty"), true);
});

test("新增版本永远是草稿，发布后才带版本号与生效日期", () => {
  const store = createMemoryPlatformContentStore(seedPlatformContent());
  const draft = store.saveVersion("terms", { version: "1.0", body: BODY, note: "生效日期待定稿" }, "超级管理员");

  assert.equal(draft.status, "draft");
  assert.equal(draft.effectiveDate, null);
  assert.equal(store.publicList().length, 0, "草稿不进用户端清单");
  assert.equal(store.publicDocument("terms").published, false);
  assert.equal(store.summaries().find((item) => item.key === "terms").status, "draft");

  assert.throws(() => store.publish("terms", "1.0"), /platform_content_effective_date_required/, "没有生效日期不允许发布");

  // 草稿可改写（2026-10-05 产品负责人选定「选项 A」）：同版本号重存＝更新草稿，历史里不新增第二条
  const revised = store.saveVersion("terms", { version: "1.0", body: `${BODY}\n第二条 草稿改写说明。`, note: "正文改过" }, "超级管理员");
  assert.equal(revised.status, "draft");
  assert.ok(revised.updatedAt > 0, "草稿改写要留时间戳");
  const draftHistory = store.history("terms").filter((item) => item.version === "1.0");
  assert.equal(draftHistory.length, 1, "改写草稿不新增历史条目");
  assert.match(draftHistory[0].body, /第二条 草稿改写说明/);
  assert.equal(draftHistory[0].note, "正文改过");

  // 发布时可补填生效日期（草稿常常"先存正文、后定生效日"）
  const firstPublish = store.publish("terms", "1.0", "超级管理员", { effectiveDate: "2026-10-09" });
  assert.equal(firstPublish.currentVersion, "1.0");
  assert.equal(firstPublish.effectiveDate, "2026-10-09");
  assert.equal(store.publicDocument("terms").effectiveDate, "2026-10-09", "补填的生效日期真的进了用户端");

  store.saveVersion("terms", { version: "1.1", body: `${BODY}\n第三条 生效日期以本页展示为准。`, effectiveDate: "2026-10-12" }, "超级管理员");
  const published = store.publish("terms", "1.1", "超级管理员");

  assert.equal(published.status, "published");
  assert.equal(published.currentVersion, "1.1");
  assert.equal(published.effectiveDate, "2026-10-12");
  const list = store.publicList();
  assert.deepEqual(list.map((item) => item.key), ["terms"]);
  assert.deepEqual(Object.keys(list[0]).sort(), ["effectiveDate", "group", "key", "publishedAt", "title", "version"]);

  const detail = store.publicDocument("terms");
  assert.equal(detail.published, true);
  assert.equal(detail.version, "1.1");
  assert.equal(detail.effectiveDate, "2026-10-12");
  assert.match(detail.body, /第三条 生效日期以本页展示为准/);
});

test("重存草稿：正文与备注可改，留空生效日期沿用原值（不悄悄清掉）", () => {
  const store = createMemoryPlatformContentStore(seedPlatformContent());
  const first = store.saveVersion("terms", { version: "1.2", body: "草稿正文", effectiveDate: "2026-11-05", note: "初稿" }, "超级管理员");

  const kept = store.saveVersion("terms", { version: "1.2", body: "草稿正文（改过）", note: "改过备注" }, "超级管理员");
  assert.equal(kept.effectiveDate, "2026-11-05", "重存草稿不该清掉原本已定的生效日期");
  assert.equal(kept.body, "草稿正文（改过）");
  assert.equal(kept.note, "改过备注");
  assert.equal(kept.createdAt, first.createdAt, "创建时间不变");
  assert.ok(kept.updatedAt > 0, "改写要留更新时间");

  const replaced = store.saveVersion("terms", { version: "1.2", body: "草稿正文（再改）", effectiveDate: "2026-11-20" }, "超级管理员");
  assert.equal(replaced.effectiveDate, "2026-11-20", "显式填新日期就换成新日期");

  const history = store.history("terms");
  assert.equal(history.filter((item) => item.version === "1.2").length, 1, "重存不新增版本条目");
  assert.equal(history[0].body, "草稿正文（再改）");
});

test("已发布版本不可改写：同版本号再存被拒，发新版只把旧版转 retired 且原文保留", () => {
  const store = createMemoryPlatformContentStore(seedPlatformContent());
  store.saveVersion("privacy", { version: "1.0", body: "旧版正文", effectiveDate: "2026-10-01" }, "超级管理员");
  store.publish("privacy", "1.0", "超级管理员");

  assert.throws(
    () => store.saveVersion("privacy", { version: "1.0", body: "想覆盖旧版", effectiveDate: "2026-10-02" }, "超级管理员"),
    /platform_content_version_conflict/,
  );

  store.saveVersion("privacy", { version: "2.0", body: "新版正文", effectiveDate: "2026-11-01" }, "超级管理员");
  store.publish("privacy", "2.0", "超级管理员");

  const history = store.history("privacy");
  assert.deepEqual(history.map((item) => item.version), ["2.0", "1.0"], "历史按新到旧列出，旧版不消失");
  assert.equal(history[1].status, "retired");
  assert.equal(history[1].effectiveDate, "2026-10-01");
  assert.ok(history[1].retiredAt > 0, "旧版要记下失效时间");
  assert.equal(history[1].firstPublishedAt, history[1].publishedAt, "首次发布时间要留痕（回滚后可追溯）");
  assert.equal(store.publicDocument("privacy").body, "新版正文", "用户端只读到当前已发布版本");

  const state = store.exportState();
  const record = state.documents.privacy.versions.find((item) => item.version === "1.0");
  assert.equal(record.body, "旧版正文", "旧版正文必须原样保留在存储里");
});

test("回滚（重新发布旧版）不改写旧版正文、生效日期与首次发布时间", () => {
  const store = createMemoryPlatformContentStore(seedPlatformContent());
  store.saveVersion("privacy", { version: "1.0", body: "旧版正文", effectiveDate: "2026-10-01" }, "超级管理员");
  store.publish("privacy", "1.0", "超级管理员");
  const firstPublishedAt = store.history("privacy")[0].firstPublishedAt;
  assert.ok(firstPublishedAt > 0);
  store.saveVersion("privacy", { version: "2.0", body: "新版正文", effectiveDate: "2026-11-01" }, "超级管理员");
  store.publish("privacy", "2.0", "超级管理员");

  const rolledBack = store.publish("privacy", "1.0", "超级管理员", { effectiveDate: "2026-12-31" });
  assert.equal(rolledBack.currentVersion, "1.0");
  assert.equal(rolledBack.effectiveDate, "2026-10-01", "曾发布版本的生效日期不可被改写");

  const afterRollback = store.history("privacy");
  const rollbackOld = afterRollback.find((item) => item.version === "1.0");
  const rollbackNew = afterRollback.find((item) => item.version === "2.0");
  assert.equal(rollbackOld.status, "published");
  assert.equal(rollbackOld.body, "旧版正文", "回滚版本正文仍是当初那一版");
  assert.equal(rollbackOld.firstPublishedAt, firstPublishedAt, "回滚不改写首次发布时间");
  assert.equal(rollbackOld.retiredAt, null, "重新发布后不再标失效");
  assert.equal(rollbackNew.status, "retired", "被替换下来的 2.0 转 retired，不删除");
  assert.equal(rollbackNew.effectiveDate, "2026-11-01", "2.0 的生效日期也不改写");
  assert.equal(store.publicDocument("privacy").version, "1.0", "用户端读回滚后的版本");
});

test("下架只把当前版转 retired，不删除历史，也不影响其它文档", () => {
  const store = createMemoryPlatformContentStore(seedPlatformContent());
  store.saveVersion("refund", { version: "1.0", body: "退款正文", effectiveDate: "2026-10-05" }, "超级管理员");
  store.publish("refund", "1.0", "超级管理员");
  store.saveVersion("operator", { version: "1.0", body: "运营主体正文", effectiveDate: "2026-10-05" }, "超级管理员");
  store.publish("operator", "1.0", "超级管理员");

  const summary = store.unpublish("refund");
  assert.equal(summary.status, "draft", "下架后回到「有版本但未发布」");
  assert.equal(summary.currentVersion, null);
  assert.equal(store.publicDocument("refund").published, false);
  assert.equal(store.history("refund").length, 1, "下架不删版本");
  assert.throws(() => store.unpublish("refund"), /platform_content_not_published/);
  assert.equal(store.publicDocument("operator").published, true, "其它文档不受影响");
});

test("版本号与正文校验、未知文档、非法生效日期都有明确错误码", () => {
  const store = createMemoryPlatformContentStore(seedPlatformContent());

  assert.throws(() => store.publicDocument("not-a-doc"), /platform_content_unknown_document/);
  assert.throws(() => store.saveVersion("terms", { version: "", body: BODY }), /platform_content_version_required/);
  assert.throws(() => store.saveVersion("terms", { version: "1.0", body: "   " }), /platform_content_body_required/);
  assert.throws(() => store.saveVersion("terms", { version: "x".repeat(41), body: BODY }), /platform_content_version_too_long/);
  assert.throws(() => store.saveVersion("terms", { version: "1.0", body: "长".repeat(200001) }), /platform_content_body_too_long/);
  assert.throws(() => store.saveVersion("terms", { version: "1.0", body: BODY, effectiveDate: "不是日期" }), /platform_content_effective_date_invalid/);
  assert.throws(() => store.publish("terms", "9.9"), /platform_content_version_not_found/);

  const record = store.saveVersion("terms", { version: "1.0", body: `  ${BODY}  `, effectiveDate: "2026-10-05" }, "超级管理员");
  assert.equal(record.body, BODY, "正文两侧空白被清掉");
  assert.equal(record.createdBy, "超级管理员");
});

test("replaceState 归一化：固定七份、多出来的已发布版降级、往返一致", () => {
  const store = createMemoryPlatformContentStore(seedPlatformContent());
  store.saveVersion("ai-service", { version: "1.0", body: "AI 说明 v1", effectiveDate: "2026-10-05" }, "超级管理员");
  store.publish("ai-service", "1.0", "超级管理员");
  const exported = store.exportState();

  const other = createMemoryPlatformContentStore(seedPlatformContent());
  other.replaceState(exported);
  assert.deepEqual(other.exportState(), exported, "往返后状态一致");
  assert.equal(other.publicDocument("ai-service").published, true);

  // 损坏状态：两份都标 published，但没有 currentVersion → 只保留一份作为当前版本。
  const broken = JSON.parse(JSON.stringify(exported));
  broken.documents["ai-service"].versions.push({ version: "0.9", body: "旧版", effectiveDate: "2026-09-01", status: "published" });
  broken.documents["ai-service"].currentVersion = null;
  const repaired = other.replaceState(broken);
  assert.equal(repaired.documents["ai-service"].currentVersion, "1.0", "取版本数组里第一个已发布版");
  assert.equal(other.history("ai-service").filter((item) => item.status === "published").length, 1, "同时只能有一版已发布");
  assert.deepEqual(Object.keys(repaired.documents).sort(), DOC_DEFINITIONS.map((item) => item.key).sort());
});

test("文件 store：落盘为 LF 无 BOM、重载一致、临时文件不残留", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "platform-content-"));
  const filePath = path.join(directory, "platform-content.json");
  try {
    const store = createFilePlatformContentStore(filePath);
    assert.equal(store.publicList().length, 0, "文件不存在时给空骨架，不预置假协议");

    store.saveVersion("account-deletion", { version: "1.0", body: "注销说明正文", effectiveDate: "2026-10-05" }, "超级管理员");
    store.publish("account-deletion", "1.0", "超级管理员");

    const buffer = fs.readFileSync(filePath);
    assert.notDeepEqual([...buffer.subarray(0, 3)], [239, 187, 191], "不得有 UTF-8 BOM");
    assert.equal(buffer.includes(Buffer.from("\r\n")), false, "仓库文本一律 LF");
    assert.equal(fs.existsSync(`${filePath}.tmp`), false, "临时文件必须被 rename 掉");

    const reloaded = createFilePlatformContentStore(filePath);
    assert.deepEqual(reloaded.exportState(), store.exportState());
    assert.equal(reloaded.publicDocument("account-deletion").body, "注销说明正文");
    assert.equal(reloaded.summaries().find((item) => item.key === "terms").status, "empty");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
