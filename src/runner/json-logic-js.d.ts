// Minimal types for json-logic-js 2.0.5 (CommonJS, no bundled typings): only what the runner uses.
declare module 'json-logic-js' {
  const jsonLogic: {
    apply(rule: unknown, data?: unknown): unknown;
    truthy(value: unknown): boolean;
    is_logic(value: unknown): boolean;
  };
  export default jsonLogic;
}
