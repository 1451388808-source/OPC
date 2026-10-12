# OPC 一人团队系统

OPC（One Person Company）是给一个人用的公司操作系统。你负责定目标、做取舍、批准对外动作；系统负责记住公司、把事情拆成任务，并按角色把草稿和结果交回来。

第一版是跑在本机上的看板。第二期起，任务、已生效的决定和本周重点记在 MySQL 里；角色手册和长文档仍是文件，人和代理可以直接打开。

第一版做什么以 `docs/功能需求.md` 为准。本文负责结构、角色约定和技术方案。功能与技术方案冲突时，先改功能需求，再改实现。

## 要解决的问题

一个人同时扮演策划、工程、研究和运营时，上下文散落在聊天记录里。下次开工要重新解释公司是谁、这周干什么、上次为什么这么定。OPC 把这些收成仓库里的事实，让每一次执行都从同一份记忆出发。

做好之后，你每天打开系统能回答三件事：

- 这周唯一重点是什么
- 现在正在做哪一件，卡在哪里
- 哪几件正等你批准

## 成功标准

第一版算做成，需要同时满足：

1. 一句需求能变成一条带验收标准的任务，并指定一个角色。
2. 角色的产出是仓库里的文件，路径写在任务上，能直接打开。
3. 改目标、对外发布、推远程、花钱，都会停在「待批准」，你点头之后才落盘到决策记录。
4. 关掉页面再打开，目标、任务和决策都还在。第二期起以 MySQL 为准，刷新页面读的是数据库。
5. 同时处于「进行中」的任务不超过 2 条。

## 设计原则

- **一份记忆。** 第二期起，任务、已生效决定和本周重点以 MySQL 为准。身份、用户笔记、角色手册、研究笔记和草稿仍是文件。数据库写入成功后，再导出 `tasks/*.json` 和对应的 Markdown，供人和代理打开。两边不一致时，以 MySQL 为准。聊天记录是过程。
- **人做决定。** 系统可以起草、实现、检索、罗列下一步。目标变更和对外动作由你确认。
- **角色是手册。** 每个角色是一份职责说明，规定输入、输出和允许碰的文件。第一版不做多个自动互聊的代理。
- **任务是唯一工单。** 没有挂在任务上的工作，视为还没开始。
- **小步可运行。** 每一期结束，本地都能打开看板并走完「收件 → 进行 → 待批 → 完成」。

## 系统边界

第一版服务你自己的本地工作：写代码、整理资料、起草文档、记录决定。使用者只有你，没有账号体系，没有多人或多公司。第二期起，看板读写 MySQL；仓库里的 Markdown 和 JSON 是给人读的副本，外加角色手册和笔记。

## 总体架构

四层，从上到下：

```text
你
 └─ 审批与目标
     └─ 看板（今天做什么 / 卡在哪 / 等你批什么）
         └─ 任务、决定、本周重点（第二期起在 MySQL）
             └─ 文件副本与长文档（company/、tasks/、roles/）
```

数据流是一条闭环：

1. 你在收件箱写下一段话。
2. 策划把它收成任务：背景、验收、负责角色、是否需要批准。
3. 该角色按手册工作，把结果路径写回任务，状态改为待批准。
4. 你批准、退回或改目标。
5. 批准且形成决定的内容，在同一个 MySQL 事务里写入。事务成功后，再刷新 `company/decisions.md` 和对应的任务 JSON。

## 目录结构

```text
.
├── README.md
├── company/
│   ├── identity.md      # 你是谁、公司做什么、约束
│   ├── goals.md         # 本季目标与本周唯一重点
│   ├── decisions.md     # 已拍板的决定和理由
│   ├── customers.md     # 用户、问题、原话
│   ├── notes/           # 研究笔记，有笔记时才出现
│   └── drafts/          # 运营草稿，有草稿时才出现
├── roles/
│   ├── planner.md
│   ├── engineer.md
│   ├── researcher.md
│   └── operator.md
├── tasks/
│   └── t-001.json       # 第一期的任务；第二期起由数据库导出
├── db/
│   └── migrations/      # 第二期：MySQL 建表脚本，按编号顺序执行
├── docker-compose.yml   # 第二期：同时启动看板和 MySQL 8
├── app/                 # 第二期：页面与 Route Handler
│   ├── page.tsx
│   ├── board.css
│   ├── components/
│   └── api/
├── lib/                 # 第二期：状态机、用例、MySQL 与文件导出
│   ├── domain/
│   ├── application/
│   └── infrastructure/
└── Dockerfile           # 第二期：看板镜像，由 compose 启动
```

