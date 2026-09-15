/**
 * vault-adaptations.mjs
 * ---------------------------------------------------------------------------
 * 把 Workbench（上游）接到"四库式个人 Vault"上所需的全部适配逻辑，集中在
 * 这一个文件里。上游的 vault-index.mjs / vite-plugin-workbench.mjs 只需要加
 * 4 行 hook，其余都从这里来。
 *
 * 放在 Workbench/server/ 下，与上游文件同级。
 *
 * 上游原版缺三样东西，本模块补上：
 *   ① .env 加载器 —— 上游直接读 process.env.PERSONAL_DASHBOARD_VAULT_ROOT，
 *      但 Vite 只把 VITE_ 前缀的变量注入 import.meta.env，**不会**把 .env 写进
 *      process.env。所以上游的 .env 配置实际不生效，必须自己加载。
 *   ② 可配置的排除规则 —— 上游只有一份写死的目录黑名单 EXCLUDED_DIRECTORIES，
 *      临时产物（_tmp*、*.html）挡不住。
 *   ③ Vault 结构 → 前端 section 的映射 —— 上游只认它自己那套 10_raw/wiki/...
 *      目录名，四库目录会全部落进 "other"，页面上什么都看不到。
 *
 * 配置来源（都在 Workbench 目录下）：
 *   .env                  环境变量（见 env.example）
 *   vault-map.json        四库 → section 映射（见 vault-map.example.json）
 * ---------------------------------------------------------------------------
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENV_FILE = ".env";
const MAP_FILE = "vault-map.json";

// 本文件装在 Workbench/server/ 下，所以父目录就是 Workbench —— 用它当兜底，
// 比 process.cwd() 可靠得多：cwd 取决于谁用什么姿势把 vite 拉起来的
// （npm run dev / 上层目录里调 / 编辑器插件），指错目录时会**静默**退回
// "没有 override 的默认映射"，页面看着一切正常，分类却全错。
const SELF_WORKBENCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// ① .env 加载器
// ---------------------------------------------------------------------------
// Vite 不会把非 VITE_ 前缀的 .env 变量写进 process.env —— 这是文档里最容易
// 踩的坑：明明配了 PERSONAL_DASHBOARD_VAULT_ROOT，站点却还在读 demo。
// 这里在模块加载时手动补上，只填"尚未被真实环境变量占用"的 key。
let envLoadedFor = null;

export function loadVaultEnv(workbenchDir) {
  if (envLoadedFor === workbenchDir) return; // 幂等，重复调用无副作用
  envLoadedFor = workbenchDir;

  const envPath = path.join(workbenchDir, ENV_FILE);
  if (!fs.existsSync(envPath)) return;

  let text;
  try {
    text = fs.readFileSync(envPath, "utf8");
  } catch {
    return;
  }

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
    // 真实环境变量优先，.env 只做兜底
    if (!(key in process.env)) process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// ② 可配置的排除规则
// ---------------------------------------------------------------------------
// 语法：  "name" 精确名 | "prefix*" 前缀 | "*.ext" 后缀
export const DEFAULT_EXCLUDES = [
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

const excludeExact = new Set();
const excludePrefixes = new Set();
const excludeExtensions = new Set();
let excludesReady = false;

export function applyExternalExcludes(patterns) {
  if (!Array.isArray(patterns)) return;
  for (const raw of patterns) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("*.")) {
      excludeExtensions.add(trimmed.slice(1).toLowerCase());
      continue;
    }
    if (trimmed.endsWith("*")) {
      excludePrefixes.add(trimmed.slice(0, -1));
      continue;
    }
    excludeExact.add(trimmed);
  }
  excludesReady = true;
}

export function readExcludePatterns() {
  const fromEnv = process.env.VAULT_EXCLUDES;
  if (!fromEnv) return DEFAULT_EXCLUDES;
  return fromEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 扫描期判断：这个名字是否该被外部规则跳过。
 *
 * 只负责 VAULT_EXCLUDES 里的规则。上游那份写死的目录黑名单
 * （EXCLUDED_DIRECTORIES）保持原样不动，两者职责分离、互不覆盖。
 *
 * ⚠️ 关键坑：**前缀规则必须对文件和目录一视同仁**。
 * 只拦目录的话，Vault 根目录下散落的 `_tmp_草稿.md`（是文件，不是目录）
 * 会全部漏网，然后出现在搜索结果里。
 */
export function shouldExcludeEntry(name) {
  // 自愈：如果 hook 没打上（锚点漂移）或调用顺序变了，这里会静默"一条都不排除"，
  // 临时产物重新灌进索引，而表面看不出任何异常。所以在第一次调用时兜底初始化。
  if (!excludesReady) applyExternalExcludes(readExcludePatterns());

  if (excludeExact.has(name)) return true;
  for (const prefix of excludePrefixes) {
    if (name.startsWith(prefix)) return true;
  }
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const ext = name.slice(dot + 1).toLowerCase();
    if (excludeExtensions.has(ext)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// ③ Vault 结构 → 前端 section 的映射
// ---------------------------------------------------------------------------
// 上游只认它自己的目录命名。你的库名它不认识，结果全部落进 "other"，
// 页面空白。这里把"库目录名 → 上游已有 section"翻译过去。
//
// section 必须是**上游已有的视图名**，不要发明新的 —— 前端不认识。
// 上游可用值：analyses / cases / comparisons / concepts / conflicts /
//             diagnoses / frameworks / questions / sources / topics /
//             templates / usage
let mapConfig = null;

export function loadVaultMap(workbenchDir) {
  if (mapConfig) return mapConfig;
  const mapPath = path.join(workbenchDir, MAP_FILE);
  const fallback = {
    libraries: [
      { dir: "工作项目库", layer: "wiki", section: "cases", kind: "knowledge" },
      { dir: "学习成长库", layer: "wiki", section: "concepts", kind: "knowledge" },
      { dir: "产品洞察库", layer: "wiki", section: "analyses", kind: "knowledge" },
      { dir: "素材模板库", layer: "wiki", section: "templates", kind: "template" },
      { dir: "_系统", layer: "wiki", section: "usage", kind: "usage" },
    ],
  };
  if (!fs.existsSync(mapPath)) {
    mapConfig = fallback;
    return mapConfig;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(mapPath, "utf8"));
    mapConfig = Array.isArray(parsed?.libraries) && parsed.libraries.length
      ? parsed
      : fallback;
  } catch (error) {
    console.warn(`[vault-adaptations] vault-map.json 解析失败，用内置默认值：${error.message}`);
    mapConfig = fallback;
  }
  return mapConfig;
}

/**
 * @param {string[]} parts 相对路径按 / 切分后的段
 * @returns {{layer:string,section:string,kind:string}|null} null = 不归本适配管，交回上游
 */
export function classifyVault(parts) {
  const config = mapConfig || loadVaultMap(SELF_WORKBENCH_DIR);
  const top = parts[0] || "";
  const second = parts[1] || null;

  const library = config.libraries.find((lib) => lib.dir === top);
  if (!library) return null; // opt-in：非四库目录一律交回上游

  // 二级覆盖：同一库内某些子目录该归到别的 section
  // （例：学习成长库里某个备考子目录更适合当 frameworks 而不是 concepts）
  for (const rule of library.overrides || []) {
    if (rule.second && second === rule.second) {
      return { layer: library.layer, section: rule.section, kind: rule.kind };
    }
    if (rule.secondPrefix && second && second.startsWith(rule.secondPrefix)) {
      return { layer: library.layer, section: rule.section, kind: rule.kind };
    }
  }

  return { layer: library.layer, section: library.section, kind: library.kind };
}
