import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { CodeMessages, Codes, type Code } from '@multicam/shared';

const HTTP_STATUS: Partial<Record<Code, number>> = {
  '1001': 500,
  '1002': 400,
  '1003': 400,
  '1004': 400,
  '1005': 500,
  '1006': 413,
  '1007': 500,
  '1009': 403,
  '1012': 429,
  '9993': 400,
  '9995': 404,
  '9996': 409,
  '9997': 405,
  '9998': 401,
  '9999': 500,
  '2001': 404,
  '2002': 409,
  '2003': 409,
  '2004': 403,
  '2005': 410,
  '2006': 409,
  '3001': 404,
  '3002': 409,
  '3003': 422,
  '3004': 507,
  '4001': 404,
  '4002': 409,
};

export class AppError extends Error {
  constructor(
    public readonly code: Code,
    public readonly data: unknown = {},
    message?: string,
  ) {
    super(message ?? CodeMessages[code]);
  }
}

export const fail = (code: Code, data: unknown = {}, message?: string) => new AppError(code, data, message);

export function send<T>(res: Response, data: T, code: Code = Codes.OK, message?: string) {
  res.status(HTTP_STATUS[code] ?? 200).json({ code, message: message ?? CodeMessages[code], data });
}

/** Lỗi Zod → 1002 (thiếu tham số) / 1003 (sai kiểu) / 1004 (sai giá trị), kèm field để báo đúng ô. */
export function zodToAppError(error: ZodError): AppError {
  const issue = error.issues[0];
  const field = issue.path.join('.') || null;
  if (issue.code === 'invalid_type') {
    const missing = issue.received === 'undefined' || issue.received === 'null';
    return fail(missing ? Codes.PARAM_NOT_ENOUGH : Codes.PARAM_TYPE_INVALID, { field, reason: issue.message });
  }
  if (issue.code === 'invalid_union') {
    // vd. confirm/grant_control thiếu hoặc khác true
    return fail(Codes.PARAM_VALUE_INVALID, { field, reason: issue.message });
  }
  return fail(Codes.PARAM_VALUE_INVALID, { field, reason: issue.message });
}

export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) throw zodToAppError(result.error);
  return result.data;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) return send(res, err.data, err.code, err.message);
  if (err instanceof ZodError) {
    const e = zodToAppError(err);
    return send(res, e.data, e.code);
  }
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.parse.failed') return send(res, {}, Codes.PARAM_TYPE_INVALID, 'Body is not valid JSON');
  if (e?.type === 'entity.too.large') return send(res, {}, Codes.FILE_TOO_BIG);
  if (err instanceof Prisma.PrismaClientInitializationError) return send(res, {}, Codes.DB_CONNECT);
  console.error('[error]', err);
  return send(res, {}, Codes.EXCEPTION);
}

export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

export function baseUrl(req: Request): string {
  return `${req.protocol}://${req.get('host')}`;
}
