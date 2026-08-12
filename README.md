# SIS Enroll Bot — HKU 选课自动报名机器人

在选课开放瞬间自动完成 PeopleSoft SIS 的报名提交。面向 `sis-main.hku.hk`（Enrollment Shopping Cart / SSR_SSENRL_CART）。

> ⚠️ 仅供学习与研究浏览器自动化、PeopleSoft 协议使用。使用本工具可能违反学校系统的使用条款，风险自负。

## 原理

PeopleSoft 没有独立的"选课 API"——所有操作都是向同一个 `.GBL` 表单地址发 POST，靠 `ICAction` 字段区分动作。机器人绕过"点按钮 → 等渲染 → 再点按钮"的人肉流程，在页面上下文里直接用 `fetch` 重放表单提交：

```
Select Term → 选课车(Step 1) → Proceed to Step 2(Confirm classes) → Finish Enrolling → View results
```

整条链 2~3 个 POST，开窗后约 0.1~0.5 秒完成（真人两次点击 + 转圈约 40 秒）。

## 延迟优化

| 优化 | 术语 | 收益 |
|---|---|---|
| 开火前并发预热 3 条 keep-alive 连接 | Connection pool pre-warming / TLS session resumption | 省 DNS+TCP+TLS ≈ 55ms~1s |
| HTTP Date 头秒翻转相位检测，亚秒级对时 | Clock skew compensation / phase detection | 时钟误差 ±1000ms → ±60ms |
| T-8s 预序列化表单请求体 | Payload pre-serialization / critical-path hoisting | 开火零 DOM 开销 |
| 开窗前 60ms 投机式发射 + 300ms 重试 | Speculative firing / lead time + fixed-interval retry | 补偿 RTT，容忍服务器晚开 |
| 粗等待→细轮询→末 20ms 自旋的调度器 | Precision scheduling / spin-wait | 消除 setTimeout 钳制误差 |
| 后台节流侦测 + 告警 | Timer throttling detection | 防止标签页后台时定时器被钳到 1s+ |

## 用法

机器人通过 [Kimi WebBridge](http://127.0.0.1:10086) 注入到已登录的 SIS 页面（也可以直接把 `enroll-bot.js` 全文粘贴到浏览器控制台，然后手动调用 `window.__enrollBot`）。

```bash
# 1. 浏览器登录 SIS，打开 Enrollment Add Classes 页面
# 2. 把要报的课提前加进 Temporary Course List（选课车，Sem 1 / Sem 2 各自独立）
# 3. 注入机器人
./sis-bot.sh inject

# 4. 演练（不提交，验证链路；封窗期预期返回 blocked:true）
./sis-bot.sh dryrun

# 5. 启动定时报名（Sem1 10:00 开，Sem2 10:10 开）
./sis-bot.sh start "2026-08-18T10:00:00+08:00" "2026-08-18T10:10:00+08:00"

# 查看日志 / 停止
./sis-bot.sh status
./sis-bot.sh stop
```

也可以在控制台直接调用：

```js
window.__enrollBot.start({rounds:[
  {openTime:"2026-08-18T10:00:00+08:00", term:0},  // term: 0=Sem 1
  {openTime:"2026-08-18T10:10:00+08:00", term:1},  //       1=Sem 2
]});
```

## 运行前提

- 课程已提前放入对应学期的 Temporary Course List（加车不受时间窗限制）
- 保持标签页前台可见、电脑不休眠（后台标签页的定时器会被浏览器钳制）
- 登录态有效（机器人每 15s 预热连接兼作保活）

## 行为细节

- 按钮不写死 ID：PeopleSoft 的 ICAction 后缀（如 `$82$`）会变，机器人按按钮文字 + ID 前缀双重匹配（"Proceed to Step 2 of 3" / "Enroll" / "Finish Enrolling"）
- 每轮结束解析 View results 页每门课的 success/error 图标并写入日志
- 服务器返回封窗提示（`outside course selection period`）时每 300ms 重试，窗口最长 120s
- 所有状态通过 `document.title` 和 `window.__enrollBot.getLogs()` 可查

## 文件

- `enroll-bot.js` — 机器人本体（注入页面运行）
- `sis-bot.sh` — WebBridge 启动器（inject / dryrun / start / status / stop）
