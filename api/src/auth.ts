import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AuthUser { id: string; orgId: string; roles: string[] }

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signJwt(claims: { sub: string; org: string; roles: string[]; exp?: number }, secret: string): string {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims }));
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

export function verifyJwt(token: string, secret: string): AuthUser {
  const [h, b, s] = token.split('.');
  if (!h || !b || !s) throw new UnauthorizedException('malformed token');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  if (header.alg !== 'HS256') throw new UnauthorizedException('unsupported alg'); // never trust the token's alg
  const expected = createHmac('sha256', secret).update(`${h}.${b}`).digest();
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new UnauthorizedException('bad signature');
  const c = JSON.parse(Buffer.from(b, 'base64url').toString());
  if (typeof c.exp !== 'number' || c.exp < Date.now() / 1000) throw new UnauthorizedException('token expired');
  if (!c.sub || !c.org || !Array.isArray(c.roles)) throw new UnauthorizedException('missing claims');
  return { id: String(c.sub), orgId: String(c.org), roles: c.roles.map(String) };
}

export const Roles = (...roles: string[]) => SetMetadata('roles', roles);

/** Authenticates every route; the organisation always comes from the token, never from the request. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) throw new UnauthorizedException('missing bearer token');
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 16) throw new Error('JWT_SECRET (>=16 chars) must be configured');
    const user = verifyJwt(m[1], secret);
    req.user = user;
    const need = this.reflector.get<string[]>('roles', ctx.getHandler());
    if (need?.length && !need.some((r) => user.roles.includes(r) || user.roles.includes('admin'))) {
      throw new ForbiddenException(`requires one of: ${need.join(', ')}`);
    }
    return true;
  }
}
