const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/docker-publish.yml"), "utf8");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const dockerignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8");

// Static contracts for this workflow; GitHub still validates and executes its YAML.
test("Docker publishing covers main pushes, version tags, PR checks and manual runs", () => {
  assert.match(workflow, /on:\s*\n  push:\s*\n    branches: \[main\]\s*\n    tags: \["v\*"\]/);
  assert.match(workflow, /\n  pull_request:\s*\n    branches: \[main\]/);
  assert.match(workflow, /\n  workflow_dispatch:/);
});

test("Docker publishing targets the existing GHCR package with traceable tags", () => {
  assert.match(workflow, /IMAGE_NAME: ghcr\.io\/herder1\/potato-text/);
  assert.match(workflow, /type=sha,format=long,prefix=sha-/);
  assert.match(workflow, /type=raw,value=latest,enable=\{\{is_default_branch\}\}/);
  assert.match(workflow, /context: \./);
  assert.match(workflow, /file: \.\/Dockerfile/);
});

test("Docker publishing uses the built-in token and does not publish PR builds", () => {
  assert.match(workflow, /\npermissions:\s*\n  contents: read/);
  assert.match(workflow, /permissions:\s*\n      contents: read\s*\n      packages: write/);
  assert.match(workflow, /password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(workflow, /name: Log in to GHCR\s*\n        if: github\.event_name != 'pull_request'/);
  assert.match(workflow, /push: \$\{\{ github\.event_name != 'pull_request' \}\}/);
  assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 2);
  assert.doesNotMatch(workflow, /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/);
});

test("Docker CI uses development auth and system Python without changing the production image", () => {
  assert.match(workflow, /NODE_ENV: development/);
  assert.match(workflow, /SHUKAO_PDF_PYTHON: \/usr\/bin\/python3/);
  // runner 是 UTC；日期分组与启动日期标签按本地日期计算，必须钉住产品时区。
  assert.match(workflow, /TZ: Asia\/Shanghai/);
  assert.match(workflow, /python3-reportlab fonts-noto-cjk fonts-wqy-zenhei/);
  assert.match(dockerfile, /ENV NODE_ENV=production/);
});

test("Docker publication summary identifies both the source commit and image digest", () => {
  assert.match(workflow, /name: Build and push\s*\n        id: build/);
  assert.match(workflow, /IMAGE_TAGS: \$\{\{ steps\.meta\.outputs\.tags \}\}/);
  assert.match(workflow, /IMAGE_DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}/);
  assert.match(workflow, /"\$GITHUB_SHA"/);
  assert.match(workflow, /"\$GITHUB_STEP_SUMMARY"/);
});

test("Docker context excludes local credentials and runtime data", () => {
  for (const entry of [".git", ".runtime", ".env", ".env.*", "tmp"]) {
    assert.ok(dockerignore.split(/\r?\n/).includes(entry), `${entry} must be excluded`);
  }
});
