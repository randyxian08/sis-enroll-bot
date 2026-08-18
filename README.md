# SIS Enroll Bot — HKU 选课机器人

两个引擎，一个面板：

- **抢课**：选课开放瞬间自动完成报名提交（Enrollment Shopping Cart）。
- **捡漏**：add/drop 期间蹲守满员课程，有人退课出现空位时立即自动提交（Enrollment Add Classes）。
- **可视化面板**：注入后页面右下角出现控制面板，点按钮即可操作，不用碰命令行。

面向 `sis-main.hku.hk`（PeopleSoft SIS）。新手请直接看 [使用教程](TUTORIAL.md)。

> ⚠️ 仅供学习与研究浏览器自动化、PeopleSoft 协议使用。使用本工具可能违反学校系统的使用条款，风险自负。

## 复盘：2026-08-18 实战记录

选课开放日真打了一次，时间线和教训如下。

**时间线**

- 09:45 定时任务自动上线，双车课程确认（Sem 1 × 6，Sem 2 × 5），dryRun 通过；
- 09:59:59.995 开火，误差 5ms；
- 10:00-10:07 服务器过载：单 POST 从 164ms 恶化到 11s → 48s → 120s 超时。重试窗口（默认 120s）在第一波耗尽；
- 10:07 起服务器开始返回「启动页」（ICStateNum 过期的响应，innerText 全是 JS 源码），旧版引擎每次都用实时页面的旧表单，连撞 9 次；
- 现场打补丁：v11 给所有无超时 fetch 加 5s 超时（防对表挂死）；v12 每次尝试改为 GET 新鲜组件页拿当前状态号；
- 11:01 v12 生效，Sem 1 当场成交（4 门成功，MATH 1013 前置不足、SDST 1016 满员）；Sem 2 两门摇号课（AILT/CCAI）成交；
- 11:02 Sem 2 轮次把「processing/wait list」过渡页误判为完成，提前收工，3 门课留在车里（后手动补选）。

**事故与修复（已全部进入代码）**

| 问题 | 教训 | 修复 |
|---|---|---|
| 无超时 fetch 在服务器过载时永久挂起，对表流程冻死 | 任何 fetch 都要有超时 | v11：HEAD 请求统一 5s 超时，对表失败降级为 offset=0 靠重试窗口兜底 |
| ICStateNum 过期，服务器回启动页 | PeopleSoft 状态号一次性消费，表单必须用最新的 | v12：每次尝试 GET 新鲜组件页，不使用实时页面的旧表单；响应异常自动重取 |
| 过渡页（processing/wait list）被判「完成」 | 只有 success/error 才算落定 | v13：结果页无 success/error 行时按未成交继续重试 |
| 用户三次误刷新/误停，引擎被杀 | 引擎活在页面里，页面是会被人碰的 | 面板「停止」加二次确认；新增 `sis-bot.sh watch` 看门狗，30s 内自愈重注入 |
| 学年写死 2026-27 | 明年直接报废 | v13 + snipe v2：按 "Sem N" 后缀匹配，学年自适应 |
| 标签页后台被 Chrome 钳制定时器（最低到 1 分钟粒度） | 开火和蹲守都必须前台 | 引擎内置钳制侦测告警；开火前用 osascript 把窗口拉到前台 |

**给下一年的操作清单**

1. 开抢前一天：更新开闸时间，`dryrun` 验证，挂 `nohup ./sis-bot.sh watch "T1" "T2" &`；
2. 当天：提前 30 分钟登录（登录态一两天就过期），标签页前台，电脑插电源；
3. 服务器必崩，别慌——重试窗口建议直接给 15 分钟（`retryWindowMs: 900000`）；
4. 摇号课（Pending Approval）不受先到先得影响，不用抢，只有真·拼手速的课值得压毫秒。

## 合规与风险

对照 HKU 成文规定逐条核过：

