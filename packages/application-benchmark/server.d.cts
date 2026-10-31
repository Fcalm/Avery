import type { Server } from 'node:http';
export function startServer(options?: { dataRoot?: string; port?: number }): Promise<{
  server: Server;
  baseUrl: string;
  store: { adminToken: string; close(): void };
}>;