`company/` 和 `roles/` 在第一期已经建好。`app/`、`lib/`、`db/`、`Dockerfile` 和 `docker-compose.yml` 到第二期再出现。`notes/` 和 `drafts/` 不预建空目录，研究或运营角色第一次写产出时再创建。

## 协作约定

这些约定写进公司记忆和角色手册，执行时以手册里的步骤为准。

- 对公司说话、写文档、写任务标题和验收，用中文。角色 id 用英文：`planner`、`engineer`、`researcher`、`operator`。
- 时间用 Asia/Shanghai，写成 ISO 8601 并带 `+08:00`。`notes` 里的人读时间写成 `YYYY-MM-DD HH:mm`。
- 路径用仓库相对路径和正斜杠。
- `notes` 只追加。每条以 `YYYY-MM-DD HH:mm · 角色 · ` 开头，旧内容保留。
- 每条验收只检查一件事，并且能用「文件在不在、某一节在不在、字段等于什么、命令输出是什么」判定。
- 研究笔记放在 `company/notes/YYYY-MM-DD-短标题.md`。运营草稿放在 `company/drafts/YYYY-MM-DD-短标题.md`，文首标明「草稿，尚未发送」。
- `decisions.md` 里的条目只有在你批准之后才追加。README 和聊天里的方案，在写入该文件之前只是草案。
- 身份里标成「待你填写」的小时数、预算、长期方向，角色不替你编造。

## 公司大脑

四份文档分工固定。角色可以读全部，写权限按下表。

| 文件 | 内容 | 谁可以改 |
| --- | --- | --- |
| `identity.md` | 公司一句话、服务谁、不接什么、时间与技术约束 | 只有你 |
| `goals.md` | 本季 1–3 个目标，本周唯一重点，这周范围之外的事项 | 只有你 |
| `decisions.md` | 日期、决定、理由、关联任务 id | 你批准后由系统追加，不改历史条目 |
| `customers.md` | 用户是谁、要完成的事、原话、尚未验证的假设 | 研究角色起草，你接受后写入 |

`identity.md` 建议固定这几节：公司是什么、为谁、当前阶段、硬约束、工作语言。阶段变化时改这一份，角色下次开工先读它。

`goals.md` 在任何一周只有一个「本周唯一重点」。其他想做的事放在任务板的「之后」，避免四个角色同时拉你的注意力。

`decisions.md` 只追加，格式：

```markdown
## 2026-10-11 · 本周只做文件骨架

- 决定：本周唯一重点是把 company 和 roles 写好。
- 理由：看板和数据库留到这些文件能被阅读之后。
- 任务：t-001
```

## 任务模型

一条任务一份字段，id 形如 `t-001`。第一期先落成 `tasks/t-001.json`。第二期起同一份字段存在 MySQL 的 `tasks` 表里，JSON 文件由写入成功后的导出刷新。

```json
{
  "id": "t-001",
  "title": "把收件箱的一句话收成任务格式",
  "brief": "用户原话，保持不改写",
  "goal": "完成后公司多了什么能力或事实",
  "acceptance": [
    "有一份可读的任务文件",
    "写明负责角色和验收条目"
  ],
  "role": "planner",
  "status": "inbox",
  "priority": "now",
  "artifacts": [],
  "notes": "",
  "needsApproval": true,
  "blockReason": "",
  "decision": null,
  "createdAt": "2026-10-11T21:00:00+08:00",
  "updatedAt": "2026-10-11T21:00:00+08:00"
}
```

字段约定：

| 字段 | 含义 |
| --- | --- |
| `brief` | 你的原话。策划可以提炼 `title` 和 `goal`，原话保留，避免把需求改丢。 |
| `goal` | 做完之后世界的变化，用一句话写完。 |
| `acceptance` | 可检查的完成条件。空数组的任务不能进入「进行中」。 |
| `role` | 角色 id，对应 `roles/` 里的一份手册。一条任务只有一个主责角色。 |
| `priority` | `now`、`next`、`later`。`now` 里进行中的任务最多 2 条。 |
| `artifacts` | 仓库内相对路径。角色声称做完时，这里至少有一条，且文件真实存在。 |
| `needsApproval` | 涉及目标、对外文本、远程、花钱时为 `true`。纯内部草稿也可以先停在待批准，让你看一眼再完成。 |
| `blockReason` | 状态为 `blocked` 时必填，写清缺什么决定或材料。 |
| `decision` | 批准时写一句结论；若这是公司级决定，同时追加到 `decisions.md`。 |

