// ============================================================================
// Engine Metrics
//
// Port-side performance instrumentation lives in the Flutter layer; this is
// its engine-side counterpart. It measures how the engine spends the slice
// of a command's round-trip that happens inside JavaScript: how long the
// command handler runs, and within a state build, how long each sub-phase
// takes (document serialization, command-state computation, active mark/node
// extraction, and the change-detection JSON.stringify).
//
// Timing is a permanent capability of the engine, not an opt-in diagnostic.
// Every command handle and every state build is measured, and the durations
// ride back on the response (handle) and stateChanged (the full build
// breakdown). Ports may use these to decompose the round-trip they measure
// themselves into transport versus engine-compute, or ignore them entirely —
// the timings field is additive and a port that does not read it is
// unaffected.
//
// Design constraints that shaped this file:
//
//   - Durations only, never timestamps. The engine reports elapsed
//     milliseconds for each phase. It never reports absolute timestamps,
//     because the engine's clock (performance.now(), relative to page load)
//     and the port's clock (Dart DateTime.now(), wall-clock) live in
//     different domains and cannot be compared directly. The port already
//     owns the full round-trip number by measuring send-to-response on its
//     own side; the engine only needs to say how it spent its portion, as
//     deltas. Deltas are domain-independent and safe to cross the wire.
//
//   - Attach timings only where a phase was actually measured. A timer that
//     recorded nothing (an internal path that built state without timing, a
//     non-mutating command) produces an empty object, and the engine omits
//     the timings field entirely for such messages rather than attaching an
//     empty one. This keeps the wire shape honest: a present timings field
//     always carries at least one real measurement.
//
//   - No dependencies. This is a self-contained utility. It does not import
//     from the protocol types; the shape of the wire-facing timings object is
//     defined in types/protocol.ts, and this file produces a plain Record
//     that structurally matches it.
// ============================================================================

/**
 * The canonical phase names the engine measures. Kept as a const object so
 * engine.ts references named phases rather than bare strings, and so the set
 * of measured phases is enumerable in one place.
 *
 * Phase meanings:
 *   - handle:        total time inside the command handler, from dispatch
 *                    entry to just before the response is sent.
 *   - serializeDoc:  the recursive serializeDocument walk of the full tree.
 *   - commandStates: the computeCommandStates sweep (canExec + isActive for
 *                    every command). The prime suspect for per-keystroke cost.
 *   - commandStatesCan:    the canExec half of the sweep alone — the sum, over
 *                    every command, of the editor.can()[name]() dry-run. This
 *                    half builds and discards a trial transaction per command,
 *                    so it is structurally the expensive one and cannot be
 *                    derived from cached state.
 *   - commandStatesActive: the isActive half of the sweep alone — the sum, over
 *                    every command, of editor.isActive(name). This half can in
 *                    principle be derived from the already-computed active
 *                    marks/nodes, so its size bounds how much a derivation
 *                    optimization (option D) can save.
 *   - active:        getActiveMarks + getActiveNodes + getStoredMarks combined.
 *   - docDiff:       the JSON.stringify(doc) change-detection in onTransaction.
 *   - total:         total time inside onTransaction, covering the state build,
 *                    the diff, and the adapter send calls.
 *
 * commandStatesCan and commandStatesActive are sub-phases of commandStates:
 * they are measured inside the same sweep and should sum to approximately the
 * commandStates total (minus the loop's own minor overhead). They exist to
 * answer one question — which half of the sweep dominates — before deciding
 * whether deriving isActive from cached state is worth doing. Once that
 * decision is made they can be removed without affecting the other phases.
 */
export const Phase = {
  handle: "handle",
  serializeDoc: "serializeDoc",
  commandStates: "commandStates",
  commandStatesCan: "commandStatesCan",
  commandStatesActive: "commandStatesActive",
  active: "active",
  docDiff: "docDiff",
  total: "total",
} as const;

export type PhaseName = (typeof Phase)[keyof typeof Phase];

/**
 * The wire-facing shape: a map of phase name to elapsed milliseconds. Only
 * phases that were actually measured during a given operation appear, so a
 * Response that did not build state carries just { handle }, while a
 * stateChanged carries the full build breakdown. The port treats every key
 * as optional for this reason.
 */
export type Timings = Record<string, number>;