- [Campus Network Acceptable Use Policy](https://its.hku.hk/policies/campus-network-acceptable-use-policy/) 禁止的是扫描、入侵、拖垮带宽——机器人用自己的登录态、发与手动一致的请求、总量十几个，均不涉及；
- Statement of Ethics on Computer Use 管的是未授权访问与干扰系统，同样不涉及；
- 各学院选课规程只讲流程，无任何条文禁止「自动化自己的选课操作」。

没有明文禁止 ≠ 学校认可。实际风险排序：长时间高频轮询触发 WAF 临时封 IP > 学校升级风控 > 纪律处分（无先例）。降险建议：抢完即停、捡漏间隔 ≥ 5 秒、低调使用。

## 原理

PeopleSoft 没有独立的「选课 API」：所有操作都向同一个 `.GBL` 表单地址提交 POST，靠 `ICAction` 字段区分动作。机器人跳过「点按钮 → 等渲染 → 再点按钮」的人工流程，在页面上下文里直接用 `fetch` 重放表单提交：

```
Select Term → 选课车（Step 1）→ Proceed to Step 2（Confirm classes）→ Finish Enrolling → View results
```

整条流程 2~3 个 POST，开窗后约 0.1~0.5 秒完成。人工操作需要两次点击和约 40 秒的加载等待。

多个轮次（Sem 1、Sem 2）**并发执行**：每轮独立对表、独立预热、独立开火、独立重试。两个学期同时开闸时互不等待；学期选择通过覆盖提交参数实现，不触碰共享 DOM，并发时不会串台。

捡漏模式同样走表单重放，只是目标换成 Add Classes 页：每轮轮询读取 Temporary Course List 里目标课的 Open/Closed 状态，出现 Open 立即 Proceed to Step 2 → Finish Enrolling。同一学期的所有目标共享一次页面加载，监控 10 门课和 1 门课的网络开销相同。

## 延迟优化

| 优化 | 术语 | 收益 |
|---|---|---|
| 开火前并发预热 3 条 keep-alive 连接 | Connection pool pre-warming、TLS session resumption | 省去 DNS、TCP、TLS 开销，约 55ms~1s |
| HTTP Date 头秒翻转相位检测，亚秒级对时 | Clock skew compensation、phase detection | 时钟误差 ±1000ms → ±60ms |
| T-8s 预序列化表单请求体 | Payload pre-serialization、critical-path hoisting | 开火时无 DOM 开销 |
| 开窗前 60ms 投机式发射，失败后每 300ms 重试 | Speculative firing、lead time、fixed-interval retry | 补偿 RTT，容忍服务器晚开 |
| 粗等待 → 细轮询 → 末 20ms 自旋的调度器 | Precision scheduling、spin-wait | 消除 setTimeout 钳制误差 |
| 后台节流侦测与告警 | Timer throttling detection | 防止标签页在后台时定时器被钳制到 1s 以上 |
| 捡漏轮询加 ±20% 随机抖动 | Jitter | 请求间隔不规律，避免被当成机械流量 |

## 快速上手

机器人通过 [Kimi WebBridge](http://127.0.0.1:10086) 注入到已登录的 SIS 页面。详细安装步骤见 [TUTORIAL.md](TUTORIAL.md)。

### 抢课（选课开放日）

```bash
./sis-bot.sh nav cart        # 打开选课车页面（课程提前加进 Temporary Course List）
./sis-bot.sh inject          # 注入抢课引擎 + 面板
./sis-bot.sh dryrun          # 演练：验证流程，封窗期预期返回 blocked:true
./sis-bot.sh start "2026-08-18T10:00:00+08:00" "2026-08-18T10:10:00+08:00"
./sis-bot.sh status          # 看日志
./sis-bot.sh stop            # 停止
```

### 捡漏（add/drop 期间）

```bash
./sis-bot.sh nav add                    # 打开 Enrollment: Add Classes 页面
./sis-bot.sh inject-snipe               # 注入捡漏引擎 + 面板
./sis-bot.sh check "12345,1 23456,2"    # 查一次状态（1=Sem 1，2=Sem 2）
./sis-bot.sh snipe "12345,1 23456,2" 5000   # 开始蹲守，间隔 5 秒
./sis-bot.sh snipe-status               # 看日志
./sis-bot.sh snipe-stop                 # 停止
```

课号（Class Nbr，4-5 位数字）在 Class Search 搜索结果或个人课表里查。也可以在控制台直接调用：

```js
window.__snipeBot.start({
  targets: [{ nbr: "12345", term: 0 }],  // term: 0 表示 Sem 1，1 表示 Sem 2
  intervalMs: 5000,
});
```

### 可视化面板

`inject` 或 `inject-snipe` 都会同时注入面板（`panel.js`）。页面右下角出现悬浮卡片：

- 「抢课」页签：设置两个学期的开闸时间，一键演练/开始/停止；
- 「捡漏」页签：填写目标课号列表，一键查状态/蹲守/停止；
- 「日志」页签：两个引擎的实时日志合并显示，可复制。

配置存在 `localStorage`，刷新页面不丢。面板可拖拽、可折叠。

## 运行前提

- 课程已提前放入对应学期的 Temporary Course List（加入选课车不受时间窗限制）；捡漏模式会自动把目标课号 Enter 进列表。
- 保持标签页前台可见、电脑不休眠。后台标签页的定时器会被浏览器钳制。
- 登录态有效。抢课引擎每 15 秒预热一次连接，捡漏引擎的轮询本身即保活。

## 行为细节

- 按钮不写死 ID。PeopleSoft 的 ICAction 后缀（如 `$82$`）会变，机器人按按钮文字和 ID 前缀双重匹配（「Proceed to Step 2 of 3」「Enroll」「Finish Enrolling」）。
- 每轮结束后解析 View results 页每门课的 success/error 图标，并写入日志。
- 开火后**任何非成功响应**（封窗提示、未识别文案、异常页）都会持续重试：封窗提示每 300ms 一发，其余 800ms 一发，直到重试窗口结束——**服务器晚开（如 10:01 才开放）也能捕捉**。窗口默认 120 秒，面板「重试窗口」可调大（担心晚开更久就设 300）。
- 捡漏状态判定读表格行内的 Open/Closed/Wait List 图标与文本，识别不出时按 unknown 处理并记录该行原文，不会误提交。
- 运行状态写入 `document.title`，完整日志可通过 `window.__enrollBot.getLogs()` / `window.__snipeBot.getLogs()` 读取。

## 文件

- `enroll-bot.js`：抢课引擎，注入选课车页面。
- `snipe-bot.js`：捡漏引擎，注入 Add Classes 页面。
- `panel.js`：可视化控制面板，随任一引擎注入。
- `sis-bot.sh`：WebBridge 启动器，子命令见上文。
- `TUTORIAL.md`：从零开始的完整教程。
