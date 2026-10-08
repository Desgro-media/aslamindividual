import { dispatch } from "../../../../server/router";
import { registerRoutes } from "../../../../server/routes";

// The whole REST API (what used to be the Spring Boot backend) is served from
// this one catch-all Route Handler, so the entire product — site and API — is a
// single Vercel deployment. Every request goes through server/router.ts, which
// applies the same filter chain Spring Security did.

export const runtime = "nodejs"; // pg (TCP) and bcrypt need Node, not the Edge runtime
export const dynamic = "force-dynamic"; // never cache an API response
export const maxDuration = 30;

registerRoutes();

const handler = (req: Request) => dispatch(req);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
