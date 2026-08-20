"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateWriteIntentKeyStore = CreateWriteIntentKeyStore;
/**
 * 保存单次用户写意图与稳定幂等键的映射。
 * 同一个 variables 对象在 TanStack 自动重试期间会复用键；Mutation settle 后必须释放，
 * 避免调用方复用对象发起新意图时错误回放旧结果。
 */
function CreateWriteIntentKeyStore(createKey = () => crypto.randomUUID()) {
    const keys = new WeakMap();
    return {
        Resolve(intent) {
            const existing = keys.get(intent);
            if (existing)
                return existing;
            const key = createKey();
            keys.set(intent, key);
            return key;
        },
        Release(intent) {
            keys.delete(intent);
        },
    };
}
