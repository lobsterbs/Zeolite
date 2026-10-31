/* #533: vitest (vite) treats a query string on a specifier as a
   distinct module instance of the same file, which is how the
   cross-instance messaging test simulates the two bootstrap copies
   that run in one nested engine realm (the parent page's guardChild
   instance and the realm's own bootstrap instance). tsc cannot
   resolve query-bearing specifiers, so this ambient wildcard types
   them as any and the test casts to the real module shape. */
declare module "*?zlinstance";
