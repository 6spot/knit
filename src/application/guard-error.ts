/**
 * 应用层业务守卫错误：带稳定领域原因码，CLI 边界映射为协议 ReasonCode。
 * 领域模块不依赖它；只在应用用例拒绝请求时使用。
 */
import { InfrastructureError } from "../infrastructure/errors.js";
import { isCredentialIntegrityError } from "../infrastructure/credential-seal.js";

export class GuardError extends InfrastructureError {
  constructor(
    readonly guardReason: string,
    message: string,
  ) {
    super("io_error", message, { guardReason });
    this.name = "GuardError";
  }
}

/**
 * 读取签名凭据：完整性失败（credential_tampered／credential_unsigned）转为同名 GuardError，
 * 使交付、完成与检查资格按稳定原因拒绝；其它错误原样抛出。
 */
export function readIntact<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (isCredentialIntegrityError(error)) throw new GuardError(error.guardReason, error.message);
    throw error;
  }
}
