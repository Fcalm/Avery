import { ErrorCode } from '@avery/contracts';
import { AppError } from '../shared/platform/platformClient';
import { Button, EmptyState } from '../shared/components/UI';
import { Icon } from '../shared/components/Icon';

/** 判断错误是否由后端进程不可用引起（Gateway 兜底失败信封携带 backendState 明细）。 */
export function IsBackendRecoveryError(error: unknown): boolean {
  if (error instanceof AppError && error.code === ErrorCode.INTERNAL_ERROR) {
    const details = (error.details ?? {}) as { backendState?: string };
    return typeof details.backendState === 'string' && details.backendState.length > 0;
  }
  return false;
}

/** 后端进程不可用时的只读恢复页：提示后端正在重启，仅提供重试，不执行任何写入。 */
export function BackendRecoveryGate({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="app-screen">
      <EmptyState
        className="app-state app-state-recovery"
        role="status"
        ariaLive="polite"
        icon={<Icon name="recovery" size={24} />}
        title="本地服务正在恢复"
        description="后端服务正在重新启动，恢复完成后会自动加载本地数据。此期间不会执行任何写入操作。"
        action={<Button variant="primary" onClick={onRetry}>重试</Button>}
      />
    </div>
  );
}