编号从 `t-001` 递增。删除任务时保留文件并把状态记为完成或在 `notes` 里说明放弃原因，避免编号被复用后对不上决策记录。

## 状态机

```text
inbox ──策划补齐验收与角色──► doing ──产出落地──► review ──你批准──► done
  ▲                           │                    │
  │                           ▼                    │ 你退回
  └─────────你补充材料──────── blocked ◄───────────┘
```

| 状态 | 含义 | 谁能把它送出 |
| --- | --- | --- |
| `inbox` | 刚收下，可能还没有验收标准 | 策划补齐 `goal`、`acceptance`、`role` 后进入 `doing`；信息不够则进入 `blocked` |
| `doing` | 主责角色正在做 | 产出路径写好后进入 `review`；做不下去进入 `blocked` |
| `review` | 等你看 | 你批准进入 `done`；你退回进入 `doing` 并在 `notes` 写退回原因 |
| `blocked` | 缺决定或缺材料 | 只有你补齐之后才能回到 `inbox` 或 `doing` |
| `done` | 你认可结果 | 终态。后续变化开新任务，并在新任务 `notes` 里引用旧 id |

进入 `doing` 的条件：

- `acceptance` 至少一条
- `role` 已指定
- 当前 `priority = now` 且状态为 `doing` 的任务少于 2 条

进入 `done` 的条件：

- 你明确批准
- `artifacts` 非空，或这条任务的产出就是一条写入 `decisions.md` 的决定
- `needsApproval` 为真的任务，不能由角色把自己标成完成

## 角色

四个角色覆盖第一版。每个角色开工前按顺序读：`company/identity.md`、`company/goals.md`、`company/decisions.md` 最近 10 条、当前任务 JSON。

### 策划 planner

把模糊需求收成可执行任务。

- 输入：你的一段话，或一条 `inbox` 任务。
- 输出：写好的任务 JSON（`title`、`goal`、`acceptance`、`role`、`needsApproval`）。
- 可以改：`tasks/*.json` 的上述字段，以及 `status`（只在 `inbox`、`blocked`、`doing` 之间，且必须满足进入条件）。
- 留给你：改 `goals.md`，以及「这件做不做」的最终判断。信息不足时把任务标为 `blocked`，在 `blockReason` 里列出要你回答的问题，一次最多三个。

### 工程 engineer

在仓库里把任务做成可运行的结果。

- 输入：状态为 `doing`、角色为 `engineer` 的任务。
- 输出：代码或文档，路径写入 `artifacts`，状态改为 `review`。`notes` 里写怎么在本地验证。
- 可以改：任务点名的实现文件、该任务自己的 JSON。
- 留给你：推远程、合并到主分支、改依赖范围之外的大重构。这些动作即使做了草稿，也停在 `review`。

### 研究 researcher

把外部事实收成能引用的笔记。

- 输入：一个明确问题，写在任务 `goal` 里。
- 输出：一份 Markdown 笔记路径，放进 `artifacts`。笔记包含结论、依据、还不确定的点。值得长期保留的用户事实，起草一段准备写入 `customers.md` 的文字，等你接受。
- 可以改：笔记文件、任务 JSON。
- 留给你：把假设升级成公司事实。研究角色不直接改 `goals.md` 和 `identity.md`。

### 运营 operator

把已经成立的事实写成你能发出去的草稿。

- 输入：一条已完成的任务，或你指定的一段 `decisions.md` / `goals.md`。
- 输出：周报、对外说明、下一步清单的草稿，路径写入 `artifacts`，状态停在 `review`。
- 可以改：草稿文件、任务 JSON。
- 留给你：真正发送、发布、承诺日期。运营角色的默认 `needsApproval` 为 `true`。

角色之间不互相派活。需要另一个角色时，在当前任务 `notes` 里说明，由你或策划另开一条任务。这样责任始终落在一条工单上。

## 审批规则

动作分两类。

**仓库内可直接做**

- 读 `company/` 和 `roles/`
- 新建或修改任务点名的文件
- 更新该任务的 `artifacts`、`notes`、`status`（在状态机允许的范围内）
- 在本地运行测试或开发服务器

