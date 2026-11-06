// Inspect a clone without consuming the caller's Request or Response. A null
// result means inspection was inconclusive; callers must preserve the original.
export async function readCloneText(source, { maxBytes, timeoutMs, signal }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || signal?.aborted) return null;
  let reader, timer, abort;
  try {
    reader = source.clone().body?.getReader();
    if (!reader) return null;
    const stopped = new Promise((_, reject) => {
      abort = () => reject(new Error("Body inspection stopped"));
      timer = setTimeout(abort, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0, text = "";
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), stopped]);
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) return null;
      text += decoder.decode(value, { stream: true });
    }
  } catch { return null; }
  finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    // Tee cancellation can wait for the original consumer. Never await it.
    if (reader) void reader.cancel().catch(() => {});
  }
}
