# 🇺🇸 美股周报（每周一早晨自动送达）

一个跑在 **GitHub Actions** 上的自动化任务：每周一北京时间早上 8 点，自动抓取最新的美股新闻、
本周经济数据日历、未来两周重要财报、SEC 8-K 重大公告和各类关键日期，用 AI 生成一份**中文前瞻周报**，
并推送到企业微信 / 钉钉 / 飞书群机器人。

> 目标不是"事后复述发生了什么"，而是**在事件发生之前**让你知道"为什么要关心它"。

---

## 一、每期报告包含什么

| 板块 | 内容 | 数据来源 |
|---|---|---|
| 📌 一周要点速览 | 3-5 条最需要关注的事 | AI 汇总 |
| 🗓 本周关键日程 | 美国经济数据：CPI / 非农 / PCE / GDP / ISM / 初请 … 含预期值与前值，并逐条解释"为什么要关心" | Nasdaq 经济日历 |
| 📊 重点财报前瞻 | 未来两周市值 ≥ 200 亿美元的财报，含盘前/盘后、预期 EPS、去年同期 EPS、覆盖分析师数 | Nasdaq 财报日历 |
| 🔭 前瞻日历 | FOMC 议息、月度期权到期、四巫日、指数季度再平衡、NYSE 休市日 | 美联储官网 + 规则推算 |
| 📰 上周要闻回顾 | 宏观政策 / 科技AI / 财报个股 / 关税地缘 分类，带原文链接 | CNBC / MarketWatch / WSJ / 美联储 RSS |
| 📎 SEC 8-K 重大公告 | 自选股（50 家大市值公司）的 8-K，含事项编号解读（如"高管变动 5.02"） | SEC EDGAR |

覆盖周期：**运行当周（美东时间周一 ~ 周日）**。全文末尾附免责声明。

---

## 二、5 分钟部署

### 第 1 步：创建仓库

把本项目推送成一个 GitHub 仓库即可（public / private 均可，见下方"注意事项"）。

### 第 2 步：添加 Secrets

仓库页面 → **Settings** → 左侧 **Secrets and variables** → **Actions** → **New repository secret**

| Secret 名称 | 是否必填 | 说明 |
|---|---|---|
| **DEEPSEEK_API_KEY** | 必填（要 AI 解读） | DeepSeek API Key，见下方获取方式 |
| **WECOM_WEBHOOK** | 三选一 | 企业微信群机器人 Webhook 完整 URL |
| **DINGTALK_WEBHOOK** | 三选一 | 钉钉群机器人 Webhook 完整 URL |
| **DINGTALK_SECRET** | 可选 | 钉钉机器人若启用了「加签」则必填 |
| **FEISHU_WEBHOOK** | 三选一 | 飞书群机器人 Webhook 完整 URL |
| **SERVERCHAN_KEY** | 可选 | Server酱 SendKey |
| **PUSHPLUS_TOKEN** | 可选 | PushPlus token |

**填了哪个就推哪个，留空的自动跳过。** 只想本地产物不推送，则全部留空。

### 第 3 步：确认 Actions 已启用

仓库 **Actions** 标签页 → 若提示需要启用，点确认。可以在 **美股周报** 工作流里点
**Run workflow** 手动跑一次验证。

---

## 三、各渠道 Webhook 怎么拿

### 企业微信（推荐，最稳）

1. 手机/桌面企业微信 → 进入目标群 → 右上角 **⋯** → **群机器人** → **添加机器人**
2. 起个名字（如"美股周报"）→ 复制 **Webhook 地址**
3. 形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx
4. 把它填进 **WECOM_WEBHOOK**

> 企微单条 markdown 上限约 4KB，程序会自动分片，拆成 "(1/3)、(2/3)…" 连续发送。

### 钉钉

1. 钉钉群 → **群设置** → **智能群助手** → **添加机器人** → **自定义**
2. **安全设置**建议勾选「加签」，复制 **Webhook** 和 **加签密钥**（以 SEC 开头）
3. 填 **DINGTALK_WEBHOOK** 和 **DINGTALK_SECRET**
4. 若你选的是「自定义关键词」，请确保关键词包含在报告正文中（报告标题含"美股"）

### 飞书

1. 飞书群 → **设置** → **群机器人** → **添加机器人** → **自定义机器人**
2. 复制 **Webhook 地址**，填 **FEISHU_WEBHOOK**
3. 程序以「消息卡片」形式发送，正文为 lark_md，Markdown 表格会退化为列表文本

### DeepSeek API Key

1. 打开 https://platform.deepseek.com/api_keys
2. 创建一个 API Key（形如 sk-...）
3. 填进仓库 Secret **DEEPSEEK_API_KEY**

