import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

const req = (path: string, headers: Record<string, string> = {}, cookie?: string) =>
  new NextRequest(new URL(path, 'http://0.0.0.0:3000'), { headers: { ...headers, ...(cookie ? { cookie } : {}) } });

describe('middleware', () => {
  it('redirects signed-out page visits to /login on the public host with ?next=', () => {
    const res = middleware(req('/chat/abc?x=1', { host: 'estimates.verxyl.com', 'x-forwarded-proto': 'https' }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://estimates.verxyl.com/login?next=%2Fchat%2Fabc%3Fx%3D1');
  });
  it('omits ?next= for the root and passes public pages and sessions through', () => {
    expect(middleware(req('/', { host: '127.0.0.1:8088' })).headers.get('location')).toBe('http://127.0.0.1:8088/login');
    expect(middleware(req('/login')).headers.get('location')).toBeNull();
    expect(middleware(req('/history', {}, 'est_session=abc')).headers.get('location')).toBeNull();
  });
});