**必须停在 `review`**

- 修改 `identity.md`、`goals.md`
- 向 `decisions.md`、`customers.md` 写入新事实
- 任何准备对外发出的文本标记为可发送
- `git push`、发布、付费、发消息、改远程配置

你在看板上对一条 `review` 任务只有三个动作：

| 动作 | 系统做什么 |
| --- | --- |
| 批准 | 状态改为 `done`，把 `decision` 写入任务；若勾选「记入决策」，追加 `decisions.md` |
| 退回 | 状态改为 `doing`，`notes` 追加你的退回原因，`updatedAt` 更新 |
| 改目标 | 先由你改 `goals.md`，再把受影响的 `now` 任务标为 `blocked`，`blockReason` 写「目标已变，需重新规划」 |

## 一天怎么用

**开始。** 打开看板。上方是本周唯一重点。中间只显示 `now`：进行中、待批准、阻塞。进行中若已有 2 条，收件箱的新任务留在 `next`，不再开工。

**中途。** 想法进收件箱，一句话即可。策划之后再补结构。你不在收件时做排序。

**结束。** 处理完 `review`。若今天没有待批准事项，就把一条 `next` 提为明天的 `now`，并写清验收。本周重点没变就不要改 `goals.md`。

每周一次，用运营角色基于 `done` 任务起草半页周报：完成了什么、决定了什么、下周唯一重点草案。你改完重点后，自己写入 `goals.md`。

## 看板

本地一个页面，三栏。

| 区域 | 显示 | 你能做的操作 |
| --- | --- | --- |
| 左栏 | `goals.md` 的本周重点；`review` 数量；`blocked` 数量 | 跳到对应任务；打开目标原文 |
| 中栏 | `now` 任务，按 `doing`、`review`、`blocked`、`inbox` 分组 | 打开任务、批准、退回、把 `next` 提为 `now` |
| 右栏 | 当前任务的验收、产出链接、角色手册摘要、最近相关决策 | 在 `notes` 里写退回原因或补充 |

另有一个收件输入框：提交后新建 `tasks/t-xxx.json`，状态 `inbox`，`brief` 为原文，`priority` 默认 `next`。若当前没有 `doing` 任务，默认 `now`。

空状态要看得见：没有本周重点时，中栏提示先写 `goals.md`；没有任务时，输入框是页面上的主操作。

第一版页面只做这一屏，不做日历、统计图和多项目切换。

## 技术方案

前后端放在同一个 Next.js 进程里。页面用 React，写入走 Route Handler。任务、已生效的决定和本周重点存在 MySQL 8。身份、用户笔记、角色手册、研究笔记和草稿仍是文件。本机开发时，Node.js 24 已经可用；开工时安装当时的 Next.js 稳定版（App Router）。数据库驱动用 `mysql2`，表结构用 `db/migrations/` 里按编号排列的 SQL，不用 ORM。

这一节是草案。你批准对应任务之后，再把「看板用一个 Next.js 进程，任务和决定存 MySQL」写进 `decisions.md`。

| 层 | 选择 | 职责 |
| --- | --- | --- |
| 前端 | React、TypeScript、App Router | 三栏看板。选中的任务放在 `?task=t-001`，刷新后右栏还在 |
| 后端入口 | Route Handler | 收件、批准、退回、把 `next` 提为 `now`、改本周重点 |
| 用例 | `lib/application` | 每个动作一件事：检查规则、写数据库、导出文件副本 |
| 规则 | `lib/domain` 里的纯函数，外加 Zod | 状态能否变化、进行中是否已满 2 条、字段是否合法 |
| 数据库 | MySQL 8，InnoDB，`utf8mb4` | `tasks`、`decisions`、`goals` 三张表 |
| 文件 | 仓库内 Markdown，以及导出的 JSON | 角色手册和长文档；任务与决定的可读副本 |
| 样式 | `app/board.css` | 只服务这一屏 |
| 测试 | Node 自带的 `node:test` | 状态机不连数据库。用例在测试库上跑事务 |
| 运行 | Node 进程加一个 MySQL 进程 | 本机用 Docker Compose 一起启动 |

连接串放在 `DATABASE_URL`，例如 `mysql://opc:opc@127.0.0.1:3306/opc`。密码不写进仓库。

