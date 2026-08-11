// Type definitions for tui-integration-tests.
// The runtime is plain ESM JavaScript; these types exist for editor
// completion and typos-caught-early, not for a build step.

export interface LaunchConfig {
  /** The executable to run — a compiled binary, or e.g. "node" with args. */
  binary: string;
  args?: string[];
  /** Terminal size. Defaults: 120x40. */
  cols?: number;
  rows?: number;
  /** Working directory for the session. */
  cwd?: string;
  /** Environment overrides (merged over the inherited environment). */
  env?: Record<string, string>;
  /** Override the session name (defaults to a unique generated one). */
  name?: string;
  /** [pattern, replacement] pairs applied to screen()/title() output. */
  normalizers?: Array<[RegExp, string]>;
}

export interface WaitOptions {
  /** Milliseconds before the wait fails. Default 10_000. */
  timeout?: number;
  /** Poll interval in milliseconds. Default 100. */
  interval?: number;
  /** Label used in the timeout error. */
  label?: string;
  /**
   * Consecutive polls that must satisfy the predicate. Default 1 for
   * presence, 3 for waitForGone (a repaint blanks regions for a frame).
   */
  stablePolls?: number;
}

/** Minimal shape of a node:test context — what launch() needs for cleanup. */
export interface TestContextLike {
  after(fn: () => unknown): unknown;
}

export declare class Session {
  constructor(config: LaunchConfig, testContext?: TestContextLike | null);
  readonly name: string;
  pid: number | null;
  /** Path to the driver's asciinema cast of this session, if recorded. */
  recordingPath: string | null;
  normalizers: Array<[RegExp, string]>;

  start(): Promise<this>;
  /** Type literal text as real keystroke bytes. */
  type(text: string): Promise<void>;
  /** Named keys: press("Enter"), press("Ctrl+C"), press("Escape", "q"). */
  press(...keys: string[]): Promise<void>;
  /** Raw bytes straight down the PTY. */
  write(bytes: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  /** The visible screen as text, normalized. Assert against this. */
  screen(): Promise<string>;
  /** The window title (OSC 0/2), normalized. */
  title(): Promise<string>;
  /** Poll until predicate(screen) holds; timeout errors embed the screen. */
  waitFor(predicate: (screen: string) => boolean, opts?: WaitOptions): Promise<string>;
  waitForText(text: string, opts?: WaitOptions): Promise<string>;
  /** Wait until text is absent for stablePolls consecutive polls. */
  waitForGone(text: string, opts?: WaitOptions): Promise<string>;
  /** Wait for the child to exit on its own; timeout errors embed the screen. */
  waitForExit(opts?: { timeout?: number }): Promise<void>;
  /** Kill the child process; the session's screen remains inspectable. */
  kill(): Promise<void>;
  /**
   * Boot the same config as a NEW session against whatever is on disk.
   * Inherits the test context, so auto-cleanup follows across process death.
   */
  respawn(): Promise<Session>;
  close(): Promise<void>;
}

/**
 * Launch a TUI under test. Pass the node:test context as the second argument
 * and the session cleans itself up via t.after() — including sessions
 * produced later by respawn().
 */
export declare function launch(
  config: LaunchConfig,
  testContext?: TestContextLike | null,
): Promise<Session>;

export interface JourneyStep {
  label: string;
  ok: boolean;
  screen: string;
}

export interface Journey {
  /**
   * Run one step; checkpoints the screen when the step finishes (or fails —
   * failing steps flush the storyline before rethrowing). A step returning a
   * Session (e.g. after respawn) becomes the journey's current session.
   */
  step<T>(label: string, fn: () => Promise<T> | T): Promise<T>;
  /** Flush the storyline to .tui-report/journeys for the HTML reporter. */
  end(): Promise<void>;
}

/** A named multi-turn user story with per-step screen checkpoints. */
export declare function journey(session: Session, name: string): Journey;

/** Default screen normalizers: long digit runs, braille spinner glyphs. */
export declare const defaultNormalizers: Array<[RegExp, string]>;
