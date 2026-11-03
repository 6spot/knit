/** 测试用本机存活检查：/proc缺失不代表进程退出，权限未知视作仍存活。 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

/** 业务终态可先于worker的finally释放锁；串行测试交接须等待实际退出。 */
export function isRunSettled(status) {
  if (!["completed", "failed", "cancelled"].includes(status.state)) return false;
  const pid = status.handle?.pid;
  return !pid || !isProcessAlive(pid);
}
