type Entry = { id: string; [key: string]: unknown };

function entryKey(entry: Entry): string {
  return JSON.stringify([entry.hostId, entry.sessionId, entry.id]);
}

class FixtureEntries extends Map<string, Entry> {
  override set(_id: string, entry: Entry): this {
    return super.set(entryKey(entry), entry);
  }
  override get(id: string): Entry | undefined {
    return super.get(id) ?? [...this.values()].find((entry) => entry.id === id);
  }
  override has(id: string): boolean {
    return this.get(id) !== undefined;
  }
  override delete(id: string): boolean {
    const entry = this.get(id);
    return entry !== undefined && super.delete(entryKey(entry));
  }
}
type FakeRequest = {
  result?: unknown;
  error?: unknown;
  onsuccess?: () => void;
  onerror?: () => void;
};

/** One IDB store: queued transactions, read-your-writes, unique adds, and atomic commit/abort. */
export function fakeIndexedDB() {
  const idb = {
    entries: new FixtureEntries(),
    hold: false,
    held: [] as (() => void)[],
    upgraded: false,
    failWrites: false,
    failReads: false,
  };
  const transactions: (() => void)[] = [];
  let active = false;
  const release = () => {
    for (const commit of idb.held.splice(0)) commit();
  };
  const startNext = () => {
    if (active || transactions.length === 0) return;
    active = true;
    transactions.shift()!();
  };
  const db = {
    createObjectStore() {},
    close() {},
    transaction(_store: string, mode = "readonly") {
      const requests: (() => void)[] = [];
      let data: Map<string, Entry>;
      let pending = 0;
      let finished = false;
      let writing = false;
      const finish = () => {
        active = false;
        startNext();
      };
      const abort = (
        error: unknown = new DOMException("Transaction aborted", "AbortError"),
      ) => {
        if (finished) return;
        finished = true;
        transaction.error = error;
        transaction.onabort?.();
        finish();
      };
      const commit = () => {
        if (finished) return;
        if (idb.failWrites && writing)
          return abort(new DOMException("Commit failed", "QuotaExceededError"));
        finished = true;
        if (writing) {
          idb.entries.clear();
          for (const [id, value] of data) idb.entries.set(id, value);
        }
        transaction.oncomplete?.();
        finish();
      };
      let committing = false;
      const settle = () =>
        queueMicrotask(() => {
          if (pending > 0 || finished || committing) return;
          committing = true;
          if (idb.hold) idb.held.push(commit);
          else commit();
        });
      const request = (operation: () => unknown, write = false) => {
        if (finished || committing)
          throw new DOMException(
            "Transaction inactive",
            "TransactionInactiveError",
          );
        if (write && mode !== "readwrite")
          throw new DOMException("Readonly transaction", "ReadOnlyError");
        const request: FakeRequest = {};
        pending++;
        const run = () =>
          queueMicrotask(() => {
            if (finished) return;
            pending--;
            try {
              if (idb.failReads && !write)
                throw new DOMException("Read failed", "UnknownError");
              request.result = operation();
              writing ||= write;
            } catch (error) {
              request.error = error;
              request.onerror?.();
              abort(error);
              return;
            }
            request.onsuccess?.();
            settle();
          });
        if (data) run();
        else requests.push(run);
        return request;
      };
      const transaction: {
        error?: unknown;
        onabort?: () => void;
        oncomplete?: () => void;
        abort: () => void;
        objectStore: () => object;
      } = {
        abort: () => abort(),
        objectStore: () => ({
          put: (value: Entry) => {
            const copy = structuredClone(value);
            return request(() => {
              const key = entryKey(copy);
              data.set(key, copy);
              return key;
            }, true);
          },
          add: (value: Entry) => {
            const copy = structuredClone(value);
            return request(() => {
              const key = entryKey(copy);
              if (data.has(key))
                throw new DOMException("Key already exists", "ConstraintError");
              data.set(key, copy);
              return key;
            }, true);
          },
          delete: (key: string[]) =>
            request(() => {
              data.delete(JSON.stringify(key));
            }, true),
          get: (key: string[]) =>
            request(() => structuredClone(data.get(JSON.stringify(key)))),
          getAll: () =>
            request(() =>
              [...data]
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([, value]) => structuredClone(value)),
            ),
        }),
      };
      transactions.push(() => {
        data = new Map(
          [...idb.entries].map(([id, value]) => [id, structuredClone(value)]),
        );
        for (const run of requests) run();
        settle();
      });
      queueMicrotask(startNext);
      return transaction;
    },
  };
  const open = () => {
    const request: {
      result: typeof db;
      onupgradeneeded?: () => void;
      onsuccess?: () => void;
    } = { result: db };
    queueMicrotask(() => {
      if (!idb.upgraded) request.onupgradeneeded?.();
      idb.upgraded = true;
      request.onsuccess?.();
    });
    return request;
  };
  return Object.assign(idb, { release, open });
}
