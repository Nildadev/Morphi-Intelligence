/**
 * Streaming text: renders the accumulated text exactly as the deltas have
 * delivered it so far — the network arrival IS the typing effect, like
 * ChatGPT and the deepseek harness. There is deliberately no timer, no
 * backlog and no end-of-turn flush: a timer can only lag behind a fast
 * provider and then dump the remainder, which is exactly the instability
 * (thinking types fine, answer pops in all at once) this replaces. The
 * component exists so the markdown renderer and the thinking block share
 * one streaming text path.
 */
export function StreamWords({ text }: { text: string; active?: boolean }) {
  return <>{text}</>;
}
