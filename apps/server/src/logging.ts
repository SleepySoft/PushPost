import type { Writable } from 'node:stream';

export function redactingStream(destination: Writable, env: NodeJS.ProcessEnv = process.env): Writable {
  const secrets = Object.entries(env)
    .filter(([name, value]) => Boolean(value) && value!.length >= 4
      && (/SECRET|PASSWORD|TOKEN|PRIVATE_KEY/.test(name) || /^PUSHPOST_.*(?:USERNAME|APP_PASSWORD)$/.test(name)))
    .map(([, value]) => value!)
    .sort((a, b) => b.length - a.length);
  const redact = (value: string): string => {
    let result = value.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1<credentials>@');
    for (const secret of secrets) result = result.split(secret).join('[redacted]');
    return result;
  };
  return {
    write(chunk: unknown, encoding?: BufferEncoding, callback?: (error?: Error | null) => void): boolean {
      const value = redact(String(chunk));
      return encoding === undefined ? destination.write(value, callback) : destination.write(value, encoding, callback);
    },
  } as Writable;
}
