// middleware.ts — Vercel Routing Middleware (runs on ALL routes, any framework,
// before the cache) gating the whole static Quartz site with HTTP Basic Auth.
// FREE — no Vercel Pro/SSO. Verified: vercel.com/docs/routing-middleware (framework=all,
// runs on statically generated content) + /routing-middleware/api (root file, default
// export, matcher, may return a Response). The vault is PRIVATE memory — this is the gate.
//
// Set in Vercel env vars: SITE_PASSWORD (required), SITE_USER (optional, default "admin").
// Never commit the password.

export const config = {
  // Gate everything except Vercel internals + favicon — so HTML, JS, CSS, fonts AND
  // the graph's data files are all behind auth. (No _next/* on the "Other" preset.)
  matcher: ['/((?!_vercel|favicon.ico).*)'],
}

export default function middleware(request: Request): Response | undefined {
  const USER = process.env.SITE_USER || 'admin'
  const PASS = process.env.SITE_PASSWORD

  const auth = request.headers.get('authorization') || ''
  if (PASS && auth.startsWith('Basic ')) {
    const [user, pass] = atob(auth.slice(6)).split(':')
    if (user === USER && pass === PASS) return undefined // pass through to the static asset
  }

  return new Response('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Private Wiki", charset="UTF-8"' },
  })
}
