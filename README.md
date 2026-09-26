# 养老机器人共享结算台

社区把同一台照护机器人轮流租给多户老人。本仓库按实际使用形成资金责任链：资格决定、租赁时段、服务包、设备计量、停机与替换关系分别版本化；每段费用先依据服务发生时的资格与规则拆分，再由机构财务确认后入账。

## 资料范围

- `contracts/domain.schema.json`：领域事件信封、聚合类型与事件名称。
- `data/sample.json`：一条用于本地联调的中文样例。
- `src/validator.js`：事件信封校验（必填字段、事件与聚合类型、时间格式）。
- `src/store.js`：追加式事件存储，版本按聚合各自递增。
- `src/service.js`：结算服务核心（命令、台账、视图）。
- `src/split.js`、`src/intervals.js`：费用拆分与时段运算的纯函数。
- `tests/`：覆盖拆分、占用冲突、停机扣减、争议、封账、回执、恢复与视图隔离。

## 领域规则

**版本化与不可改写。** 资格决定（`care_recipient`）、租赁时段与换机关系（`rental_agreement`）、服务包（`service_package`）、设备计量与停机（`robot_device`）、台账分录（`ledger_entry`）、结算周期（`billing_period`）各自按聚合版本化。记录一经接收，标识、发生时间与版本不得原地改写；更正使用新的后继记录。

**费用拆分。** 每记录一段用量，立即按服务发生时的资格决定与服务包价格拆分：资助方按优先级瀑布承担，任一方不突破各自上限（按月或累计），每一分钱只落到一个资助方，同一设备的重叠计量与并发占用直接拒绝，因此同一小时不会向两方重复申报。拆分结果先生成待确认分录，机构财务确认后方入账。

**停机与换机。** 停机时段不计费：先登记的停机在拆分时直接扣减，后登记的停机按新增覆盖时长（并集去重）生成冲正分录。换机把设备链从换机时刻切换到新设备，原协议与租赁时段不变，旧设备同时释放。

**争议与封账。** 争议只冻结对应分录，不影响同周期其他分录；老人已获得的服务事实不能回滚，只能以后继分录更正。封账要求周期内分录全部入账；迟到回执只调整尚未封账的周期，已封账周期的差额以调整分录追加到当前未封账周期并注明原因。服务（进程）恢复后，`recover()` 会继续未完成的封账与未兑付的退款。

**视图与可见性。** 家庭只能看到本户明细；资助方只能查看自己承担的汇总（分周期合计、冻结额、剩余额度），看不到逐条用量与其他资助方；审计视图可证明每一小时由谁支付，以及各资助方剩余额度随每笔入账的变化。个人、机构及商业敏感信息仅向履行职责所需的调用方开放。

## 主要命令

```js
import { EventStore } from "./src/store.js";
import { SettlementService } from "./src/service.js";

const store = new EventStore();
const svc = new SettlementService(store);

svc.assessEligibility({ household_id, effective_from, funders, occurred_at }); // 资格决定
svc.publishPackage({ package_id, effective_from, items, occurred_at });        // 服务包
svc.scheduleRental({ agreement_id, household_id, device_id, start, end, occurred_at });
svc.replaceDevice({ agreement_id, to_device_id, at, reason, occurred_at });    // 换机
svc.recordUsage({ usage_id, agreement_id, device_id, service_code, start, end, occurred_at });
svc.recordDowntime({ downtime_id, device_id, start, end, reason, occurred_at });
svc.confirmPeriod({ role: "finance" }, period, occurred_at);                   // 财务确认入账
svc.sealPeriod({ role: "finance" }, period, occurred_at);                      // 封账
svc.raiseDispute(principal, entry_id, reason, occurred_at);                    // 争议冻结
svc.recordReceipt(principal, entry_id, received_cents, reason, occurred_at);   // 迟到回执
svc.requestRefund({ role: "finance" }, { household_id, funder_id, amount_cents, reason, occurred_at });
svc.recover(occurred_at);                                                      // 恢复后续跑
svc.familyView({ role: "family", household_id }, { period });
svc.funderView({ role: "funder", funder_id }, { period });
svc.auditView({ role: "audit" }, { household_id, period });
```

金额一律以分为单位的整数；时段为半开区间 `[start, end)`；结算周期取时间字符串所在自然月。

## 本地检查

```bash
node --test
```

## 测试与构建

测试命令：

```bash
npm test
```

编译或构建命令：

```bash
npm run build
```

这些命令可在单个 Linux 应用容器内执行，不需要另行启动外部服务。
