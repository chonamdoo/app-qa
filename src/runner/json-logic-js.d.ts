// Minimal types for json-logic-js 2.0.5 (CommonJS, no bundled typings): only what the runner uses.
declare module 'json-logic-js' {
  const jsonLogic: {
    apply(rule: unknown, data?: unknown): unknown;
    /** Registers `name` as an operation: called with the evaluated operands (the data as `this`). */
    add_operation(name: string, code: (...values: never[]) => unknown): void;
  };
  export default jsonLogic;
}
