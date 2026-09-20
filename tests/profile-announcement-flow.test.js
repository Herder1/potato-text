const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function createReviewPage() {
  let definition;
  global.Page = (value) => { definition = value; };
  const modulePath = require.resolve("../apps/miniprogram/pages/review/review.js");
  delete require.cache[modulePath];
  require(modulePath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch) {
    Object.assign(this.data, patch);
  };
  return page;
}

test("review announcement opens, closes, and follows the swiper index", () => {
  const page = createReviewPage();
  assert.ok(page.data.announcements.length >= 2);
  assert.equal(page.data.announcementOpen, false);

  page.openAnnouncement();
  assert.equal(page.data.announcementOpen, true);

  page.changeAnnouncement({ detail: { current: 1 } });
  assert.equal(page.data.announcementIndex, 1);
  assert.equal(page.data.activeAnnouncement.id, page.data.announcements[1].id);

  page.closeAnnouncement();
  assert.equal(page.data.announcementOpen, false);
  delete global.Page;
});

test("profile page no longer draws a top navigation title", () => {
  // 产品负责人 2026-09-19：我的页顶部居中的“我的”标题整块移除（自定义导航栏只留占位高度）。
  const pageDir = path.join(__dirname, "../apps/miniprogram/pages/profile");
  const config = JSON.parse(fs.readFileSync(path.join(pageDir, "profile.json"), "utf8"));
  const markup = fs.readFileSync(path.join(pageDir, "profile.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(pageDir, "profile.wxss"), "utf8");

  assert.equal(config.navigationStyle, "custom");
  assert.equal(config.navigationBarTitleText, "");
  assert.doesNotMatch(markup, /profile-nav-title/);
  assert.doesNotMatch(styles, /profile-nav-title/);
  assert.doesNotMatch(markup, />\s*我的\s*</);
  assert.match(markup, /class="profile-nav" style="height: \{\{navTotalHeight\}\}px/);
});

test("compact announcement bar is above review and removed from profile", () => {
  const reviewMarkup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/review/review.wxml"), "utf8");
  const reviewStyles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/review/review.wxss"), "utf8");
  const profileMarkup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/profile/profile.wxml"), "utf8");
  assert.match(reviewMarkup, /class="announcement-bar"/);
  assert.match(reviewMarkup, /class="announcement-swiper"/);
  assert.ok(reviewMarkup.indexOf('class="announcement-bar"') > reviewMarkup.indexOf('class="review-nav-spacer"'));
  assert.doesNotMatch(reviewMarkup, /class="page-heading"/);
  assert.doesNotMatch(profileMarkup, /class="announcement-bar"/);
  assert.doesNotMatch(profileMarkup, /class="announcement-swiper"/);
  assert.match(reviewStyles, /\.announcement-layer\s*\{[^}]*top:\s*0;[^}]*right:\s*0;[^}]*bottom:\s*0;[^}]*left:\s*0;/s);
  assert.doesNotMatch(reviewStyles, /\.announcement-layer\s*\{[^}]*\binset:/s);
});
