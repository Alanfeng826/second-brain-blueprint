# patch · 适配层补丁说明

上游 [oyorf/person_dashboard](https://github.com/oyorf/person_dashboard) 开箱即用是**它的**知识库，
不是你的。本目录的 `vault-adaptations.mjs` 集中了把它接到"四库式 Vault"上所需的全部逻辑，
上游文件只需要加 **5 行 hook**。

- 补丁针对的上游版本：`e9e4bcc7a9ac85f4e98225f34e9338feb4c8cedf`（2026-08-20）
- `bootstrap.mjs` 会按下面的锚点自动插入，**幂等**：已插过的会跳过
- 锚点找不到时 bootstrap 会打警告并打印手工步骤，不会静默改坏文件

---

## 为什么必须打补丁：上游缺三样东西

| 缺什么 | 症状 | 本适配补上 |
|:---|:---|:---|
| **.env 加载器** | 明明配了 `PERSONAL_DASHBOARD_VAULT_ROOT`，站点还在读 demo | `loadVaultEnv()` |
| **可配置排除规则** | `_tmp_*`、`*.html` 等临时产物全进搜索结果 | `applyExternalExcludes()` + `shouldExcludeEntry()` |
| **Vault→section 映射** | 四库目录名上游不认识，全部落进 `other`，页面空白 | `classifyVault()` + `vault-map.json` |

> 第一条最反直觉：**上游直接读 `process.env.PERSONAL_DASHBOARD_VAULT_ROOT`，
> 但 Vite 只把 `VITE_` 前缀的变量注入 `import.meta.env`，不会把 `.env` 写进 `process.env`。**
> 所以上游的 `.env` 配置实际是不生效的。

---

## 要改的文件（2 个）

把 `vault-adaptations.mjs` 复制到 `Workbench/server/`，然后：

### A. `Workbench/server/vite-plugin-workbench.mjs`

**A1 · 加 import**（锚点 = 最后一条 import）

```diff
 import { loadAttentionStrategy } from "./public-config.mjs";
+import { applyExternalExcludes, loadVaultEnv, loadVaultMap, readExcludePatterns } from "./vault-adaptations.mjs";
```

**A2 · 加载 .env 并应用排除规则**（锚点 = `const workbenchRoot = ...`）

```diff
 const workbenchRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
+
+// [vault-kit] 必须在下面读 PERSONAL_DASHBOARD_VAULT_ROOT 之前执行
+loadVaultEnv(workbenchRoot);
+// 显式按 workbenchRoot 载入映射：不能指望 classifyVault 的兜底去找 cwd
+loadVaultMap(workbenchRoot);
+applyExternalExcludes(readExcludePatterns());
+
 const defaultVaultRoot = path.resolve(
   process.env.PERSONAL_DASHBOARD_VAULT_ROOT ||
```

> ⚠️ 顺序不能颠倒。`.env` 加载必须在 `defaultVaultRoot` 求值之前，
> 否则读到的是 `undefined`，站点继续用 demo。
>
> ⚠️ `loadVaultMap(workbenchRoot)` 这行别省。少了它，映射会走兜底去找
> `process.cwd()`；一旦工作目录不是 `Workbench/`（比如从上一级目录启动 vite），
> 就会**静默**退回没写 override 的默认映射 —— 页面能打开、文档也在，只是分类全错，
> 非常难查。

### B. `Workbench/server/vault-index.mjs`

**B1 · 加 import**（锚点 = `import XLSX from "xlsx";`）

```diff
 import XLSX from "xlsx";
+import { classifyVault, shouldExcludeEntry } from "./vault-adaptations.mjs";
```

**B2 · 接上分类映射**（锚点 = 分类函数最后的 `return { layer: "other", ... }`）

```diff
+  // [vault-kit] 四库映射：认不出就交回上游，opt-in、不影响原生目录
+  const adapted = classifyVault(parts);
+  if (adapted) return adapted;
   return { layer: "other", section: top || null, kind: "file" };
```

**B3 · 扫描期排除**（锚点 = 目录分支，`EXCLUDED_DIRECTORIES` 那两行）

```diff
       if (entry.isDirectory()) {
         if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
+        if (shouldExcludeEntry(entry.name)) continue;
         await walk(absolutePath);
         continue;
       }
```

**B4 · 扫描期排除（文件分支）**（锚点 = `files.push(...)`）

```diff
+      // [vault-kit] 文件也要过一遍排除规则：顶层散落的 _tmp_xxx.md 是文件不是目录，
+      // 只在目录分支拦会全部漏网。
+      if (shouldExcludeEntry(entry.name)) continue;
       if (entry.isFile()) files.push({ absolutePath, relativePath });
```

---

## 手动校验

打完补丁后：

```bash
cd Workbench
node scripts/standalone-launcher.mjs --restart   # 服务端改动不吃 HMR，必须整进程重启
curl http://127.0.0.1:5173/api/runtime            # vault.label 应该是你的 Vault，不是 demo
curl "http://127.0.0.1:5173/api/collections/wiki?section=cases"   # 应返回真实文档
```

三个检查点全过，才算真的接上了：

- [ ] `/api/runtime` 的 `vault.label` 是你的 Vault 名
- [ ] 四库映射生效（`section=cases` 能返回真实文档，不是空数组）
- [ ] 在 Vault 里改一个 `.md`，浏览器约半秒内自动更新（说明监听挂在了真实 Vault 上）

---

## 升级上游时怎么办

补丁是**插入**而非删除，所以：

```bash
cd Workbench
git diff > ../my-adaptations.patch      # 导出你的改动
git checkout . && git pull              # 拿上游更新
git apply ../my-adaptations.patch       # 冲突再看锚点手工重打
```

锚点找不到了说明上游改动了这三处附近的结构 —— 这时手工按上面的 diff 重打一遍即可，
逻辑都在 `vault-adaptations.mjs` 里，上游文件侧只有 5 行。
