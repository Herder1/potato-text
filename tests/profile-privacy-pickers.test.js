const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "apps", "miniprogram");

test("profile edit exposes both the avatar itself and the change-avatar pill", () => {
  const markup = fs.readFileSync(path.join(root, "pages", "profile-edit", "profile-edit.wxml"), "utf8");
  const style = fs.readFileSync(path.join(root, "pages", "profile-edit", "profile-edit.wxss"), "utf8");
  const pickers = markup.match(/<button[^>]*open-type="chooseAvatar"[^>]*>/g) || [];

  assert.equal(pickers.length, 2, "头像本体和「更换头像」胶囊都要能点开微信头像选择");
  pickers.forEach((tag) => assert.match(tag, /bindchooseavatar="chooseAvatar"/));
  assert.match(markup, /<input[^>]*type="nickname"[^>]*bindinput="inputNickname"/);
  assert.doesNotMatch(markup, /avatar-picker-button/, "不能再靠透明覆盖层接收点击");
  assert.doesNotMatch(markup, /avatar-change-button/, "胶囊必须由原生 button 自己接收点击");
  assert.match(markup, /<button class="avatar-picker"[^>]*open-type="chooseAvatar"/);
  assert.match(markup, /<button class="avatar-change"[^>]*open-type="chooseAvatar"/);
  assert.match(markup, /<view class="avatar-picker-wrap">\s*<button class="avatar-picker"/, "头像按钮必须放在显式居中的容器里");
  assert.match(style, /\.avatar-picker\s*\{[^}]*width:\s*152rpx[^}]*height:\s*152rpx/s);
  assert.match(style, /\.avatar-picker-wrap\s*\{[^}]*display:\s*flex[^}]*justify-content:\s*center/s);
  assert.match(style, /\.avatar-picker\s*\{[^}]*display:\s*flex[^}]*margin:\s*0 auto[^}]*align-items:\s*center[^}]*justify-content:\s*center/s);
  assert.match(style, /\.avatar-change\s*\{[^}]*display:\s*flex/s);
});

test("the mini program never replaces the native privacy dialog with an automatic agree", () => {
  const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.doesNotMatch(source, /onNeedPrivacyAuthorization/);
  assert.doesNotMatch(source, /setupPrivacyAuthorization/);
  assert.doesNotMatch(source, /resolve\(\{\s*event:\s*["']agree["']/);
});
