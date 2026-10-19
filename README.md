# 小茉（xiaomo-ai）

陪伴型 Agent。设计目标只有一句话：**它记得住事，还会主动找你。**

- **后端零依赖**：只用 Node 22 自带的 `node:sqlite`、`node:http`、`node:fs`，没有 npm 运行时依赖
- **前端**：Vite + React + TypeScript，构建产物由后端在 `/` 托管（手机浏览器打开就是"类 App"）
- **桌面端**：Tauri 2 外壳，打包成 Windows 安装包

## 环境要求

- **Node.js ≥ 22.18** —— 用到 `node:sqlite` 与原生 TypeScript 类型擦除，后端脚本一律带 `--experimental-sqlite`
- 桌面开发/打包额外需要：**Rust 工具链** + **Tauri CLI**（`cargo install tauri-cli --version "^2"`）

## 快速开始

```bash
npm install
npm --prefix frontend install
cp .env.example .env        # Windows: Copy-Item .env.example .env
npm run dev
```

然后打开 <http://127.0.0.1:8787>。

默认 `MODEL_MODE=echo`：本地假回复，不花钱、不依赖网络，用来先把界面与记忆链路跑通。

### 接入真实模型

两种方式，都生效即改：

1. **应用内改（推荐）**：<http://127.0.0.1:8787/settings> → 「主模型接入」/「能力模型」，填 Base URL、API Key、模型名，可点「测试连接」实测
2. **改 `.env`**：`MODEL_BASE_URL` / `MODEL_API_KEY` / `MODEL_NAME`

应用里改的值存在数据库，优先级高于 `.env`；`.env` 只给"没在界面上配过"的情况兜底。任何 OpenAI 兼容服务都能接。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 浏览器里跑，改后端自动重启（<http://127.0.0.1:8787>） |
| `npm run app` | 桌面窗口里跑（Tauri），前端热更新 |
| `npm run check` | 类型检查（后端 + 前端，Vite 不做类型检查，这条要进流程） |
| `npm run doctor` | 环境与配置自检，会列出服务商可用模型并逐个实测 |
| `npm run smoke` | 冒烟测试，跑源码、离线（echo 模式） |
| `npm run desktop:build` | 打 Windows 安装包（需要自备 Tauri 更新签名私钥） |
| `npm run help` | 列出真正要记的那几条命令 |

## 目录结构

```
src/            后端：Agent 循环、记忆、主动性、通道、设置（零依赖 TS）
frontend/       前端：Vite + React + TS
shared/         前后端共用的类型定义
src-tauri/      Tauri 2 桌面外壳（Rust）
scripts/        构建、打包、校验与冒烟测试
data/           运行时数据（聊天记录 / 记忆 / 密钥），不入库
```

## 安全须知

- **所有 `/api/*` 都没有鉴权**。默认只监听 `127.0.0.1`；直接把服务暴露到公网等于公开聊天记录。
  需要公网访问时自己加鉴权，或只在可信隧道之后使用（隧道域名要写进 `TRUSTED_HOSTS`，否则会被主机守卫 403）。
- 聊天记录、记忆、模型 API Key 都保存在本机 `data/`（默认 `./data/xiaomo.db`）——密钥默认不离开这台机器。
- `DEV_MODE=1` 会把模型请求原文（含系统提示词）暴露给界面，只用于本地排查。

## 状态

- 桌面端（Windows）是主线；手机用浏览器访问，支持"添加到主屏幕"。
- **Android APK 已停止维护**：平台限制（Android 10 起禁止从应用数据目录执行文件），"外壳启动本地 Node 后端"这套架构在 Android 上做不到，详见 `src-tauri/src/lib.rs` 平台分叉处的说明。

## 许可证

[Apache License 2.0](LICENSE) · Copyright 2026 dmw-net

源码仓库：<https://github.com/dmw-net/xiaomoAgent>