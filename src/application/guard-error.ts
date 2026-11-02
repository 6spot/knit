/**
 * 应用层业务守卫错误：带稳定领域原因码，CLI 边界映射为协议 ReasonCode。
 * 领域模块不依赖它；只在应用用例拒绝请求时使用。
 */
import { InfrastructureError } from "../infrastructure/errors.js";

export class GuardError extends InfrastructureError {
  constructor(
    readonly guardReason: string,
    message: string,
  ) {
    super("io_error", message, { guardReason });
    this.name = "GuardError";
  }
}
