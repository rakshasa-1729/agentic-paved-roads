// SPDX-License-Identifier: Apache-2.0

/**
 * `fetch()` that aborts after `timeoutMs` and surfaces a clean
 * "<sourceId>: timed out after Xms" error rather than the platform's
 * raw `TimeoutError` / `AbortError`. Pre-existing `signal`s are
 * respected — caller-supplied aborts still win.
 */
export async function abortableFetch(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  sourceId: string,
): Promise<Response> {
  const signal = init?.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`${sourceId}: timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

/**
 * Race a promise against a timeout. On timeout, runs `onTimeout` (use
 * it for cleanup — kill a child, close a socket) and rejects with a
 * "<label>: timed out after Xms" error.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          try {
            onTimeout?.();
          } finally {
            reject(new Error(`${label}: timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Node's AbortSignal.timeout produces a DOMException-ish error with
  // name "TimeoutError"; some runtimes raise "AbortError" instead.
  return err.name === "TimeoutError" || err.name === "AbortError";
}
