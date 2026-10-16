/** Error messages can carry upstream or credential text; logs keep only the error's shape. */
function errorShape(error: unknown) {
  return error instanceof Error
    ? `${error.name}${"code" in error && typeof error.code === "string" ? ` (${error.code})` : ""}`
    : typeof error;
}

export function logFailure(operation: string, error: unknown) {
  console.error(`${operation}: ${errorShape(error)}`);
}
