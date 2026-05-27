export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export class ConversationHistory {
  private turns: Turn[] = [];
  private limit: number;

  constructor(limit = 20) {
    this.limit = limit;
  }

  add(role: Turn["role"], content: string): void {
    this.turns.push({ role, content });

    // Rolling window: keep last N turns (pairs count as 2 turns)
    while (this.turns.length > this.limit) {
      this.turns.shift();
    }
  }

  getFormatted(): string {
    return this.turns
      .map((t) => {
        const label = t.role === "user" ? "User" : "Assistant";
        return `${label}: ${t.content}`;
      })
      .join("\n\n");
  }

  clear(): void {
    this.turns = [];
  }

  get length(): number {
    return this.turns.length;
  }

  getTurns(): ReadonlyArray<Turn> {
    return this.turns;
  }

  replaceOldest(count: number, summary: string): void {
    this.turns.splice(0, count);
    this.turns.unshift({
      role: "assistant",
      content: `[Conversation summary: ${summary}]`,
    });
  }
}
