const SECRET = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]+|[0-9a-f]{64})/g;

export function redact(value: string): string {
  return value.replace(SECRET, '[redacted]');
}
