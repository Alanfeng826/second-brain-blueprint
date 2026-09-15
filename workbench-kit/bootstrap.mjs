#!/usr/bin/env node
/**
 * bootstrap.mjs
 * ---------------------------------------------------------------------------
 * 一条命令把 Workbench 拉起来并接到你自己的 Markdown Vault 上。
 *
 * 它做的事（全部幂等，可重复执行）：
 *   1. 克隆上游 oyorf/person_dashboard，并切到已验证的 commit
 *   2. 把 workbench-kit/scripts/ 的 5 个脚本装进 Workbench/scripts/
 *   3. 把 vault-adaptations.mjs 装进 Workbench/server/
 *   4. 按锚点给上游 2 个文件打适配补丁（已打过的会跳过）
 *   5. 生成 Workbench/.env 与 Workbench/vault-map.json
 *   6. npm install（--skip-install 可跳过）
 *
 * 用法
 *   node workbench-kit/bootstrap.mjs --vault D:/your-vault
 *   node workbench-kit/bootstrap.mjs --vault D:/your-vault --dir ./workbench
 *
 * 参数
 *   --vault <path>    你的 Markdown Vault 根目录（必填；也可用 VAULT_SOURCE）
 *   --dir <path>      装到哪里（默认 ./workbench）
 *   --ref <git-ref>   上游版本（默认已验证的 commit；--ref main 拿最新）
 *   --skip-install    不跑 npm install
 *   --force           目标目录已存在且不是本工具建的，也照样往里写
 *
 * 注意：本脚本**不改你的 Vault**，只读它。所有写入都在 --dir 目标里。
 * ---------------------------------------------------------------------------
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const KIT_DIR = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM_URL = "https://github.com/oyorf/person_dashboard.git";
const PINNED_REF = "e9e4bcc7a9ac85f4e98225f34e9338feb4c8cedf";

const args = parseArgs(process.argv.slice(2));
const TARGET_DIR = path.resolve(process.cwd(), args.dir || "workbench");
const VAULT = args.vault || process.env.VAULT_SOURCE;

const log = (msg) => console.log(`  ${msg}`);
const step = (msg) => console.log(`\n[${msg}]`);
const warn = (msg) => console.warn(`  ! ${msg}`);

// ---------------------------------------------------------------------------
// 适配补丁。锚点全部取自上游 PINNED_REF，已验证唯一。
// 幂等判据：文件里已有 kitMarker 就整组跳过。
// ---------------------------------------------------------------------------
const KIT_MARKER = "vault-adaptations.mjs";

const PATCHES = [
  {
    file: "Workbench/server/vite-plugin-workbench.mjs",
    anchor: 'import { loadAttentionStrategy } from "./public-config.mjs";',
    position: "after",
    insert:
      '\nimport { applyExternalExcludes, loadVaultEnv, loadVaultMap, readExcludePatterns } from "./vault-adaptations.mjs";',
    note: "A1 引入适配模块",
  },
  {
    file: "Workbench/server/vite-plugin-workbench.mjs",
    anchor: 'const workbenchRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));',
    position: "after",
    insert:
      "\n\n// [vault-kit] 必须在下面读 PERSONAL_DASHBOARD_VAULT_ROOT 之前执行，顺序不能颠倒" +
      "\nloadVaultEnv(workbenchRoot);" +
      "\n// 显式按 workbenchRoot 载入映射：不能指望 classifyVault 的兜底去找 cwd" +
      "\nloadVaultMap(workbenchRoot);" +
      "\napplyExternalExcludes(readExcludePatterns());",
    note: "A2 加载 .env + 映射 + 排除规则",
  },
  {
    file: "Workbench/server/vault-index.mjs",
    anchor: 'import XLSX from "xlsx";',
    position: "after",
    insert: '\nimport { classifyVault, shouldExcludeEntry } from "./vault-adaptations.mjs";',
    note: "B1 引入适配模块",
  },
  {
    file: "Workbench/server/vault-index.mjs",
    anchor: '  return { layer: "other", section: top || null, kind: "file" };',
    position: "before",
    insert:
      "  // [vault-kit] 四库映射。认不出就交回上游，opt-in、不影响原生目录结构\n" +
      "  const adapted = classifyVault(parts);\n" +
      "  if (adapted) return adapted;\n",
    note: "B2 接上 Vault→section 映射",
  },
  {
    file: "Workbench/server/vault-index.mjs",
    anchor: "        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;",
    position: "after",
    insert: "\n        if (shouldExcludeEntry(entry.name)) continue;",
    note: "B3 扫描期排除（目录）",
  },
  {
    file: "Workbench/server/vault-index.mjs",
    anchor: "      if (entry.isFile()) files.push({ absolutePath, relativePath });",
    position: "before",
    insert:
      "      // [vault-kit] 文件也要过排除规则：顶层散落的 _tmp_xxx.md 是文件不是目录，\n" +
      "      // 只在目录分支拦会全部漏网。\n" +
      "      if (shouldExcludeEntry(entry.name)) continue;\n",
    note: "B4 扫描期排除（文件）",
  },
];

function parseArgs(argv) {
  const out = { vault: null, dir: null, ref: PINNED_REF, skipInstall: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vault") out.vault = argv[++i];
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--ref") out.ref = argv[++i];
    else if (a === "--skip-install") out.skipInstall = true;
    else if (a === "--force") out.force = true;
    else if (a === "--help" || a === "-h") {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
      process.exit(0);
    } else {
      console.error(`未知参数：${a}`);
      process.exit(1);
    }
  }
  return out;
}

function run(cmd, cmdArgs, cwd) {
  const res = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (res.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} 失败（exit ${res.status}）`);
}

/**
 * 找一个能用的可执行文件。
 *
 * 为什么需要这层：Windows 上 git / npm 经常不在 PATH 里（典型是只装了
 * Git for Windows 但没勾 PATH，或者用的是某个自带的便携版），
 * 这时候 spawnSync("git") 直接 ENOENT，报错信息还很难懂。
 *
 * 顺序：显式环境变量 → PATH → 常见安装位置。
 */
