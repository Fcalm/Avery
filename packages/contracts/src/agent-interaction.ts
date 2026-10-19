import { z } from 'zod';

const Identity = {
  sessionId: z.string().min(1).max(200),
  requestId: z.string().min(1).max(200),
  interactionId: z.string().min(1).max(200),
};

/** 决定绑定原会话、Run 与交互；普通聊天文本永远不作为审批凭据。 */
export const AgentInteractionResponseSchema = z.discriminatedUnion('kind', [
  z.object({ ...Identity, kind: z.literal('approval'), approved: z.boolean() }).strict(),
  z.object({ ...Identity, kind: z.literal('answer'), answers: z.record(z.string().min(1).max(200), z.string().min(1).max(20000)) }).strict(),
  z.object({ ...Identity, kind: z.literal('cancel') }).strict(),
]);
export type AgentInteractionResponse = z.infer<typeof AgentInteractionResponseSchema>;
