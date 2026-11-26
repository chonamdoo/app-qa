import { ExecutionChainSchema, type ExecutionChain } from '../core/execution-chain.ts';
import { productDigest } from '../core/product.ts';
import type { RevisionProblem } from '../core/regression.ts';
import { profilePlatforms, type AppProfile, type TestSpec } from '../spec/schema.ts';

type ChainTest = { id: string; spec: TestSpec; profile: AppProfile };

export function planExecutionFlows<T extends ChainTest>(tests: readonly T[], declarations: readonly ExecutionChain[] = []): {
  flows: { chain: ExecutionChain | null; tests: T[] }[];
  problems: RevisionProblem[];
} {
  const problems: RevisionProblem[] = [];
  const byId = new Map(tests.map(test => [test.id, test]));
  if (byId.size !== tests.length) return {
    flows: [], problems: [{ code: 'duplicate_chain_test', testId: null, path: 'chains', message: 'TC identity가 중복되어 실행 chain을 확정할 수 없습니다' }],
  };
  const parsed = ExecutionChainSchema.array().max(500).safeParse(declarations);
  if (!parsed.success) return {
    flows: [], problems: [{ code: 'invalid_chain_declaration', testId: null, path: 'chains', message: '상태 의존 chain의 identity·전체 TC membership·순서가 올바르지 않습니다' }],
  };
  const chainIds = new Set<string>();
  const byMember = new Map<string, { chain: ExecutionChain; tests: T[] }>();
  for (const chain of parsed.data) {
    const problem = (code: string, message: string): void => { problems.push({ code, testId: chain.members[0]!, path: `chains.${chain.id}`, message }); };
    if (chainIds.has(chain.id)) { problem('duplicate_chain_identity', '같은 chain identity를 중복 선언할 수 없습니다'); continue; }
    chainIds.add(chain.id);
    const members = chain.members.map(id => byId.get(id));
    if (members.some(member => !member)) {
      problem('chain_members_missing', '선언한 chain의 전체 TC가 필요합니다. 후행 TC만 발행하거나 누락한 선행 TC를 자동 추가하지 않습니다');
      continue;
    }
    if (chain.members.some(id => byMember.has(id))) {
      problem('overlapping_execution_chains', '한 TC를 여러 상태 의존 chain에 중복 배정할 수 없습니다');
      continue;
    }
    const ordered = members as T[];
    const first = ordered[0]!;
    const platforms = (item: T): string => productDigest([...(item.spec.platforms ?? profilePlatforms(item.profile))].sort());
    if (ordered.some(item => item.spec.app !== first.spec.app || productDigest(item.profile) !== productDigest(first.profile) || platforms(item) !== platforms(first))) {
      problem('chain_resource_scope_mismatch', '동일 세션 chain은 같은 앱·고정 프로필·필수 대상 집합을 사용해야 합니다. 다른 사용자·기기를 같은 세션으로 대신하지 않습니다');
      continue;
    }
    if (ordered.slice(1).some(item => item.spec.start !== 'attach')) {
      problem('chain_implicit_restart_refused', '선행 상태를 유지하는 후행 TC의 start는 attach여야 합니다. 원본의 실행·새로고침 선언을 암묵적으로 변경하지 않습니다');
      continue;
    }
    const flow = { chain, tests: ordered };
    for (const id of chain.members) byMember.set(id, flow);
  }
  if (problems.length) return { flows: [], problems };
  const seen = new Set<string>();
  const flows: { chain: ExecutionChain | null; tests: T[] }[] = [];
  for (const test of tests) {
    const flow = byMember.get(test.id);
    if (!flow) flows.push({ chain: null, tests: [test] });
    else if (!seen.has(flow.chain.id)) { seen.add(flow.chain.id); flows.push(flow); }
  }
  return { flows, problems };
}