/**
 * Read the highest-resolution clock available, in milliseconds.
 *
 * performance.now() is monotonic and sub-millisecond, which matters for the
 * cheaper phases (active, docDiff) that can run well under 1ms — Date.now()
 * has only millisecond resolution and would report many phases as 0. The
 * Date.now() fallback keeps the utility safe in any runtime that lacks the
 * performance global (a stripped-down embedding, for instance).
 *
 * Only the difference between two readings is ever used or reported, so the
 * fact that performance.now() is relative to page load (rather than wall
 * clock) is irrelevant here.
 */
function now(): number {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }
  return Date.now();
}

/**
 * Accumulates phase durations for a single logical operation (one command
 * handle, or one onTransaction). engine.ts creates one PhaseTimer per
 * operation, marks phases as it goes, and reads the accumulated durations
 * out with toTimings() when attaching them to the outgoing message.
 *
 * Three ways to record a phase:
 *
 *   - measure(name, fn): wrap a synchronous block; its return value is passed
 *     through unchanged and its elapsed time is recorded under name. This is
 *     the preferred form — it cannot leak an unbalanced start/stop.
 *
 *   - start(name) / stop(name): for spans that don't correspond to a single
 *     callable block (e.g. timing from handler entry across a switch). stop()
 *     records the elapsed time since the matching start().
 *
 *   - add(name, ms): add a pre-measured duration directly. Used to accumulate
 *     a phase across many small spans within a loop — the caller times each
 *     span itself and folds the elapsed time in, so a single phase total can
 *     be built from per-iteration measurements without one open span spanning
 *     the whole loop. This is how the canExec / isActive sub-phases are summed
 *     across the per-command sweep.
 *
 * Every operation is timed. The only "empty" case is a timer that was never
 * asked to record anything — an internal build path or a message that did no
 * timed work — and hasTimings() reports that so the engine can omit the
 * timings field rather than attach an empty object.
 */
export class PhaseTimer {
  /**
   * Accumulated elapsed milliseconds per phase. A phase measured more than
   * once (the loop-accumulation case via add(), or a repeated measure())
   * accumulates.
   */
  private durations: Map<string, number> = new Map();

  /**
   * Open spans started with start() and awaiting a matching stop(), keyed by
   * phase name, storing the clock reading at start.
   */
  private openSpans: Map<string, number> = new Map();

  /**
   * Time a synchronous function, record its elapsed time under the given
   * phase name, and return its result unchanged. The result pass-through lets
   * callers wrap an existing expression without restructuring it:
   *
   *   const doc = timer.measure(Phase.serializeDoc, () => serializeDocument(state));
   */
  measure<T>(name: PhaseName, fn: () => T): T {
    const startedAt = now();
    const result = fn();
    this.record(name, now() - startedAt);
    return result;
  }

  /**
   * Begin an open span for a phase that isn't a single wrappable block.
   * A second start() for the same name before its stop() overwrites the
   * start reading.
   */
  start(name: PhaseName): void {
    this.openSpans.set(name, now());
  }

  /**
   * Close the open span for a phase and record its elapsed time. No-op when
   * no matching start() is open, so an accidental stop() without start()
   * records nothing rather than a bogus duration.
   */
  stop(name: PhaseName): void {
    const startedAt = this.openSpans.get(name);
    if (startedAt === undefined) {
      return;
    }
    this.openSpans.delete(name);
    this.record(name, now() - startedAt);
  }

  /**
   * Read the current high-resolution clock. Exposed so a caller accumulating
   * a phase across a loop can bracket each iteration's span itself (clock()
   * before, clock() after, add() the difference) without this class needing
   * to know about the loop.
   */
  clock(): number {
    return now();
  }

  /**
   * Add a pre-measured duration to a phase's accumulated total. Used with
   * clock() to sum a phase across many per-iteration spans in a loop.
   */
  add(name: PhaseName, ms: number): void {
    this.record(name, ms);
  }

  /**
   * Add an elapsed duration to a phase's accumulated total.
   */
  private record(name: string, ms: number): void {
    this.durations.set(name, (this.durations.get(name) ?? 0) + ms);
  }

  /**
   * Produce the wire-facing timings object from the recorded phases. Open
   * spans that were never stopped are not included. Returns an empty object
   * when nothing was recorded; callers should gate on hasTimings() so an
   * empty object is never attached to a message.
   */
  toTimings(): Timings {
    const result: Timings = {};
    for (const [name, ms] of this.durations) {
      result[name] = ms;
    }
    return result;
  }

  /**
   * Whether any phase has been recorded. engine.ts uses this to decide
   * whether to attach a timings field at all, so a timer that did no timed
   * work adds nothing to the message and the wire shape stays honest.
   */
  hasTimings(): boolean {
    return this.durations.size > 0;
  }
}
