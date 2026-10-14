/** A user-facing refusal: the CLI prints the message and exits 2. */
export class Refusal extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "Refusal";
  }
}
