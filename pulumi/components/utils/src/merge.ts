export type DeepPartial<T> =
  T extends (infer E)[]
    ? DeepPartial<E>[]
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

export function deepMerge<D extends object>(
  defaults: D,
  user?: DeepPartial<D>
): D {
  // if there's nothing to merge, return the defaults verbatim
  if (user === undefined || user === null) return defaults;

  const result: any = { ...defaults };        // shallow clone first layer

  for (const [key, userVal] of Object.entries(user) as
         [keyof D, any][]) {

    const defaultVal = (defaults as any)[key];

    // Both values are plain objects → recurse
    if (isPlainObject(defaultVal) && isPlainObject(userVal)) {
      result[key] = deepMerge(defaultVal, userVal);
    } else {
      // Otherwise the user's value wins (arrays are leafs here)
      result[key] = userVal;
    }
  }

  return result as D;
}

/** Narrow test for a *plain* object (created with `{}` or `new Object()`) */
function isPlainObject(value: unknown): value is object {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
