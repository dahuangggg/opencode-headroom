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
