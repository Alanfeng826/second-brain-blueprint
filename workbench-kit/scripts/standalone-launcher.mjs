#!/usr/bin/env node
/**
 * standalone-launcher.mjs
 * ---------------------------------------------------------------------------
 * 让 Workbench 的 vite dev server 脱离终端 / Agent 会话独立常驻。
 *
 * 为什么需要它
 *   `npm run dev` 启动的 vite 是当前 shell 的子进程。Agent 会话关闭时会连同
 *   自己拉起的进程树一起清理，站点随即不可访问 —— 这就是"关掉 Agent 就打不开"
 *   的根本原因。本脚本用 detached + unref 把 vite 拉成孤儿进程，与任何会话解耦。
 *
 * 用法（在 Workbench 目录下）
 *   node scripts/standalone-launcher.mjs            # 启动（已在跑则跳过，幂等）
 *   node scripts/standalone-launcher.mjs --status   # 查看运行状态
 *   node scripts/standalone-launcher.mjs --restart  # 重启
 *   node scripts/standalone-launcher.mjs --stop     # 停止
 *
 * 环境变量
 *   WORKBENCH_PORT   覆盖端口（默认 5173）
 * ---------------------------------------------------------------------------
 */
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const HOST = "127.0.0.1";
const PORT = Number(process.env.WORKBENCH_PORT || 5173);
const LOG_DIR = path.join(ROOT, "logs");
const LOG_FILE = path.join(LOG_DIR, "dev.log");
const PID_FILE = path.join(LOG_DIR, "vite.pid");
const VITE_BIN = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 超过 5MB 轮转

const argv = new Set(process.argv.slice(2));
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const say = (msg) => console.log(`[${stamp()}] ${msg}`);

/** 探测端口是否被占用（TCP connect，快且不受防火墙影响） */
function portInUse(timeout = 900) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(PORT, HOST);
  });
}

/** 解析占用目标端口的 PID 列表（Windows: netstat -ano） */
function listenerPids() {
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      // e.g. "  TCP    127.0.0.1:5173    0.0.0.0:0    LISTENING    30508"
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (!m) continue;
      if (Number(m[1]) !== PORT) continue;
      pids.add(Number(m[2]));
    }
    return [...pids];
  } catch {
    return [];
  }
}

/** 连同子进程一起杀掉 */
function killTree(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function rotateLogIfNeeded() {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
      say("日志已轮转 → logs/dev.log.1");
    }
  } catch {
    /* 轮转失败不影响启动 */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 问一下端口上的服务是谁：读 /api/runtime 拿它当前挂着的 Vault 名。
 *
 * 为什么需要：端口被占用时只报"已在运行"很容易误判 —— 可能是你另一个 Vault 的
 * 实例，也可能是完全无关的程序。两种情况下的下一步完全不同（前者直接用，
 * 后者得换端口），所以说清"读的是哪个 Vault"比说"在跑"有用得多。
 */
function probeRuntimeLabel(timeout = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.get({ host: HOST, port: PORT, path: "/api/runtime", timeout }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          done(JSON.parse(body)?.vault?.label || "(未命名 Vault)");
        } catch {
          done(null);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      done(null);
    });
    req.on("error", () => done(null));
  });
}

async function main() {
  if (!fs.existsSync(VITE_BIN)) {
    console.error(
      `[错误] 找不到 vite：${VITE_BIN}\n` +
        `       请先在 ${ROOT} 目录执行 npm install`,
    );
    process.exit(1);
  }

  const running = await portInUse();
  const pids = running ? listenerPids() : [];
  const label = running ? await probeRuntimeLabel() : null;
  const labelText = label || "（/api/runtime 无响应 —— 可能不是 Workbench，或还在冷启动）";

  // ---- status ----
  if (argv.has("--status")) {
    if (running) {
      say(`运行中 → http://${HOST}:${PORT}/  (PID ${pids.join(", ") || "未知"})`);
      say(`Vault  ${labelText}`);
    } else {
      say("未运行");
    }
    return;
  }

  // ---- stop ----
  if (argv.has("--stop")) {
    if (!running) {
      say("未运行，无需停止");
      return;
    }
    if (!pids.length) {
      say("端口被占用但无法解析 PID，请手动检查");
      return;
    }
    for (const pid of pids) {
      say(`${killTree(pid) ? "已停止" : "停止失败"} PID ${pid}`);
    }
    return;
  }

  // ---- restart / 单例检查 ----
  if (running) {
    if (!argv.has("--restart")) {
      say(`已在运行 → http://${HOST}:${PORT}/ ，跳过启动`);
      say(`Vault  ${labelText}`);
      if (!label) {
        say(`若不是你要的实例，换个端口：set WORKBENCH_PORT=5199 后再跑一次`);
      }
      return;
    }
    for (const pid of pids) {
      say(`${killTree(pid) ? "已停止旧进程" : "停止失败"} PID ${pid}`);
    }
    await sleep(1200);
  }

  // ---- start（detached，彻底脱离父会话）----
  fs.mkdirSync(LOG_DIR, { recursive: true });
  rotateLogIfNeeded();

  const logFd = fs.openSync(LOG_FILE, "a");
  fs.writeSync(logFd, `\n===== ${stamp()} 启动 (node ${process.version}) =====\n`);

  // 端口必须显式传给 vite。上游 vite.config.mjs 的 server 段没有 port 字段，
  // 只设 WORKBENCH_PORT 的话 vite 仍会去抢 5173，而本脚本却去探测你指定的端口，
  // 结果是"明明起来了却报启动失败"。
  // --strictPort：5173 被占用时直接报错退出，而不是静默换到 5174 之类的端口。
  const child = spawn(process.execPath, [VITE_BIN, "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });

  fs.writeFileSync(PID_FILE, String(child.pid));
  child.unref();

  // 轮询等待端口就绪
  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await portInUse(600)) {
      up = true;
      break;
    }
    if (child.exitCode !== null) break; // 进程提前退出 = 启动失败
  }

  if (up) {
    const serving = await probeRuntimeLabel();
    say(`启动成功 → http://${HOST}:${PORT}/  (PID ${child.pid})`);
    if (serving) say(`Vault  ${serving}`);
    say(`日志：${LOG_FILE}`);
  } else {
    say("启动失败或超时，请查看日志：");
    say(`   ${LOG_FILE}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[standalone] 未捕获错误：", err);
  process.exit(1);
});
