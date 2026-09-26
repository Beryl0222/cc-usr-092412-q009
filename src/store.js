import { validateEvent } from "./validator.js";
import { fail } from "./errors.js";

/**
 * 追加式事件存储：记录一经接收，标识、发生时间与版本不得原地改写，
 * 更正只能通过新的后继事件。版本按聚合（aggregate_type + aggregate_id）各自递增。
 */
export class EventStore {
  #events = [];
  #nextVersion = new Map();
  #ids = new Set();

  append(record) {
    const key = `${record.aggregate_type}:${record.aggregate_id}`;
    const next = (this.#nextVersion.get(key) ?? 0) + 1;
    if (record.version !== undefined && record.version !== next) {
      fail("VERSION_CONFLICT", `聚合 ${key} 期望版本 ${next}，收到 ${record.version}`);
    }
    const event = { ...record, version: next };
    if (event.event_id === undefined) event.event_id = `${key}:v${next}`;
    if (this.#ids.has(event.event_id)) fail("EVENT_EXISTS", `事件标识重复：${event.event_id}`);
    const errors = validateEvent(event);
    if (errors.length > 0) fail("INVALID_EVENT", `事件不符合约定：${errors.join("；")}`);
    this.#events.push(event);
    this.#nextVersion.set(key, next);
    this.#ids.add(event.event_id);
    return event;
  }

  appendAll(records) {
    return records.map((record) => this.append(record));
  }

  all() {
    return [...this.#events];
  }

  byAggregate(aggregateType, aggregateId) {
    return this.#events.filter((e) => e.aggregate_type === aggregateType && e.aggregate_id === aggregateId);
  }

  byType(eventType) {
    return this.#events.filter((e) => e.event_type === eventType);
  }
}
