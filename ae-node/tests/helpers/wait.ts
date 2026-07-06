// Shared timing helpers for the multi-runner / network e2e tests.
//
// Fixed `await wait(ms)` sleeps before an assertion are the classic source of
// e2e flake: too short under CI load → false failure; too long → slow suite.
// `waitForCondition` polls an observable condition to a generous deadline
// instead, so it returns the instant the condition holds and only fails after
// genuinely waiting long enough. `wait` remains for the rare genuine settle
// (e.g. "let a socket close") that has no pollable signal.

export function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll `check()` every `intervalMs` until it returns true or `timeoutMs`
 * elapses. Returns the final value of `check()` (so a caller can assert on it,
 * though the following assertion usually re-checks the same state).
 */
export async function waitForCondition(
  check: () => boolean,
  timeoutMs = 10_000,
  intervalMs = 20,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await wait(intervalMs);
  }
  return check();
}