Python 可以在以后作为某个角色的可选脚本。它读导出的文件或只读查询，把结果路径交给看板的用例去改状态。脚本不直接 `UPDATE` 任务表。

### 三张表

字段和上面的任务 JSON 一一对应。`acceptance` 和 `artifacts` 用 JSON 列。

| 表 | 一行是什么 | 要点 |
| --- | --- | --- |
| `tasks` | 一条任务 | 主键 `id`，如 `t-001`。状态、优先级、角色用枚举。`notes` 只追加 |
| `decisions` | 一条已生效决定 | 自增主键。含日期、决定、理由、`task_id`。只插入，不更新、不删除 |
| `goals` | 当前目标，始终一行 | 本季目标、本周唯一重点、本周起止、这周范围之外 |

身份和用户文档第二期仍由你直接改 Markdown，不进这三张表。

数据库为空、且仓库里已有 `tasks/t-*.json` 时，启动导入一次。之后看板只从 MySQL 读。

### 代码怎么分层

`app/` 可以调用 `lib/`。`lib/domain` 不认识 HTTP，也不打开数据库连接。组件里不写 SQL。

```text
app/
  page.tsx                         # 服务端读出看板
  board.css
  components/                      # 左栏重点、中栏任务、右栏详情、收件框
  api/board/route.ts               # GET 看板
  api/tasks/route.ts               # POST 收件
  api/tasks/[id]/approve/route.ts
  api/tasks/[id]/return/route.ts
  api/tasks/[id]/promote/route.ts
  api/goals/week/route.ts          # 只改 goals 表的本周重点
lib/
  domain/task.ts                   # 字段、Zod、合法状态变化、进行中上限
  application/board.ts
  application/inbox.ts
  application/approve.ts
  application/return-task.ts
  application/promote.ts
  application/update-week-focus.ts
  infrastructure/db.ts             # mysql2 连接池
  infrastructure/task-store.ts
  infrastructure/decision-store.ts
  infrastructure/goal-store.ts
  infrastructure/export-files.ts   # 事务成功后刷新 JSON 和 Markdown
db/migrations/001_init.sql
docker-compose.yml                 # app + mysql:8
```

打开页面时，`page.tsx` 直接调用 `application/board`，不绕一次 HTTP。按钮提交时，浏览器请求上表里的 Route Handler，再进入同一个用例。两条路共用一套规则。

第二期只有这 6 个写入入口。策划补验收、工程写产出，仍在 Cursor 里按角色手册做。看板显示结果，并让你批准。看板上的「交给策划」展示 `roles/planner.md` 和该任务导出 JSON 的路径。

### 一次批准怎么走

1. 页面把决定，以及是否记入决策，交给 `POST /api/tasks/t-001/approve`。
2. 用例开启事务，锁住这一行。状态机确认当前是 `review`，并且 `artifacts` 非空，或这条任务的产出就是一条决策。
3. 在同一事务里把任务改为 `done`，写入 `decision`，追加一条带时间的 `notes`。若勾了记入决策，再 `INSERT` 一行到 `decisions`。
4. 提交事务。任一步失败则整笔回滚，任务保持 `review`。
5. 提交成功后，用数据库里的内容刷新 `tasks/t-001.json` 和 `decisions.md` 的「已生效的条目」。导出失败时，页面说明数据库已写入、文件副本尚未刷新；下一次成功写入会再次导出。

收件、退回、提升优先级同样先过状态机，再在事务里写 `tasks`。新编号来自事务内锁住的计数，格式仍是 `t-` 加三位数字。进行中已经有 2 条时，提升或开工直接返回错误，页面显示这句原因。改本周重点只 `UPDATE goals` 的那一列，然后刷新 `goals.md` 里对应的一节，其余章节保留。

前端不用单独的状态库。提交成功后重新加载这一页，三栏和数据库保持一致。

### 别人怎么部署

每个人部署自己的一份，一份对应一个人的公司。`docker-compose.yml` 启动两个进程：

- 看板：一个端口上的 Node 进程
- MySQL 8：数据放在独立数据卷里，升级看板容器时不动这卷

`roles/`、研究笔记和草稿跟仓库走。`DATABASE_URL` 由编排文件注入。服务放到本机以外时，再加一道访问口令。口令只保护看板进程。

模型循环不放进这个网页进程。第三期在看板旁边加运行壳：它读取角色手册、导出的任务和决定，调用模型与工具，再通过看板的用例把产出写回 `tasks`，状态停在 `review`。运行壳优先接现成的 TypeScript harness。第二期不先做插件框架。

