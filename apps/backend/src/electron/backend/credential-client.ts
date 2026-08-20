/** Backend 侧凭据端口：经反向 RPC 把 API Key 移交 Main 侧 safeStorage 加解密，Backend 自身永不落盘。 */
export function CreateCredentialClient(desktopCapability: { Call(capability: string, args?: unknown[]): Promise<any> }) {
  return {
    /** 读取主进程私有配置；未配置返回 null。 */
    async Load(): Promise<any> {
      const result = await desktopCapability.Call('CredentialLoad');
      return result || null;
    },
    /** 保存经校验的模型配置，API Key 由 Main 加密后落盘。 */
    async Save(config: unknown): Promise<void> {
      await desktopCapability.Call('CredentialSave', [config]);
    },
  };
}
