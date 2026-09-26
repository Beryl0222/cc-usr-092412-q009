/** 领域错误：code 供调用方程序化判断，message 面向人阅读。 */
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export function fail(code, message) {
  throw new DomainError(code, message);
}
