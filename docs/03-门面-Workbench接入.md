# 03 · 门面：接一个可视化前端

骨架和大脑跑起来之后，知识库仍然只能靠"问 Agent"访问。
**门面层解决的是"我想自己看一眼"的需求**：总览、搜索、知识星图、阅读器。

本方法用的是开源项目 [oyorf/person_dashboard](https://github.com/oyorf/person_dashboard) 里的 `Workbench`（本地优先、直读 Markdown Vault 的 Web 工作台）。
**关键认知：不要期待开箱即用。** 上游的每个页面都期待特定的目录与字段，
真正的工作量在于**把你的 Vault 结构映射到它的视图契约上**。

---

## 0. 懒人路径：一条命令装好

下面 §1–§7 讲的是**原理**，读一遍能让你在出问题时知道该动哪里。
如果你只想先把东西跑起来，用本仓库的安装器：

```bash
git clone https://github.com/Alanfeng826/second-brain-blueprint.git
node second-brain-blueprint/workbench-kit/bootstrap.mjs --vault D:/your-vault
```

它会（全部幂等，可重复执行）：拉上游并切到**已验证的 commit** → 装脚本 →
装适配模块 → 按锚点给上游 2 个文件打 6 处补丁 → 生成 `.env` 与 `vault-map.json` → `npm install`。

装完只剩一件事要手工做：编辑 `Workbench/vault-map.json`，把 `libraries[].dir`
改成你自己的库目录名。**它不写你的 Vault，只读。**

> 本仓库**不包含**上游源码 —— 上游是第三方项目，直接复制会让许可边界变糊、
> 也会变成一份没人跟着升级的旧快照。安装器只带"接线"所需的部分。
> 细节见 [`workbench-kit/README.md`](../workbench-kit/README.md)。

---

## 1. 先理解它的读取链路

```
Vault 目录树
   │  ① 扫描 + 分类（哪个文件属于哪个 section/layer）
   ▼
索引构建（文档元数据、分类、标签）
   │  ② 目录监听（watch）
   ▼
HTTP API（/api/overview、/api/search、/api/collections/...）
   │  ③ 前端消费
   ▼
React 页面（总览 / 星图 / 书架 / 阅读器）
```

你要改的只有 **①分类规则** 和 **②监听根目录**，前端不用动。

---

## 2. 三件事必须做

### (1) 让它读到你的 Vault，而不是它自带的 demo

复制 `.env` 示例，把根目录指向你的 Vault：

```text
PERSONAL_DASHBOARD_VAULT_ROOT=D:/your-vault
```

**⚠️ 坑：非 `VITE_` 前缀的环境变量不会自动注入到进程环境。**
写进 `.env` 后必须**完全重启** dev server，否则该变量仍是 `undefined`，站点还在读 demo。
> 判断方法：访问 `/api/runtime`，看 `vault.label` 是 `你的Vault名` 还是 `demo` 目录名。

### (2) 把你的四个库映射到它的 section

上游默认面向它的作者自己的内容结构，你的四库需要一条 fallback 分类规则：

```javascript
function classifyMyVault(parts) {
  const top = parts[0] || "";
  if (top === "工作项目库") return { layer: "wiki", section: "cases",     kind: "knowledge" };
  if (top === "学习成长库") return { layer: "wiki", section: "concepts",  kind: "knowledge" };
  if (top === "产品洞察库") return { layer: "wiki", section: "analyses",  kind: "knowledge" };
  if (top === "素材模板库") return { layer: "wiki", section: "templates", kind: "template"  };
  if (top === "_系统")     return { layer: "wiki", section: "usage",     kind: "usage"     };
  return null;
}
```

要点：`section` 是**上游已有的视图名**，不要去发明新的 —— 前端不认识。
你要做的是"翻译"，不是"扩展"。

### (3) 让标签能被前端读到

本方法的标签写在正文顶部的 `>` 引用块里（人类友好）：

```markdown
> 推荐标签：#PRD #<领域> #精华
> #投标 #报价 ｜ 阶段：售前 ｜ 状态：#已消化
```

但上游前端期待的是 **frontmatter**。所以要加一层提取：扫前 30 行的 `>` 块，
用正则捞出 `#tag`，merge 进 frontmatter 的 `tags` / `status` / `type`。

```javascript
// 扫前 30 行里的 "> ... #tag ..."
const TAG_BLOCK_RE = /^>\s+.*#[\w\u4e00-\u9fff-]+/;
```

> 这一步是**唯一需要写代码的映射**。做完之后，你的标签体系就同时服务"人"和"前端"两种读者。

---

## 3. 排除规则：别让临时产物污染视图

Vault 根目录会有大量非知识文件（构建目录、临时脚本、日志、生成的 HTML）。
写进 `.env` 一条逗号分隔的排除串：

```text
VAULT_EXCLUDES=_tmp*,_gen_*,_manual*,_docx_build,output,*.html,*.htm,*.tmp,*.log
```

> 上游默认只有一份写死的目录黑名单（`EXCLUDED_DIRECTORIES`），**没有可配置的排除变量**。
> 上面这行是本方法新增的：把黑名单外置成环境变量，好处是切 Vault / 临时产物变多时不用改源码。

排除规则要支持三种 pattern：

| Pattern | 含义 |
|:---|:---|
| `name` | 精确名 |
| `prefix*` | 名称前缀 |
| `*.ext` | 后缀 |

**坑**：前缀排除必须在"文件分支"也检查一次，否则顶层的 `_tmp_xxx.md`（文件，不是目录）会漏网。

**坑**：排除规则只在接线时初始化一次的话，hook 锚点漂移或调用顺序一变，就会静默
"一条都不排除" —— 不报错、页面上看不出来，只是临时产物又回到列表里。
判断函数应当**自愈**：第一次被调用时若还没初始化，就地按环境变量初始化。

**更好的做法**：不要只在运行时排除，**接入时先做一次镜像**（只复制要索引的文件到沙箱目录）。
这样文件复制成本也省了，而且排除规则变了之后镜像可重建。
（但注意 §4 的结论：镜像 = 快照，**不跟随实时更新**，除非你要的就是隐私隔离。）

---

## 4. 沙箱镜像 vs 直读：一个必须提前想清楚的选择

| | 沙箱镜像 | **直读 Vault（推荐）** |
|:---|:---|:---|
| 根目录指向 | `<project>/.workbuddy/_om/_vault-ro` | `D:/your-vault` |
| Agent 新写的笔记 | **镜像看不到 → 站点永远不更新** | 监听触发 → 约半秒自动反映 |
| 写盘风险 | 无 | 无（默认只读 + 越界校验） |
| 隐私隔离 | 强（镜像里可剔除敏感文件） | 依赖排除规则 |

**踩过的坑**：镜像模式下监听器只挂在镜像根上，Vault 的改动完全不在监听范围内。
症状是"知识库天天更新，但站点数据不动"，而且很难一眼看出原因。

> **结论：如果你要的是"实时跟随"，就必须直读。**
> 污染问题用排除规则解决，不要用镜像解决。

实时更新链路（验证通过）：

```
Vault 中 .md 改动
  → 文件监听（chokidar）
  → debounce ~380ms
  → 重建索引
  → SSE 推送事件（/api/vault/events）
  → 前端 revision+1 → 自动 refetch → UI 更新（无需手动刷新）
```

---

## 5. 让它脱离 Agent 独立常驻

**问题**：如果你通过 Agent 的终端启动 dev server，进程链是
`Agent shell → bash → npm run dev → cmd → vite`。
**Agent 一关闭 → 清理进程树 → vite 被杀 → 站点打不开。**

**解法**：写一个独立启动器，detached spawn，并提供 `--status / --stop / --restart`。

| 文件 | 作用 |
|:---|:---|
| `standalone-launcher.mjs` | 核心：检测端口占用 → detached 启动 → 日志落盘 |
| `start-*.vbs` | 无窗口入口（双击 / 开机自启） |
| `stop-*.bat` | 双击停止 |
| `restart-*.bat` | 双击重启 |

开机自启：在 Windows 启动文件夹放一个 **shim**，内容只负责调用真正的实现：

```vbscript
sh.Run "<项目>\scripts\start-personal-dashboard.vbs", 0, False
```

> **shim 与实现分离的理由**：将来迁移项目目录，只改一处。

**验证是否真的脱离**：启动后查父进程链

```powershell
Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" | Select ProcessId,ParentProcessId,Name
```

父进程已退出 = 已孤儿化 ✓

---

## 6. 跨平台兼容（Windows 上必须做）

| 问题 | 症状 | 解法 |
|:---|:---|:---|
| `open` 命令是 macOS-only | Windows 上 spawn ENOENT，**整个 dev server 崩掉** | 加 `process.platform === "win32"` 分支：定位文件用 `explorer.exe /select,`，打开文档用 `cmd /c start ""` |
| 前端文案硬编码"在 Finder 中显示" | Windows 用户看到误导提示 | 抽成 `IS_MAC_PLATFORM` + 文案常量 |
| 端口被占后静默漂移 | 用户访问原端口打不开 | 显式 `port` + `strictPort: true` |

> **教训**：后端改了平台分支，**别忘了前端文案** —— 否则是"能用的功能 + 错的提示"，
> 比直接报错更让人困惑。

---

## 7. 已知不适配的场景（不是 bug，是设计差异）

| 现象 | 原因 |
|:---|:---|
| 知识星图为空 | 你写的是普通正文，没有 `[[xxx]]` 双链。星图依赖双链，不依赖目录 |
| 隐私扫描不通过 | 公共仓库的隐私门禁会拒绝真实路径/客户名。私有使用可跳过，公开分享必须先过 |
| 某些页面数据缺失 | 上游页面期待特定字段契约，你的数据没有就是没有 —— **不要用 0 或假数据顶替** |
| `/api/runtime` 里 `errors` 不为 0 | 多半是上游自带数据源（如它自己的 `10_raw/douyin/...`）在你这里不存在，会在 `qualityNotices` 里说明。**与你的 Vault 无关**，不影响四库视图 |
| `metrics.wiki` 与 `documents` 数量对不上 | 上游对"什么算 wiki 文档"有自己的口径，你的元文件（如 `_系统/索引.md`）可能不计入。以页面实际显示为准 |

---

## 8. 接入检查清单

- [ ] `.env` 的根目录指向真实 Vault，且**完全重启**过 dev server
- [ ] `/api/runtime` 显示的是你的 Vault，不是 demo
- [ ] 四库 → section 映射已生效 —— 用 `/api/search?q=<能命中内容的词>&section=<视图名>` 逐库抽查
      （⚠️ **不要**用 `/api/collections/wiki?section=...` 验证：该接口忽略 `section` 参数，永远返回全量，
      "有数据"是假象）
- [ ] 标签块 → frontmatter 提取生效（前端能看到你正文里的标签）
- [ ] 排除规则覆盖全部临时产物（顶层散落的 `_tmp_*.md` 也要覆盖）
- [ ] 独立启动器可用，`--status` 显示正常
- [ ] 改一个 `.md`，浏览器里约半秒内自动更新
- [ ] 公开前跑过隐私扫描
