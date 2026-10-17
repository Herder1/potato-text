const API_OVERRIDE_STORAGE_KEY = "shukao_api_base_url";

const DEVELOPMENT_API_BASE_URLS = [
  "http://127.0.0.1:3212",
  "http://192.168.2.178:3212",
  "http://192.168.2.179:3212",
];

const PRODUCTION_API_BASE_URL = "https://hhtodo.cn";

// Trial and release both use the production HTTPS API. An empty value still fails closed
// instead of silently sending a shipped build to a developer machine.
const API_BASE_URLS = Object.freeze({
  develop: DEVELOPMENT_API_BASE_URLS[0],
  trial: PRODUCTION_API_BASE_URL,
  release: PRODUCTION_API_BASE_URL,
});

function normalizeApiBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function isLocalApiBaseUrl(value) {
  const baseUrl = normalizeApiBaseUrl(value);
  return /^(?:https?:\/\/)(?:127\.0\.0\.1|localhost|192\.168\.\d{1,3}\.\d{1,3})(?::\d+)?(?:\/|$)/i.test(baseUrl);
}

function normalizeEnvVersion(value) {
  return ["develop", "trial", "release"].includes(String(value)) ? String(value) : "develop";
}

function detectEnvVersion(wxApi) {
  try {
    const info = wxApi && typeof wxApi.getAccountInfoSync === "function"
      ? wxApi.getAccountInfoSync()
      : null;
    return normalizeEnvVersion(info && info.miniProgram && info.miniProgram.envVersion);
  } catch (error) {
    return "develop";
  }
}

function resolveApiBaseUrl({ envVersion, storedOverride, apiBaseUrls = API_BASE_URLS } = {}) {
  const environment = normalizeEnvVersion(envVersion);
  const override = normalizeApiBaseUrl(storedOverride);
  if (environment === "develop" && override) return override;
  return normalizeApiBaseUrl(apiBaseUrls[environment]);
}

function apiBaseUrlCandidates({ envVersion, baseUrl, developmentApiBaseUrls = DEVELOPMENT_API_BASE_URLS } = {}) {
  const environment = normalizeEnvVersion(envVersion);
  const configured = normalizeApiBaseUrl(baseUrl);
  if (environment !== "develop") return configured ? [configured] : [];
  return [...new Set([configured, ...developmentApiBaseUrls.map(normalizeApiBaseUrl)].filter(Boolean))];
}

module.exports = {
  API_BASE_URLS,
  API_OVERRIDE_STORAGE_KEY,
  DEVELOPMENT_API_BASE_URLS,
  PRODUCTION_API_BASE_URL,
  apiBaseUrlCandidates,
  detectEnvVersion,
  isLocalApiBaseUrl,
  normalizeApiBaseUrl,
  normalizeEnvVersion,
  resolveApiBaseUrl,
};