> 成本参考：每期输入约 1.5 万 token、输出约 2 千 token，使用 deepseek-chat，
> **每期成本远低于 1 分钱人民币**，一年几十期总共也就几毛钱。

---

## 四、时间说明

工作流里的 cron 是 **UTC**：

    cron: '0 0 * * 1'     # 每周一 00:00 UTC = 北京时间 08:00

因为中国不实行夏令时，**全年都是北京时间周一早上 8:00**，无需调整。

⚠️ GitHub 的定时任务在整点高峰期可能**延迟几分钟到一小时左右**执行，这是平台行为，无法避免。
如果某次没跑，可以在 Actions 页面点 **Run workflow** 手动补一次。

---

## 五、本地预览（可选）

需要 Node.js ≥ 20（用到内置 fetch）。

    # 只生成报告、不推送
    node src/main.mjs --dry-run

    # 只测试推送通道是否配通
    WECOM_WEBHOOK='https://...' node src/main.mjs --test-push

    # 正常跑（等同于 Actions 里的行为）
    DEEPSEEK_API_KEY='sk-...' WECOM_WEBHOOK='https://...' node src/main.mjs

产物会写到 out/ 目录：

- **latest.md / latest.html** — 最新一期（HTML 可直接浏览器打开，自适应深色模式）
- **YYYY-MM-DD.md / .html** — 按期归档
- **raw-data.json** — 本期全部原始结构化数据（便于排查）
- **raw-data.md** — 喂给 AI 的结构化输入

---

## 六、自定义

改 **config/default.json** 即可，无需动代码：

| 字段 | 说明 |
|---|---|
| news.limit | 报告里保留的新闻条数（默认 22） |
| news.maxAgeDays | 新闻回溯天数（默认 8） |
| earnings.minMarketCap | 财报市值门槛（默认 200 亿美元） |
| earnings.days | 财报前瞻天数（默认 14） |
| econ.days | 经济日历天数（默认 6，即本周一到周六） |
| keyDatesDays | 关键日期前瞻天数（默认 45） |
| edgar.watchlist | 关注 8-K 的股票代码列表 |
| llm.model | 使用的模型，默认 deepseek-chat |
| llm.enabled | 设为 false 可关闭 AI，只输出规则聚合版 |

也可以用**环境变量**覆盖（优先级更高）：

    LLM_PROVIDER / LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
    SEC_CONTACT_EMAIL        # SEC 要求 UA 中带邮箱，默认 weekly-brief@example.com

---

## 七、常见问题

**Q：私有仓库的定时任务会停？**
会。GitHub 对 **private** 仓库的 schedule 有规定：**连续 60 天无仓库活动就自动停用**定时任务。
解决办法：把仓库设为 **public**（本项目不含任何私密信息），或者每两个月随便提交一次。

**Q：能不能一周跑两次？**
把 cron 改成 0 0 * * 1,4（周一和周四）即可。周四那次会覆盖同一周，内容更聚焦后半周。

**Q：AI 挂了会怎样？**
不会中断。程序会自动退回到**规则聚合版**（标题+摘要分类排序），在报告顶部标注
"本期 AI 解读不可用"，并把警告写进 Actions 日志。

**Q：某个数据源挂了会怎样？**
每个数据源独立容错，失败的板块显示"_暂无数据_"，其余照常，日志里会有 ! 警告。

**Q：想改成每月一次？**
cron 改成 0 0 1 * *（每月 1 号），同时把 config/default.json 里的
earnings.days 调大到 30、keyDatesDays 调到 60。

**Q：报告太长，企微收到很多条？**
程序按 4KB 自动分片，属于预期行为。若只想收一条精简版，可在 src/main.mjs 里
把 deliverAll(...) 的 fullMd 换成 shortMd（已内置精简版渲染函数）。

---

## 八、目录结构

    .github/workflows/weekly-brief.yml   定时任务定义
    src/main.mjs                         编排：采集 → 渲染 → AI → 推送 → 落盘
    src/sources.mjs                      数据源：新闻 / 经济日历 / 财报 / 8-K / 关键日期
    src/render.mjs                       渲染 Markdown 与自包含 HTML
    src/llm.mjs                          OpenAI 兼容的模型调用
    src/deliver.mjs                      企业微信 / 钉钉 / 飞书 / Server酱 / PushPlus
    src/util.mjs                         网络、RSS 解析、日期工具
    config/default.json                  非敏感配置
    scripts/publish-to-github.mjs        一键建仓并上传全部文件（本机执行，需要 PAT）
    out/                                 运行产物（已被 .gitignore 忽略）

---

## 免责声明

本项目所有内容均由自动化程序抓取公开数据并借助 AI 生成，**仅供信息参考，不构成任何投资建议**。
数据源的准确性、完整性与时效性由原始提供方决定，请以官方披露为准。