## 分期

### 第一期 · 文件骨架

仓库里出现 `company/`、`roles/`、`tasks/`，四份公司文档和四份角色手册填好最小内容，并放进一条示例任务 `t-001`。用文本编辑器就能完成一次「读目标 → 改任务 → 写决策」的演练。

完成标志：不打开网页，也能按本文的状态机把示例任务从 `inbox` 走到 `done`。

### 第二期 · 本地看板

按「技术方案」建 `app/`、`lib/`、`db/migrations/` 和 `docker-compose.yml`。页面能收件、批准、退回、提升优先级、修改本周重点。这些写入进 MySQL，成功后再导出 JSON 和 Markdown。批准时可以在同一事务里插入 `decisions`。

完成标志：浏览器里走通成功标准 1–5，刷新后数据仍在 MySQL 里。状态机有 `node:test` 覆盖。空库能把现有 `tasks/t-001.json` 导入一次。

### 第三期 · 角色执行

看板继续负责任务和批准。旁边的运行壳读取角色手册、目标和任务，调用模型与工具，把产出写进 `artifacts`，状态停在 `review`。优先接现成的 TypeScript harness，由看板把开工上下文交出去。

完成标志：一条工程任务可以从看板上进入运行壳，结束时状态是 `review`。

### 第四期 · 对外动作

在批准通过之后，才提供推远程、复制对外草稿等动作。每个动作单独按钮，执行前再确认一次，并把结果记入该任务 `notes`。

## 示例：第一天

本周重点写在 `goals.md`：把 OPC 第一期文件骨架落到仓库里。

你在收件箱写下：「把公司记忆和四个角色手册建好。」

策划生成 `tasks/t-001.json`：

- `goal`：仓库里有可阅读的公司大脑和角色手册，后续任务能引用它们。
- `acceptance`：四个 `company` 文件和四个 `roles` 文件存在；`identity.md` 写明当前阶段是第一期。
- `role`：`engineer`
- `needsApproval`：`true`（会写入公司事实）

工程角色建好文件，`artifacts` 列出路径，状态改为 `review`。你看过内容后批准，并记入决策：「公司记忆采用 company 下四份 Markdown。」

这条决策出现在 `decisions.md` 后，下一件任务开工时会被读到。当前仓库已经走到这一步的 `review`：见 `tasks/t-001.json`。批准之前，`decisions.md` 里还没有生效条目。

## 风险与对应做法

| 风险 | 做法 |
| --- | --- |
| 任务字段越加越多，看板无法维护 | 第一版冻结上文 JSON 字段。新需求开新任务讨论，确认后再改格式 |
| 角色互相委托，责任不清 | 一条任务一个主责。跨角色就新开任务 |
| 进行中的事过多 | `doing` 硬上限 2 条，超过时接口拒绝开工 |
| 聊天里的结论没有写回记录 | 只有 `decisions` 表和任务的 `decision` 字段算数。`decisions.md` 是导出的副本 |
| 文件副本和数据库不一致 | 事务成功后才导出。不一致时以 MySQL 为准，下一次写入会重刷副本 |
| 页面和脚本各写一套状态机 | 所有状态变化都经过 `lib/application`。脚本不直接改 `tasks` 表 |
| 别人部署时数据库跟着程序被清掉 | MySQL 使用独立数据卷。升级看板容器不覆盖这卷 |

## 下一步

第一期文件已经落到仓库，任务 `t-001` 停在 `review`。你先看这三处：

1. `company/identity.md` 末尾「待你填写」。小时数、预算、这套系统先服务哪类工作，只有你知道。
2. `company/goals.md` 的本季目标和本周重点是否就是你要的。
3. 四份 `roles/*.md` 的步骤是否够你或代理照着做。

看完之后：

- 认可：把 `t-001` 的 `status` 改为 `done`，写上 `decision`，并按 `decisions.md` 的格式追加一条。
- 要改：在 `t-001` 的 `notes` 里追加退回原因，把 `status` 改回 `doing`。

你确认这套字段和手册够用后，再做第二期看板。第二期按本文「技术方案」开工：一个 Next.js 进程，规则放在 `lib/`，任务、决定和本周重点存 MySQL 8。这套技术选择在写进 `decisions.md` 之前仍是草案。
