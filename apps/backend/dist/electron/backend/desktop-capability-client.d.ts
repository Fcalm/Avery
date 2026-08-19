/** Backend → Main 的反向 RPC 客户端：请求桌面能力（对话框/导出/凭据）并等待 Main 适配器返回结果。 */
export declare function CreateDesktopCapabilityClient(postMessage: (message: unknown) => void): {
    /** 由 Backend 消息循环调用，处理 Main 返回的 desktop-result。 */
    OnMessage(message: any): void;
    /** 调用一个桌面能力；能力未实现或异常时以错误拒绝。 */
    Call(capability: string, args?: unknown[]): Promise<unknown>;
};
