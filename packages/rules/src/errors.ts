/** The one error rules throw for bad input. Golden tests see it as {"error": code}. */
export class RuleError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RuleError";
    this.code = code;
  }
}
