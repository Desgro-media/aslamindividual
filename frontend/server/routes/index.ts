import { registerDashboardRoutes } from "./dashboard";
import { registerPractitionerRoutes } from "./practitioner";
import { registerPublicRoutes } from "./public";
import { registerWorkflowRoutes } from "./workflow";

// Registers every route. Safe to call repeatedly: a route registered again
// replaces the earlier registration in place (see router.ts), which keeps the
// table current across Next's dev-mode hot reloads.
export function registerRoutes(): void {
    // Order matters where a static path and a `:param` path overlap: the static
    // route must be registered first (e.g. /appointments/manual before /appointments/:id).
    registerPublicRoutes();
    registerWorkflowRoutes();
    registerDashboardRoutes();
    registerPractitionerRoutes();
}