function resolveBin({ envKey, names, candidates, probeArgs }) {
  const explicit = process.env[envKey];
  if (explicit && fs.existsSync(explicit)) return explicit;

  for (const name of names) {
    const probe = spawnSync(name, probeArgs, {
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    if (probe.status === 0) return name;
  }

  for (const c of candidates) {
    const expanded = c
      .replace("%ProgramFiles%", process.env.ProgramFiles || "C:\\Program Files")
      .replace("%LOCALAPPDATA%", process.env.LOCALAPPDATA || "")
      .replace("%USERPROFILE%", process.env.USERPROFILE || "");
    if (expanded && fs.existsSync(expanded)) return expanded;
  }

  return null;
}

function resolveGit() {
  return resolveBin({
    envKey: "GIT_BIN",
    names: process.platform === "win32" ? ["git.exe", "git"] : ["git"],
    candidates: [
      "%ProgramFiles%\\Git\\cmd\\git.exe",
      "%ProgramFiles(x86)%\\Git\\cmd\\git.exe",
      "%LOCALAPPDATA%\\Programs\\Git\\cmd\\git.exe",
    ],
    probeArgs: ["--version"],
  });
}

function resolveNpm() {
  return resolveBin({
    envKey: "NPM_BIN",
    names: process.platform === "win32" ? ["npm.cmd", "npm"] : ["npm"],
    candidates: [
      "%ProgramFiles%\\nodejs\\npm.cmd",
      "%LOCALAPPDATA%\\Programs\\nodejs\\npm.cmd",
    ],
    probeArgs: ["--version"],
  });
}

// ---------------------------------------------------------------------------

function main() {
  if (!VAULT) {
    console.error("缺少源 Vault。请传 --vault <path>，或设置环境变量 VAULT_SOURCE。");
    process.exit(1);
  }
  if (!fs.existsSync(VAULT)) {
    console.error(`源 Vault 不存在：${VAULT}`);
    process.exit(1);
  }
  const dest = TARGET_DIR;
  log(`源 Vault   ${VAULT}`);
  log(`安装到     ${dest}`);
  log(`上游版本   ${args.ref}`);

  // ---- 1. 克隆上游 ----
  step("1/6 拉取上游 Workbench");
  const git = resolveGit();
  if (!git) {
    console.error(
      "找不到 git。请安装 Git（https://git-scm.com/downloads），\n" +
        "或用 GIT_BIN=<git.exe 的绝对路径> 指定。",
    );
    process.exit(1);
  }
  log(`git: ${git}`);
  const gitDir = path.join(dest, ".git");
  if (fs.existsSync(gitDir)) {
    log("已是 git 仓库，跳过克隆");
  } else if (fs.existsSync(dest) && !args.force) {
    console.error(
      `目标目录已存在且不是本工具建的：${dest}\n` +
        `确认要往里面写就加 --force，或换个位置用 --dir。`,
    );
    process.exit(1);
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    run(git, ["clone", "--quiet", UPSTREAM_URL, dest]);
    log("克隆完成");
  }

  step("1b/6 切到已验证版本");
  const checkout = spawnSync(git, ["-C", dest, "checkout", "--quiet", args.ref], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (checkout.status !== 0) {
    warn(`切到 ${args.ref} 失败，停留在当前分支（上游可能已改变历史）`);
  } else {
    log(`已切到 ${args.ref}`);
  }

  // ---- 2. 装脚本 ----
  step("2/6 安装 kit 脚本 → Workbench/scripts/");
  const scriptsSrc = path.join(KIT_DIR, "scripts");
  const scriptsDst = path.join(dest, "Workbench", "scripts");
  fs.mkdirSync(scriptsDst, { recursive: true });
  for (const name of fs.readdirSync(scriptsSrc)) {
    fs.copyFileSync(path.join(scriptsSrc, name), path.join(scriptsDst, name));
    log(`→ scripts/${name}`);
  }

  // ---- 3. 装适配模块 ----
  step("3/6 安装适配模块 → Workbench/server/");
  const serverDst = path.join(dest, "Workbench", "server");
  const addonSrc = path.join(KIT_DIR, "patch", "vault-adaptations.mjs");
  fs.copyFileSync(addonSrc, path.join(serverDst, "vault-adaptations.mjs"));
  log("→ server/vault-adaptations.mjs");

  // ---- 4. 打补丁 ----
  step("4/6 给上游文件打适配补丁");
  applyPatches(dest);

  // ---- 5. 生成配置 ----
  step("5/6 生成 .env 与 vault-map.json");
  writeEnv(path.join(dest, "Workbench"), VAULT);
  const mapDst = path.join(dest, "Workbench", "vault-map.json");
  fs.copyFileSync(path.join(KIT_DIR, "vault-map.example.json"), mapDst);
  log("→ Workbench/.env");
  log("→ Workbench/vault-map.json（按你的库名改 dir 字段）");

  // ---- 6. 装依赖 ----
  step("6/6 安装依赖");
  if (args.skipInstall) {
    log("已跳过（--skip-install）");
  } else {
    const npm = resolveNpm();
    if (!npm) {
      warn("找不到 npm。请装 Node.js 20+，或用 NPM_BIN=<npm 绝对路径> 指定，或加 --skip-install");
    } else {
      log(`npm: ${npm}`);
      run(npm, ["install", "--no-audit", "--no-fund"], path.join(dest, "Workbench"));
    }
  }

  step("完成");
  const wb = path.join(dest, "Workbench");
  console.log(`
  下一步：

    1. 编辑 ${path.join(wb, "vault-map.json")}
       把 libraries[].dir 改成你自己的库目录名

    2. 启动（脱离终端独立常驻）
       node "${path.join(wb, "scripts", "standalone-launcher.mjs")}"

    3. 验证是否真的读到了你的 Vault（不是 demo）
       curl http://127.0.0.1:5173/api/runtime
       看 vault.label 是不是你的 Vault 名

    4. 日常开关：双击 scripts/start-workbench.vbs / stop-workbench.bat
       开机自启：把 start-workbench.vbs 的快捷方式丢进 shell:startup

  详细接线原理见 docs/03-门面-Workbench接入.md
  补丁说明见 workbench-kit/patch/README.md
`);
}

function applyPatches(dest) {
  const byFile = new Map();
  for (const p of PATCHES) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push(p);
  }

  for (const [relFile, patches] of byFile) {
    const abs = path.join(dest, relFile);
    if (!fs.existsSync(abs)) {
      warn(`找不到 ${relFile} —— 上游结构变了？请手工按 patch/README.md 打补丁`);
      continue;
    }
    let text = fs.readFileSync(abs, "utf8");

    if (text.includes(KIT_MARKER)) {
      log(`${path.basename(relFile)}：已打过补丁，跳过`);
      continue;
    }

    let ok = true;
    for (const p of patches) {
      const hits = text.split(p.anchor).length - 1;
      if (hits === 0) {
        warn(`${path.basename(relFile)}：锚点丢失 → ${p.note}`);
        warn(`  锚点：${p.anchor.slice(0, 70)}...`);
        ok = false;
        continue;
      }
      if (hits > 1) {
        warn(`${path.basename(relFile)}：锚点不唯一（${hits} 处）→ ${p.note}，跳过`);
        ok = false;
        continue;
      }
      const replacement = p.position === "after" ? p.anchor + p.insert : p.insert + p.anchor;
      text = text.replace(p.anchor, () => replacement);
      log(`${path.basename(relFile)}：✓ ${p.note}`);
    }

    if (ok) {
      fs.writeFileSync(abs, text, "utf8");
    } else {
      warn(`${path.basename(relFile)}：有锚点未命中，**未写入**，请手工处理`);
      warn("  手工步骤见 workbench-kit/patch/README.md");
    }
  }
}

function writeEnv(workbenchDir, vaultPath) {
  const template = fs.readFileSync(path.join(KIT_DIR, "env.example"), "utf8");
  const posix = path.resolve(vaultPath).replace(/\\/g, "/");
  const body = template.replace(/^PERSONAL_DASHBOARD_VAULT_ROOT=.*$/m, `PERSONAL_DASHBOARD_VAULT_ROOT=${posix}`);
  fs.writeFileSync(path.join(workbenchDir, ".env"), body, "utf8");
}

try {
  main();
} catch (error) {
  console.error(`\n[bootstrap] 失败：${error.message}`);
  process.exit(1);
}
