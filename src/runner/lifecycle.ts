type ResetMode = 'none' | 'relaunch' | 'clear' | 'reinstall';
type LaunchOperation = 'reset' | 'terminate' | 'launch';
const LAUNCH = ['launch'] as const;
const RELAUNCH = ['terminate', 'launch'] as const;
const RESET = ['reset'] as const;
const CUSTOM_RESET = ['reset', 'terminate', 'launch'] as const;

/** Qualification and dispatch use the same lifecycle; a reset already launches unless custom options require another launch. */
export function launchOperations(reset: ResetMode, custom: boolean, desktopWeb: boolean): readonly LaunchOperation[] {
  if (reset === 'clear' || reset === 'reinstall') return custom ? CUSTOM_RESET : RESET;
  return reset === 'relaunch' && !desktopWeb ? RELAUNCH : LAUNCH;
}
