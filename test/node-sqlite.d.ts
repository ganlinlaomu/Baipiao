// Minimal types for Node's built-in SQLite (the project types target Workers).
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
  }
}
