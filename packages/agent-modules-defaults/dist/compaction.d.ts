import type { CompactionModule } from '@offerget/agent-sdk';
/** 压缩模块：判定、切分与降级原语；摘要生成由 model-provider 承担，重试循环在 Kernel。 */
export declare function CreateCompactionModule(): CompactionModule;
