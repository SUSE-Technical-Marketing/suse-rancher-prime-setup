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

    if (
      userVal !== null &&
      typeof userVal === "object" &&
      !Array.isArray(userVal) &&
      typeof defaultVal === "object" &&
      defaultVal !== null &&
      !Array.isArray(defaultVal)
    ) {
      result[key] = deepMerge(defaultVal, userVal);
    } else if (userVal !== undefined) {
      result[key] = userVal;
    }
  }

  return result as D;
}
