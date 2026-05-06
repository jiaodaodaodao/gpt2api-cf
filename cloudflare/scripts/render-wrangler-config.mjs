import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const cwd = process.cwd();
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 ? args[outputIndex + 1] : "wrangler.local.toml";
const sha = process.env.GITHUB_SHA || process.env.BUILD_SHA || "local";

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const result = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function pick(name, fallbackName = `CF_${name}`) {
  return process.env[fallbackName] || process.env[name] || localEnv[fallbackName] || localEnv[name] || "";
}

function requireHttpUrl(name, value) {
  if (!value || value.includes("example.com")) {
    throw new Error(`请先配置 ${name}，不要使用 example.com 占位值`);
  }
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} 必须是 http(s) URL`);
  }
  return url.toString().replace(/\/$/, "");
}

function escapeTomlString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const localEnv = {
  ...parseEnvFile(resolve(cwd, ".env")),
  ...parseEnvFile(resolve(cwd, ".env.local")),
};

const values = {
  USER_WEB_ORIGIN: requireHttpUrl("CF_USER_WEB_ORIGIN", pick("USER_WEB_ORIGIN")),
  ADMIN_WEB_ORIGIN: requireHttpUrl("CF_ADMIN_WEB_ORIGIN", pick("ADMIN_WEB_ORIGIN")),
  USER_API_ORIGIN: requireHttpUrl("CF_USER_API_ORIGIN", pick("USER_API_ORIGIN")),
  ADMIN_API_ORIGIN: requireHttpUrl("CF_ADMIN_API_ORIGIN", pick("ADMIN_API_ORIGIN")),
  OPENAI_API_ORIGIN: requireHttpUrl("CF_OPENAI_API_ORIGIN", pick("OPENAI_API_ORIGIN")),
  ADMIN_HOST: pick("ADMIN_HOST"),
  CORS_ALLOW_ORIGINS: pick("CORS_ALLOW_ORIGINS") || "*",
  BUILD_SHA: sha,
};

const template = readFileSync(resolve(cwd, "wrangler.toml"), "utf8");
let rendered = template;
for (const [key, value] of Object.entries(values)) {
  const pattern = new RegExp(`^${key}\\s*=\\s*"[^"]*"\\s*$`, "m");
  if (!pattern.test(rendered)) {
    throw new Error(`wrangler.toml 缺少变量 ${key}`);
  }
  rendered = rendered.replace(pattern, `${key} = "${escapeTomlString(value)}"`);
}

writeFileSync(resolve(cwd, output), rendered, "utf8");
console.log(`已生成 ${output}`);
