export function largeJsonArrayFixture(): string {
  const rows = Array.from({ length: 80 }, (_, index) => ({
    id: index + 1,
    level: index === 41 ? "ERROR" : "INFO",
    message:
      index === 41
        ? "auth failed for token refresh"
        : `normal event ${index + 1}`,
    service: "api",
    region: "us-east-1",
  }));
  rows[25] = { ...rows[25], extra: "shape change" };
  return JSON.stringify(rows, null, 2);
}

export function searchFixture(): string {
  const auth = Array.from(
    { length: 70 },
    (_, index) =>
      `src/auth.ts:${index + 1}:${
        index === 34 ? "ERROR auth token rejected" : `auth event ${index + 1}`
      }`,
  );
  const db = Array.from(
    { length: 40 },
    (_, index) => `src/db.ts:${index + 1}:db query ${index + 1}`,
  );
  return [...auth, ...db].join("\n");
}

export function logFixture(): string {
  const info = Array.from(
    { length: 100 },
    (_, index) => `INFO processing item ${index + 1}`,
  );
  return [
    "============================= test session starts =============================",
    ...info.slice(0, 40),
    "WARNING auth retry scheduled",
    "ERROR critical auth failure",
    "Traceback (most recent call last):",
    '  File "app.py", line 10, in main',
    "ValueError: token rejected",
    ...info.slice(40),
    "2 failed, 1 warning",
  ].join("\n");
}

export function textFixture(): string {
  return [
    "# Build Report",
    "The build processed many modules successfully.",
    ...Array.from(
      { length: 60 },
      (_, index) => `Module ${index + 1} completed with routine output.`,
    ),
    "Security warning: auth token rotation is required.",
    "Action required: fix retry backoff before release.",
    "The final deployment summary is ready.",
  ].join("\n\n");
}
