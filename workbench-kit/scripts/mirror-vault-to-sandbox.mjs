#!/usr/bin/env node
/**
 * mirror-vault-to-sandbox.mjs
 * ---------------------------------------------------------------------------
 * 【可选，非主线方案】把一个 Markdown Vault 镜像到项目内的沙箱目录，并改写
 * Workbench/.env，让 Workbench 读沙箱而不是读原 Vault。
 *
 * ⚠️ 为什么它不是主线方案
 *   沙箱是**一次性快照**：镜像完成后，Vault 里的改动不再被监听。
 *   症状是"知识库天天更新，但站点数据不动"，而且很难一眼看出原因。
 *   主线应该让 Workbench **直读** Vault，用排除规则解决污染问题。
 *
 *   只在下面这种场景才用它：你需要把 Vault 和 Workbench 做**强隐私隔离**，
 *   且能接受"每次改完笔记手动重跑一次镜像"。
 *
 * 用法
 *   node scripts/mirror-vault-to-sandbox.mjs --vault <path> [--force]
 *
 *   --vault <path>   源 Vault 根目录（必填；也可用环境变量 VAULT_SOURCE）
 *   --force          先清空已有沙箱再重新镜像
 *
 * 安全性
 *   本脚本对源 Vault **只读**，只从源拷贝、只往项目自己的 .workbuddy/ 里写。
 *
 * 退出码
 *   0 = 镜像成功；1 = 源路径缺失或镜像失败；2 = 沙箱写入被拒
 * ---------------------------------------------------------------------------
 */

import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const workbenchDir = process.cwd();
const projectRoot = path.resolve(workbenchDir, "..");
const sandboxRoot = path.join(projectRoot, ".workbuddy", "_om", "_vault-ro");

// 镜像期排除规则。运行时 Workbench 也有一份（来自 .env 的 VAULT_EXCLUDES），
// 但镜像期先排除可以省掉文件拷贝成本，且让沙箱保持干净。
// 两处规则应保持一致，避免沙箱比运行时"更靠前"。
//
// 语法（见 matchesExclude）：
//   "name"      精确名
//   "_tmp*"     前缀
//   "*.html"    后缀
const DEFAULT_EXCLUDES = [
  "_tmp*",
  "_gen_*",
  "_manual*",
  "_docx_build",
  "output",
  "*.html",
  "*.htm",
  "*.tmp",
  "*.log",
];

function parseArgs(argv) {
  const opts = { vault: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--vault") {
      opts.vault = argv[++i];
      if (!opts.vault) fail("--vault requires a path argument");
    } else if (arg === "--force") {
      opts.force = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printUsage() {
  console.log("Usage: node scripts/mirror-vault-to-sandbox.mjs --vault <path> [--force]");
  console.log("");
  console.log("Mirrors a Markdown vault into a Workbench sandbox (snapshot, not live).");
  console.log("Set VAULT_SOURCE instead of --vault to avoid repeating the path.");
}

function fail(message) {
  console.error(`[mirror] ${message}`);
  printUsage();
  process.exit(1);
}

async function readEnvFile(envPath) {
  if (!existsSync(envPath)) return {};
  const text = await fs.readFile(envPath, "utf8");
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function matchesExclude(name) {
  const lower = name.toLowerCase();
  for (const pattern of DEFAULT_EXCLUDES) {
    if (pattern.startsWith("*.")) {
      if (lower.endsWith(pattern.slice(1).toLowerCase())) return true;
    } else if (pattern.endsWith("*")) {
      if (name.startsWith(pattern.slice(0, -1))) return true;
    } else if (pattern === name) {
      return true;
    }
  }
  return false;
}

async function mirrorTree(srcDir, dstDir, counters) {
  let entries;
  try {
    entries = await fs.readdir(srcDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    counters.errors++;
    console.warn(`[mirror] WARN cannot read ${srcDir}: ${error.message}`);
    return;
  }

  for (const entry of entries) {
    if (matchesExclude(entry.name)) {
      counters.skipped++;
      continue;
    }
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);

    if (entry.isSymbolicLink()) {
      counters.skipped++;
      continue;
    }

    if (entry.isDirectory()) {
      await fs.mkdir(dstPath, { recursive: true });
      await mirrorTree(srcPath, dstPath, counters);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, dstPath);
      counters.copied++;
    }
  }
}

function toEnvPath(absPath) {
  // .env 里用正斜杠，跨工具链更省事。
  return absPath.replace(/\\/g, "/");
}

async function writeEnv(envPath, env) {
  const body = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  await fs.writeFile(envPath, body + "\n", "utf8");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const envPath = path.join(workbenchDir, ".env");
  const env = await readEnvFile(envPath);

  const sourceVault = opts.vault || process.env.VAULT_SOURCE;
  if (!sourceVault) {
    fail("source vault not given - pass --vault <path> or set VAULT_SOURCE");
  }

  if (!existsSync(sourceVault)) {
    console.error(`[mirror] source vault not found: ${sourceVault}`);
    process.exit(1);
  }

  console.log(`[mirror] source:  ${sourceVault}`);
  console.log(`[mirror] sandbox: ${sandboxRoot}`);
  console.log(`[mirror] force:   ${opts.force}`);

  if (existsSync(sandboxRoot) && opts.force) {
    await fs.rm(sandboxRoot, { recursive: true, force: true });
    console.log("[mirror] wiped previous sandbox");
  }

  try {
    await fs.mkdir(sandboxRoot, { recursive: true });
  } catch (error) {
    console.error(`[mirror] cannot create sandbox: ${error.message}`);
    process.exit(2);
  }

  const counters = { copied: 0, skipped: 0, errors: 0 };
  await mirrorTree(sourceVault, sandboxRoot, counters);
  console.log(
    `[mirror] copied ${counters.copied} files, skipped ${counters.skipped}, errors ${counters.errors}`,
  );

  env.PERSONAL_DASHBOARD_VAULT_ROOT = toEnvPath(sandboxRoot);
  if (!env.VAULT_EXCLUDES) {
    env.VAULT_EXCLUDES = DEFAULT_EXCLUDES.join(",");
  }
  await writeEnv(envPath, env);
  console.log(
    `[mirror] .env updated -> PERSONAL_DASHBOARD_VAULT_ROOT=${env.PERSONAL_DASHBOARD_VAULT_ROOT}`,
  );

  console.log("");
  console.log("[mirror] next: restart the dev server so the indexer rescans.");
  console.log("[mirror]       node scripts/standalone-launcher.mjs --restart");
  console.log("[mirror] NOTE: this is a snapshot. Re-run this script after editing notes.");
}

main().catch((error) => {
  console.error(`[mirror] FAILED: ${error.message}`);
  process.exit(1);
});
