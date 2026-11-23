type FollowTicket = {
  owner: string;
  gesture: number;
  navigation: number;
};

/** Fences accepted sends against reading gestures and navigation after submission. */
export class TranscriptFollowIntents {
  private gestures = new Map<string, number>();
  private selection: string | undefined;
  private navigation = 0;

  select(selection: string) {
    if (this.selection !== selection) {
      this.selection = selection;
      this.navigation++;
    }
  }

  begin(owner: string): FollowTicket {
    return {
      owner,
      gesture: this.gestures.get(owner) ?? 0,
      navigation: this.navigation,
    };
  }

  gesture(owner: string) {
    this.gestures.set(owner, (this.gestures.get(owner) ?? 0) + 1);
  }

  accepts(ticket: FollowTicket): boolean {
    return (
      this.navigation === ticket.navigation &&
      (this.gestures.get(ticket.owner) ?? 0) === ticket.gesture
    );
  }

  retain(owners: ReadonlySet<string>) {
    for (const owner of this.gestures.keys())
      if (!owners.has(owner)) this.gestures.delete(owner);
  }
}
