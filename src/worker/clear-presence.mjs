// Bounded retry policy for clearing Discord activity.
//
// Keeping the retry loop separate from the daemon makes the policy
// deterministic to test without importing the daemon's long-lived socket
// server or starting a Discord connection.

export const CLEAR_ATTEMPTS = 3;
export const CLEAR_BACKOFF_MS = Object.freeze([1000, 2000]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Try to clear Discord activity a bounded number of times.
 *
 * `clearActivity` should resolve to true when a frame was written and false
 * when it was not written. It may also throw. `canRetry` lets the caller stop
 * when the underlying connection has been marked disconnected.
 */
export async function retryClearActivity({
    clearActivity,
    canRetry = () => true,
    attempts = CLEAR_ATTEMPTS,
    backoffMs = CLEAR_BACKOFF_MS,
    sleep = defaultSleep,
    onAttempt = () => {},
} = {}) {
    if (typeof clearActivity !== "function") {
        throw new TypeError("clearActivity must be a function");
    }

    const totalAttempts = Math.max(1, Math.trunc(Number(attempts) || CLEAR_ATTEMPTS));

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        let sent = false;
        let error = null;

        try {
            sent = await clearActivity();
        } catch (err) {
            error = err;
        }

        const result = {
            attempt,
            attempts: totalAttempts,
            sent: sent === true,
            error,
        };
        onAttempt(result);

        if (result.sent) {
            return result;
        }
        if (attempt === totalAttempts || !canRetry()) {
            return result;
        }

        const delay = Math.max(0, Number(backoffMs[attempt - 1] ?? 0) || 0);
        await sleep(delay);

        if (!canRetry()) {
            return { ...result, stopped: true };
        }
    }

    // The loop always returns, but keep a defensive result for future edits.
    return { attempt: totalAttempts, attempts: totalAttempts, sent: false, error: null };
}
