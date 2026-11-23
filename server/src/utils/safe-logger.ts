function safeIdentifier(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(value)
    ? value
    : undefined;
}

export function logSafeError(context: string, error: unknown, requestId?: unknown) {
  const errorName = error instanceof Error ? safeIdentifier(error.name) : undefined;
  const errorCode = error && typeof error === 'object' && 'code' in error
    ? safeIdentifier(error.code)
    : undefined;

  console.error(JSON.stringify({
    level: 'error',
    context: safeIdentifier(context) ?? 'server.error',
    requestId: safeIdentifier(requestId),
    errorName: errorName ?? 'UnknownError',
    errorCode,
  }));
}
