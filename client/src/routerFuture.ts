/**
 * Opt into the router behaviour that becomes the default in v7, while still on v6.
 *
 * Splitting this from the version bump keeps the two failure modes apart: if the
 * suite goes red here it is a behaviour change, if it goes red on the bump it is
 * the import rewrite. Only the two flags a non-data router understands are listed
 * — the rest (fetcherPersist, normalizeFormMethod, partialHydration,
 * skipActionErrorRevalidation) belong to createBrowserRouter, which TREK doesn't use.
 *
 * Delete this file with the upgrade; in v7 both are simply how the router behaves.
 */
export const ROUTER_FUTURE = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
} as const;
