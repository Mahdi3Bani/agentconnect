/** RFC 1459 §8.10 client-side: each line advances a timer by `penaltyMs`; a server disconnects once it runs `windowMs` ahead. A send-queue gate: delays, never drops. */
export class IrcFloodGate {
  private timer = Number.NEGATIVE_INFINITY
  private chain: Promise<void> = Promise.resolve()

  constructor(
    // 2s/10s is the RFC's figure; the window defaults below it to leave headroom for NAMES/WHOIS, which bypass this gate.
    private readonly penaltyMs = 2_000,
    private readonly windowMs = 8_000,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms).unref?.())
  ) {}

  take(): Promise<void> {
    const turn = this.chain.then(() => this.acquire())
    this.chain = turn.then(
      () => undefined,
      () => undefined
    )
    return turn
  }

  private async acquire(): Promise<void> {
    for (;;) {
      const now = this.now()
      this.timer = Math.max(this.timer, now)
      const ahead = this.timer + this.penaltyMs - now
      if (ahead <= this.windowMs) {
        this.timer += this.penaltyMs
        return
      }
      await this.sleep(ahead - this.windowMs)
    }
  }
}
