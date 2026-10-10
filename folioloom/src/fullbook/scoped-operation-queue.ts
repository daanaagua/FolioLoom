/** FIFO for overlapping scopes; independent operations may use spare capacity. */
export class ScopedOperationQueue {
  readonly #pending: Array<{ scopes: readonly string[]; start: () => void }> = [];
  readonly #locked = new Set<string>();
  #active = 0;
  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 3) throw new Error("operation capacity must be between 1 and 3");
  }
  run<T>(scopes: readonly string[], operation: () => Promise<T>): Promise<T> {
    if (!scopes.length || scopes.some(scope => !scope)) return Promise.reject(new Error("operation scope is empty"));
    const unique = [...new Set(scopes)];
    return new Promise<T>((resolve, reject) => {
      this.#pending.push({ scopes: unique, start: () => {
        const finish = () => {
          this.#active--;
          unique.forEach(scope => this.#locked.delete(scope));
          this.#drain();
        };
        void Promise.resolve().then(operation).then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
      } });
      this.#drain();
    });
  }
  #drain(): void {
    const earlier = new Set<string>();
    for (let i = 0; i < this.#pending.length && this.#active < this.capacity;) {
      const item = this.#pending[i]!;
      if (item.scopes.some(scope => this.#locked.has(scope) || earlier.has(scope))) {
        item.scopes.forEach(scope => earlier.add(scope));
        i++;
        continue;
      }
      this.#pending.splice(i, 1);
      this.#active++;
      item.scopes.forEach(scope => this.#locked.add(scope));
      item.start();
    }
  }
}
