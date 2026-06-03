export function resolveVariables(input: string, variables: Record<string, string>): string {
  return input.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match;
  });
}
