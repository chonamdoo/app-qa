export const CLAUDE_SUBSCRIPTION_SETTINGS = JSON.stringify({ disableAllHooks: true, forceLoginMethod: 'claudeai' });
export const CLAUDE_SUBSCRIPTION_FLAGS = ['--restricted', '--safe-mode', '--setting-sources', '', '--settings', CLAUDE_SUBSCRIPTION_SETTINGS] as const;

export function isClaudeSubscriptionLogin(value: unknown): boolean {
  return value !== null && typeof value === 'object'
    && 'loggedIn' in value && value.loggedIn === true
    && 'authMethod' in value && value.authMethod === 'claude.ai'
    && (!('apiProvider' in value) || value.apiProvider === 'firstParty');
}
