import { resolve } from 'node:path';
import { z } from 'zod';

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  DATABASE_PATH: z.string().trim().min(1).default('./data/sip.sqlite'),
  ALLOWED_HOSTS: z.string().default('localhost,127.0.0.1,[::1]'),
  ALLOWED_ORIGINS: z.string().default(''),
});



export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`환경변수 오류: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const value = parsed.data;
  const split = (s: string) => s.split(',').map((v) => v.trim()).filter(Boolean);
  const allowedHosts = split(value.ALLOWED_HOSTS).map((v) => v.toLowerCase());
  if (allowedHosts.length === 0 || allowedHosts.some((host) => {
    try {
      const url = new URL(`http://${host}`);
      return url.hostname !== host || url.port !== '' || url.pathname !== '/' || url.username !== '' || url.password !== '';
    } catch { return true; }
  })) {
    throw new Error('ALLOWED_HOSTS에는 포트/경로/와일드카드 없이 호스트 이름을 지정해 주세요.');
  }
  const allowedOrigins = split(value.ALLOWED_ORIGINS);
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new Error('ALLOWED_ORIGINS에는 http(s)://호스트[:포트] 형식의 Origin을 지정해 주세요.');
    }
  }
  return {
    port: value.PORT,
    host: value.HOST,
    databasePath: resolve(value.DATABASE_PATH),
    allowedHosts,
    allowedOrigins,
  };
}

export type Config = ReturnType<typeof readConfig>;
