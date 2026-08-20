import { describe, expect, it } from 'vitest';
import { WorkspaceOperationService } from '../../../apps/backend/src/electron/backend/services/workspace-operation-service';

function createRecoveryDb(row: Record<string, unknown>): any {
  const updates: unknown[][] = [];
  return {
    updates,
    prepare(sql: string) {
      if (sql.startsWith('SELECT * FROM workspace_operations')) return { all: () => [row] };
      return { run: (...args: unknown[]) => { updates.push([sql, ...args]); return { changes: 1 }; }, all: () => [], get: () => ({ count: 0 }) };
    },
  };
}

describe('WorkspaceOperationService recovery', () => {
  it('未知操作版本会阻断写入，不猜测恢复策略', () => {
    const db = createRecoveryDb({ id: 'operation-1', operation_type: 'import_attachment', operation_version: 99, state: 'prepared', payload_json: '{}' });
    const service = new WorkspaceOperationService({ db, workspacePath: process.cwd() });

    expect(service.Recover()).toEqual({ recovered: 0, failed: 0, blocked: 1, writable: false });
    expect(service.GetStatus()).toMatchObject({ blocked: true, blockedCount: 1 });
    let error: unknown;
    try {
      service.RequireWritable();
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'WORKSPACE_BUSY' });
  });
});
