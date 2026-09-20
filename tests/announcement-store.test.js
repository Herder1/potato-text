const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryAnnouncementStore } = require("../apps/api/src/announcement-store");

test("announcement lifecycle controls public visibility", () => {
  const now = Date.parse("2026-08-04T12:00:00+08:00");
  const store = createMemoryAnnouncementStore([]);
  const draft = store.create({
    type: "功能更新",
    title: "刷题记录已同步",
    summary: "复习记录现在可在多个入口保持一致",
    content: "本次更新完善了错题重做后的状态同步。",
    priority: 20,
  });

  assert.equal(draft.status, "draft");
  assert.equal(store.publicList(now).length, 0);
  store.action(draft.id, "publish");
  assert.equal(store.publicList(now).length, 1);
  store.action(draft.id, "offline");
  assert.equal(store.publicList(now).length, 0);
});

test("announcement public list honors time windows and priority", () => {
  const now = Date.parse("2026-08-04T12:00:00+08:00");
  const store = createMemoryAnnouncementStore([]);
  const active = store.create({ type: "公告", title: "当前公告", summary: "当前可见", content: "正文", priority: 10, startsAt: now - 1000, endsAt: now + 1000 });
  const higher = store.create({ type: "公告", title: "置顶公告", summary: "优先展示", content: "正文", priority: 100 });
  const future = store.create({ type: "公告", title: "未来公告", summary: "稍后展示", content: "正文", priority: 999, startsAt: now + 1000 });
  const expired = store.create({ type: "公告", title: "过期公告", summary: "已经结束", content: "正文", priority: 999, endsAt: now - 1000 });
  [active, higher, future, expired].forEach((item) => store.action(item.id, "publish"));

  assert.deepEqual(store.publicList(now).map((item) => item.title), ["置顶公告", "当前公告"]);
  const counts = store.list({ now }).counts;
  assert.equal(counts.active, 2);
  assert.equal(counts.scheduled, 1);
});

test("announcement editing can clear display times and published items must be offline before deletion", () => {
  const store = createMemoryAnnouncementStore([]);
  const item = store.create({ type: "公告", title: "长期公告", summary: "摘要", content: "正文", startsAt: Date.now() + 5000 });
  const updated = store.update(item.id, { startsAt: null, endsAt: null });
  assert.equal(updated.startsAt, null);
  store.action(item.id, "publish");
  assert.throws(() => store.remove(item.id), /announcement_offline_before_delete/);
  store.action(item.id, "offline");
  assert.equal(store.remove(item.id).id, item.id);
});
