export function createUnsubscribedBridgeDatabase() {
  const transaction = {
    update: () => ({ set: () => ({ where: async () => {} }) }),
    execute: async () => ({ rows: [] }),
  };
  return { ...transaction, transaction: async <Result>(callback: (database: typeof transaction) => Promise<Result>) => callback(transaction) };
}
