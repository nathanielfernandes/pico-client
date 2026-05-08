// Shared helpers for the framework-specific store factories
// (svelte.svelte.ts, react.ts). Kept tiny + pure so it can be
// unit-tested without spinning up a renderer.

export type NameFn<Ctx, A extends unknown[]> =
  | string
  | ((ctx: Ctx, ...args: A) => string);

export function resolveName<Ctx, A extends unknown[]>(
  name: NameFn<Ctx, A>,
  ctx: Ctx,
  args: A,
): string {
  return typeof name === "function" ? name(ctx, ...args) : name;
}
