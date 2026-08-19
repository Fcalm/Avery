import { CreateBusinessStoreClient } from './infra/business-store-client';
import { CreateObservabilityStoreClient } from './infra/observability-store-client';

export interface CreateWorkerHostOptions {
  workspacePath: string;
  userDataPath: string;
  smoke?: boolean;
  upgradeFailure?: string;
}

/**
 * 组装业务与可观测性两个 DB Worker 的生命周期，向 Backend 提供统一的异步存储入口；
 * Business 与 Observability 各由唯一 Worker 持有连接，better-sqlite3 同步调用只存在于 Worker 内。
 */
export function CreateWorkerHost(options: CreateWorkerHostOptions) {
  const business = CreateBusinessStoreClient({
    workspacePath: options.workspacePath,
    smoke: options.smoke ?? false,
    ...(options.smoke && options.upgradeFailure ? { upgradeFailure: options.upgradeFailure } : {}),
  });
  const observability = CreateObservabilityStoreClient({
    userDataPath: options.userDataPath,
    smoke: options.smoke ?? false,
  });

  return {
    business,
    observability,
    async Ready(): Promise<{ business: any; observability: any }> {
      await Promise.all([business.ready, observability.ready]);
      return { business: business.methods, observability: observability.methods };
    },
    Close(): void {
      business.close();
      observability.close();
    },
  };
}
