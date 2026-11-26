import { z } from 'zod';

export const ExecutionChainSchema = z.strictObject({
  id: z.string().regex(/^[\w.-]+$/).min(1).max(200),
  members: z.array(z.string().regex(/^[\w.-]+$/).min(1).max(1000)).min(2).max(1000)
    .refine(members => new Set(members).size === members.length, '상태 의존 chain의 TC identity를 중복할 수 없습니다'),
});
export type ExecutionChain = z.infer<typeof ExecutionChainSchema>;
