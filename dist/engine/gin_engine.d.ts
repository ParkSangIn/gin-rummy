/* tslint:disable */
/* eslint-disable */

/**
 * Evaluate an imported opening decision without requiring the original
 * hidden deck or opponent hand. This is the first bridge from a PlayOK
 * recording into the same candidate/ranking data used by the in-app review.
 */
export function assess_recorded_upcard(record_json: string): string;

/**
 * Returns the current player-safe state without mutating the game.
 */
export function current_game(): string;

/**
 * Starts the next hand of the active match. A completed match must be
 * restarted with `start_game`, preserving the engine's score settlement.
 */
export function next_hand(): string;

/**
 * Starts a new 100-point match with the first dealer chosen randomly.
 */
export function start_game(): string;

/**
 * Applies one player action encoded as the documented JSON request.
 */
export function submit_action(request_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly assess_recorded_upcard: (a: number, b: number) => [number, number, number, number];
    readonly current_game: () => [number, number, number, number];
    readonly next_hand: () => [number, number, number, number];
    readonly start_game: () => [number, number, number, number];
    readonly submit_action: (a: number, b: number) => [number, number, number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
