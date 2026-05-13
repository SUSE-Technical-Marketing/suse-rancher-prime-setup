import * as pulumi from "@pulumi/pulumi";

export const flattenOutput = <T>(
  o: pulumi.Output<pulumi.Output<T>>
): pulumi.Output<T> => o.apply(x => x);
