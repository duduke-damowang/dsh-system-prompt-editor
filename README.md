# dsh-system-prompt-editor

在 DeepSeek Harness 的**设置页**里维护多套系统提示词，随时切换当前生效项；生效内容会作为
`systemPrompt` section 注入后续每一次模型装配。

设置里集中维护几套提示词（写作助手 / 代码审查 / 翻译……），点一下切换，下一轮对话立即生效，
不必改文件，也不必重启。

## 功能

- **多套提示词**：新增、重命名、编辑、删除、复制，列表里标出「当前」生效项
- **一键切换**：设置页顶部下拉框，或底部「设为当前」按钮
- **命令切换**：`/system-prompt-switch 写作助手`（也接受 id，不带参数则列出全部）
- **空内容不注入**：提示词为空或只有空白时，不会往系统提示词里塞空段
- **最后一套不可删**：避免误删到没有任何提示词可用的状态

## 安装

```bash
# 在 DSH 桌面端 → 设置 → 插件 里安装，或：
dsh plugin install dsh-system-prompt-editor
```

要求 DSH `0.2.0-rc.2`（`package.json` 的 `dshTarget`）。

装好后打开 **设置 → 系统提示词**。

## 数据存放

提示词存在 `$DSH_HOME/.dsh-system-prompt-store.json`，纯 JSON，可以直接备份或手改。

三种异常都不会让插件挂掉：

| 情况 | 行为 |
|---|---|
| 文件是坏 JSON | 原文件改名为 `.corrupt-<时间戳>` **保留**（不销毁），重建默认数据并在界面提示 |
| 磁盘写不进去 | 降级为内存模式继续可用，界面提示「重启后丢失」 |
| 数据结构不对 | 重建默认数据，界面提示 |

写入用「临时文件 + rename」原子替换，不会出现写一半的半截文件。

## 实现要点

- **Host 半区**：`PromptStore`（持久化 + 降级）、9 个 RPC 方法、同源校验、切换命令、section 注册
- **Client 半区**：`settings.section` 插槽里的一页 UI，纯 JavaScript（浏览器直接执行，不能是 TS/JSX）
- **注入点**：`ctx.systemPrompt.section({ name, order, text })`，`order = 4000`
  （官方 `SECTION_ORDERS` 里工具文档最大是 `MCP_SERVERS 3100`，SDK 段从 `TOOLS_SDK 5000` 开始，
  4000 落在中间的空位，不与任何官方段撞号）

### 为什么有构建步骤

Node 对 `node_modules` 下的文件**拒绝**做 TypeScript 类型擦除
（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），而插件恰恰装在 profile 的 `node_modules` 里。
所以 Host 半区用 TypeScript 写在 `src/host/index.ts`，构建成 `lib/host/index.js` 再发布：

```bash
node scripts/build.mjs          # 构建
node scripts/build.mjs --check  # 校验 lib/ 与 src/ 一致
```

### 测试

```bash
node --test tests/host.test.mjs   # 10 个用例
```

测试跑的是**构建产物** `lib/host/index.js`，对着临时 `DSH_HOME` 和一个最小假的 `ctx`，
覆盖存储语义、注入 section、RPC 路由（含跨域拒绝与类型化错误）和切换命令。

## 借鉴与本插件功能

### 借鉴的部分

| 来源 | 许可 | 借鉴了什么 |
|---|---|---|
| **[dsh-purge](https://github.com/YuJunZhiXue/dsh-purge)**（YuJunZhiXue） | MIT，**要求署名** | **HTTP 路由注册与同源校验的写法**。`kind: 'exact'` 注册路由、`sec-fetch-site: cross-site` 拒绝、`origin === 'null'` 拒绝、origin host 与 host 比对——`allowSameOrigin()` 的结构与之相同。另外「临时文件 + rename」的原子写思路借鉴自其 `core.js`。**特此署名并致谢。** |
| **[dsh-chat-manager](https://github.com/WSL043/dsh-chat-manager)**（WSL043） | MIT | bundle 插件的包结构：`package.json` 的 `dsh.bundle` / `dsh.client` 声明、`cordis.patch.yml` 的一行 `insert` |
| **官方 `cordis-plugin-development` skill** | 随 DSH 分发 | 插件骨架、`settings.section` 注册方式、UI 半区约定 |
| **官方 `dsh-system-prompt` 源码** | 随 DSH 分发 | `SECTION_ORDERS` 排序表；`assembleContextFor` 实际传入 `{ agent, scope }` 的行为 |

`ctx.webServer.register` 的用法在官方文档中未涉及，其调用形式借鉴自 dsh-purge 源码。

以下项目**未**作为借鉴来源：`LiKanGame/dsh-custom-context-injector`、`openharness-core-rule`
——仅检索到名称，未取得源码。

### 本插件增加了什么

1. **多套提示词管理**——新增、重命名、编辑、删除、复制，列表标出「当前」生效项，
   并支持一键切换。存储带异常兜底：坏文件改名保留、写失败降级内存、结构非法重建。
2. **9 个 RPC 方法**，统一 `system-prompt/` 前缀；错误返回类型化 code
   （`not-found` / `invalid-argument` / `last-prompt` / `cross-origin` / `method-not-found`）。
3. **切换命令**——`/system-prompt-switch`，先按 id 再按名称解析，不带参数则列出全部。
4. **空内容不注入**——提示词为空或只有空白时，不往系统提示词里塞空段。
5. **最后一套不可删**——避免误删到没有任何提示词可用的状态。
6. **10 个测试用例**——跑真实构建产物、真实临时 `DSH_HOME`、真实 RPC 请求/响应对象，
   覆盖存储语义、注入 section、跨域拒绝与类型化错误。
7. **构建步骤**——Host 半区用 TypeScript 写在 `src/`，构建到 `lib/`。
   原因是 Node 对 `node_modules` 下的文件拒绝做 TypeScript 类型擦除
   （`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），而插件就装在 profile 的 `node_modules` 里。

## 已知限制

- 注入位置固定在 `order = 4000`，不提供界面调整
- 只管理「当前生效」的那一套注入，未做按 agent / 按模型分别指定
- 未做导入 / 导出，提示词存在单个 JSON 文件里

## 许可

MIT。见 [LICENSE](LICENSE)。

使用 dsh-purge 的路由/同源校验写法已在上方署名；若你二次开发本项目，请同样保留该署名。
