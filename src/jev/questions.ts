// Frozen question templates, version q-v1. Any wording change requires a new QUESTION_VERSION and a new calibration run.
// States carry element rows and visible text only — never coordinates (Jev is weak at numeric proximity; code owns geometry).

export const QUESTION_VERSION = 'q-v1';
export const NONE = 'none';
/** API limit, `none` included; one more option is an HTTP 400. */
export const MAX_CHOICE_OPTIONS = 255;

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string | Record<string, string>;
  criteria: Record<string, string | null>;
}

export interface NoulQuestion {
  type: 'noul';
  instructions: string | Record<string, string>;
}

export type Question = ChoiceQuestion | NoulQuestion;
export type Questions = Record<string, Question>;

/** Screen as Jev sees it: `e3 | button | 항공편 찾기 | disabled | bottom` rows plus visible text lines. */
export interface ScreenState {
  rows: string[];
  texts: string[];
}

const ROW_FORMAT = '`screen.rows` lists the elements as `key | role | name | state | region`; `screen.texts` is the visible text.';

/** Question id → question, for each primitive. Ids are ours and never reach the model. */
export const QUESTION_IDS = {
  grounding: 'target',
  claim: 'claim',
  which: 'screen',
  commit: 'commits',
  addresses: 'addresses_requirement',
  unrelated: 'unrelated_steps',
  clarification: 'needs_clarification',
} as const;

/** Choice over candidate keys + `none`; each option is described by its row without the key column. */
export function groundingQuestion(keys: readonly string[], rows: readonly string[]): ChoiceQuestion {
  const criteria: Record<string, string | null> = {};
  keys.forEach((key, i) => {
    criteria[key] = rowDescription(rows[i] ?? '');
  });
  criteria[NONE] = 'No row is the element that `intent` refers to.';
  return {
    type: 'choice',
    instructions: {
      question: 'Which row of `screen.rows` is the on-screen element that `intent` refers to?',
      screen: ROW_FORMAT,
      none: 'Answer `none` when no row is the element that `intent` refers to (for example, it is not on this screen).',
    },
    criteria,
  };
}

export function claimQuestion(): NoulQuestion {
  return {
    type: 'noul',
    instructions: {
      question: 'Does the visible evidence on this current screen support this specific claim?',
      claim: 'The claim is `claim`. The current screen is `screen`.',
      screen: ROW_FORMAT,
      absence: 'A claim that something is absent or not shown is supported when nothing in `screen` shows it.',
    },
  };
}

/** Choice over option keys s0..sN + `none` (= still loading / none of these). */
export function whichQuestion(options: readonly string[]): ChoiceQuestion {
  const criteria: Record<string, string | null> = {};
  options.forEach((option, i) => {
    criteria[`s${i}`] = option;
  });
  criteria[NONE] = 'still loading / none of these';
  return {
    type: 'choice',
    instructions: {
      question: 'Which option describes the current screen `screen`?',
      screen: ROW_FORMAT,
    },
    criteria,
  };
}

/** Refusal-only signal: a high answer can block an action, a low answer never unblocks one. */
export function commitQuestion(): NoulQuestion {
  return {
    type: 'noul',
    instructions: {
      question: 'Would activating `target` commit an irreversible or external change (delete, pay, send, sign out…)?',
      target: '`target` is one row of `screen.rows`.',
      screen: ROW_FORMAT,
    },
  };
}

/** Three independent Nouls over `{requirement, test}` for generated-test review. */
export function reviewQuestions(): Questions {
  return {
    [QUESTION_IDS.addresses]: {
      type: 'noul',
      instructions: 'Do the steps and checks in `test` verify the behavior that `requirement.text` describes?',
    },
    [QUESTION_IDS.unrelated]: {
      type: 'noul',
      instructions: 'Does `test` contain steps or checks that are unrelated to `requirement.text` (not needed to reach or verify it)?',
    },
    [QUESTION_IDS.clarification]: {
      type: 'noul',
      instructions: 'Is `requirement.text` too vague or ambiguous to test without asking its author for clarification?',
    },
  };
}

/** "e3 | button | 항공편 찾기 | - | bottom" → "button | 항공편 찾기 | - | bottom" (the key is the option name already). */
function rowDescription(row: string): string {
  const bar = row.indexOf('|');
  return bar === -1 ? row : row.slice(bar + 1).trim();
}
