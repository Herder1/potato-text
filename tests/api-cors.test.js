const test = require("node:test");
const assert = require("node:assert/strict");

const { corsHeadersForRequest } = require("../apps/api/src/server");

function request(origin) {
  return { headers: origin ? { origin } : {} };
}

test("production denies cross-origin requests when no allowlist is configured", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousOrigins = process.env.CORS_ALLOWED_ORIGINS;
  process.env.NODE_ENV = "production";
  delete process.env.CORS_ALLOWED_ORIGINS;
  try {
    assert.deepEqual(corsHeadersForRequest(request("https://example.com")), {});
    assert.deepEqual(corsHeadersForRequest(request()), {});
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousOrigins === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = previousOrigins;
  }
});

test("production allows only explicitly configured browser origins", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousOrigins = process.env.CORS_ALLOWED_ORIGINS;
  process.env.NODE_ENV = "production";
  process.env.CORS_ALLOWED_ORIGINS = "https://hhtodo.cn";
  try {
    assert.deepEqual(corsHeadersForRequest(request("https://hhtodo.cn")), {
      "Access-Control-Allow-Origin": "https://hhtodo.cn",
      Vary: "Origin",
    });
    assert.deepEqual(corsHeadersForRequest(request("https://evil.example")), {});
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousOrigins === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = previousOrigins;
  }
});

test("local development retains the permissive CORS baseline", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    assert.deepEqual(corsHeadersForRequest(request("https://example.com")), {
      "Access-Control-Allow-Origin": "*",
      Vary: "Origin",
    });
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
