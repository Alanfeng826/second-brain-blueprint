# workbench-kit · 门面安装器

一条命令把 [oyorf/person_dashboard](https://github.com/oyorf/person_dashboard) 的 `Workbench`
接到你自己的 Markdown Vault 上。

```bash
git clone https://github.com/Alanfeng826/second-brain-blueprint.git
node second-brain-blueprint/workbench-kit/bootstrap.mjs --vault D:/your-vault
```

跑完改成你自己的库名（唯一需要手工做的一步）：

```bash
# 编辑 <目标目录>/Workbench/vault-map.json，把 libraries[].dir 换成你的库目录名
node Workbench/scripts/standalone-launcher.mjs
# 打开 http://127.0.0.1:5173/ ，确认 /api/runtime 里的 vault.label 是你自己的 Vault
```

---

## 为什么是"安装器"而不是"把前端一并放进本仓库"

把上游源码整份拷进这个仓库，看着省事，实际是三个坑：

| 问题 | 后果 |
|:---|:---|
| 上游是**第三方项目**，有自己的 LICENSE | 复制源码会让本仓库的许可边界变糊。要分发上游代码，正确姿势是 fork，不是贴进来 |
| 上游在持续更新 | 贴进来的快照会慢慢变成"一份没人维护的旧代码"，你也不会去合并上游的修复 |
| 仓库体积 | 一个方法论仓库变成前端工程，clone 的人要拖几百 MB 都跟他无关的东西 |

所以这里只放**"把上游接到你的 Vault 上"所需要的那部分**：一个适配模块 + 6 处锚点补丁 + 几个脚本。
上游代码在安装时按 commit 拉取，永远是你自己机器上的一份干净 checkout。

---

## bootstrap.mjs 做六件事（全部幂等，可重复执行）

| 步骤 | 动作 |
|:---|:---|
| 1 | `git clone` 上游，并 checkout 到**已验证的 commit**（`--ref main` 可拿最新） |
| 2 | 把 `scripts/` 下 5 个脚本装进 `Workbench/scripts/` |
| 3 | 把 `patch/vault-adaptations.mjs` 装进 `Workbench/server/` |
| 4 | 按锚点给上游 2 个文件打 **6 处补丁**（已打过则整组跳过） |
| 5 | 生成 `Workbench/.env` 与 `Workbench/vault-map.json` |
| 6 | `npm install`（`--skip-install` 可跳过） |

**它不改你的 Vault，只读它。** 所有写入都发生在 `--dir` 指定的目标目录里。

锚点找不到时（上游改动结构）会**打警告并打印手工步骤、不写入**，不会静默改坏你的文件。
手工补丁的完整 diff 见 [`patch/README.md`](patch/README.md)。

### 参数

```text
--vault <path>    你的 Markdown Vault 根目录（必填，也可用环境变量 VAULT_SOURCE）
--dir <path>      装到哪里（默认 ./workbench）
--ref <git-ref>   上游版本（默认已验证 commit；--ref main 拿最新）
--skip-install    不跑 npm install
--force           目标目录已存在且不是本工具建的，也照样往里写
```

---

## 补丁补的是上游缺的三样东西

| 缺什么 | 症状 | 本适配补上 |
|:---|:---|:---|
| **.env 加载器** | 明明配了 `PERSONAL_DASHBOARD_VAULT_ROOT`，站点还在读 demo | `loadVaultEnv()` |
| **可配置排除规则** | `_tmp_*`、`*.html` 等临时产物全进搜索结果 | `applyExternalExcludes()` + `shouldExcludeEntry()` |
| **Vault→section 映射** | 四库目录名上游不认识，全部落进 `other`，页面空白 | `classifyVault()` + `vault-map.json` |

> 第一条最反直觉：上游直接读 `process.env.PERSONAL_DASHBOARD_VAULT_ROOT`，
> 但 Vite 只把 `VITE_` 前缀的变量注入 `import.meta.env`，**不会**把 `.env` 写进 `process.env`。
> 所以上游的 `.env` 配置实际是不生效的。

---

## 目录结构

```text
workbench-kit/
├── bootstrap.mjs                  # 安装器入口
├── env.example                    # .env 模板（含排除规则写法）
├── vault-map.example.json         # 库目录 → 前端 section 映射模板
├── patch/
│   ├── README.md                  # 6 处补丁的完整 diff 与手工步骤
│   └── vault-adaptations.mjs      # 全部适配逻辑集中在这一个文件
└── scripts/
    ├── standalone-launcher.mjs    # 脱离 Agent 会话独立常驻（--status/--stop/--restart）
    ├── start-workbench.vbs        # 双击 / 开机自启的无窗口入口
    ├── stop-workbench.bat
    ├── restart-workbench.bat
    └── mirror-vault-to-sandbox.mjs # 可选：沙箱镜像方案（非主线，见 docs/03 §4）
```

---

## 依赖

| | 要求 | 说明 |
|:---|:---|:---|
| Node.js | 20+ | 用来跑安装器与 dev server |
| git | 任意版本 | 安装器会依次找 `%GIT_BIN%` → PATH → 常见安装位置 |
| 平台 | Windows / macOS / Linux | 安装器与适配逻辑跨平台；`*.bat` / `*.vbs` 是 Windows 专用快捷入口 |

`git` / `npm` 找不到时，可用 `GIT_BIN=` / `NPM_BIN=` 指定绝对路径。

---

## 与上游的关系

本目录**不含**上游源码，只有适配层。升级上游：

```bash
cd Workbench
git diff > ../my-adaptations.patch      # 导出你的改动
git checkout . && git pull              # 拿上游更新
git apply ../my-adaptations.patch       # 冲突了按 patch/README.md 的锚点手工重打
```

补丁全部是**插入**而非删除，上游文件侧只有 5 行，所以冲突面很小。

---

## 许可

适配层代码随本仓库走 MIT。上游 `oyorf/person_dashboard` 的许可与版权归其作者，
使用前请自行确认其 LICENSE。
