const test = require("node:test");
const assert = require("node:assert/strict");

const {
  API_BASE_URLS,
  DEVELOPMENT_API_BASE_URLS,
  PRODUCTION_API_BASE_URL,
  apiBaseUrlCandidates,
  detectEnvVersion,
  isLocalApiBaseUrl,
  normalizeEnvVersion,
  resolveApiBaseUrl,
} = require("../apps/miniprogram/utils/api-environment");

test("develop defaults to the local 127.0.0.1:3212 API", () => {
  assert.equal(resolveApiBaseUrl({ envVersion: "develop", apiBaseUrls: API_BASE_URLS }), "http://127.0.0.1:3212");
  assert.deepEqual(apiBaseUrlCandidates({
    envVersion: "develop",
    baseUrl: "http://127.0.0.1:3212",
    developmentApiBaseUrls: DEVELOPMENT_API_BASE_URLS,
  }), DEVELOPMENT_API_BASE_URLS);
});

test("develop accepts a stored local override", () => {
  assert.equal(resolveApiBaseUrl({
    envVersion: "develop",
    storedOverride: "http://localhost:3212/",
    apiBaseUrls: API_BASE_URLS,
  }), "http://localhost:3212");
  assert.deepEqual(apiBaseUrlCandidates({
    envVersion: "develop",
    baseUrl: "http://localhost:3212",
    developmentApiBaseUrls: ["http://127.0.0.1:3212", "http://localhost:3212"],
  }), ["http://localhost:3212", "http://127.0.0.1:3212"]);
});

test("trial and release ignore local overrides and development fallbacks", () => {
  const apiBaseUrls = { develop: "http://127.0.0.1:3212", trial: "https://trial.example.com", release: "https://api.example.com" };
  for (const envVersion of ["trial", "release"]) {
    assert.equal(resolveApiBaseUrl({
      envVersion,
      storedOverride: "http://127.0.0.1:3212",
      apiBaseUrls,
    }), apiBaseUrls[envVersion]);
    assert.deepEqual(apiBaseUrlCandidates({
      envVersion,
      baseUrl: apiBaseUrls[envVersion],
      developmentApiBaseUrls: DEVELOPMENT_API_BASE_URLS,
    }), [apiBaseUrls[envVersion]]);
  }
});

test("trial and release use the production HTTPS API", () => {
  assert.equal(PRODUCTION_API_BASE_URL, "https://hhtodo.cn");
  for (const envVersion of ["trial", "release"]) {
    assert.equal(resolveApiBaseUrl({
      envVersion,
      storedOverride: "http://127.0.0.1:3212",
      apiBaseUrls: API_BASE_URLS,
    }), PRODUCTION_API_BASE_URL);
    assert.deepEqual(apiBaseUrlCandidates({
      envVersion,
      baseUrl: PRODUCTION_API_BASE_URL,
      developmentApiBaseUrls: DEVELOPMENT_API_BASE_URLS,
    }), [PRODUCTION_API_BASE_URL]);
  }
});

test("explicitly unconfigured trial and release still fail closed", () => {
  for (const envVersion of ["trial", "release"]) {
    const apiBaseUrls = { develop: "http://127.0.0.1:3212", trial: "", release: "" };
    assert.equal(resolveApiBaseUrl({ envVersion, storedOverride: "http://127.0.0.1:3212", apiBaseUrls }), "");
    assert.deepEqual(apiBaseUrlCandidates({ envVersion, baseUrl: "", developmentApiBaseUrls: DEVELOPMENT_API_BASE_URLS }), []);
  }
});

test("unknown env versions fall back to develop", () => {
  assert.equal(normalizeEnvVersion("sandbox"), "develop");
  assert.equal(resolveApiBaseUrl({ envVersion: "sandbox", apiBaseUrls: API_BASE_URLS }), API_BASE_URLS.develop);
  assert.equal(detectEnvVersion({ getAccountInfoSync: () => ({ miniProgram: { envVersion: "trial" } }) }), "trial");
  assert.equal(detectEnvVersion({ getAccountInfoSync: () => { throw new Error("unsupported"); } }), "develop");
});

test("local address detection only classifies local development hosts", () => {
  assert.equal(isLocalApiBaseUrl("http://127.0.0.1:3212"), true);
  assert.equal(isLocalApiBaseUrl("http://192.168.2.178:3212"), true);
  assert.equal(isLocalApiBaseUrl("https://api.example.com"), false);
});
