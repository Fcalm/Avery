/**
 * 保存单次用户写意图与稳定幂等键的映射。
 * 同一个 variables 对象在 TanStack 自动重试期间会复用键；Mutation settle 后必须释放，
 * 避免调用方复用对象发起新意图时错误回放旧结果。
 */
export declare function CreateWriteIntentKeyStore(createKey?: () => string): {
    Resolve(intent: object): string;
    Release(intent: object): void;
};
