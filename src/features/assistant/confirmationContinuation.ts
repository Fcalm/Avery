/**
 * 确认/问答属于触发弹窗的旧 Run 的后续消息：同 request 可以立即接管发送权；
 * 其他在途 request 仍必须阻止，避免把答案串入错误会话。
 */
export function ResolveConfirmationContinuation(
  activeRequestId: string | null,
  continuationOfRequestId?: string,
): { allowed: boolean; releaseActiveRequest: boolean } {
  if (!activeRequestId) return { allowed: true, releaseActiveRequest: false };
  if (continuationOfRequestId && continuationOfRequestId === activeRequestId) {
    return { allowed: true, releaseActiveRequest: true };
  }
  return { allowed: false, releaseActiveRequest: false };
}
