import axios from 'axios';
import { clearSession } from './authSession';

const api = axios.create({
    baseURL: process.env.NEXT_PUBLIC_API_URL || '/api/v1',
});

// Add a request interceptor to attach JWT token
api.interceptors.request.use(
    (config) => {
        if (typeof window !== 'undefined') {
            const token = localStorage.getItem('token');
            if (token) {
                config.headers['Authorization'] = `Bearer ${token}`;
            }
        }
        return config;
    },
    (error) => Promise.reject(error)
);

// Response interceptor: any 401 in an admin area means the token is
// expired or invalid — clear it and send the user to login. A 402 means the
// token is still valid but the subscription has lapsed (see
// SubscriptionAccessFilter on the backend) — that's a different problem, so
// it gets a different destination: the renew screen, not a logged-out state.
api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (typeof window === 'undefined') return Promise.reject(error);

        const path = window.location.pathname;
        // Two separate gated areas with two separate login screens. The
        // practitioner dashboard signs back in at /login; the platform-admin
        // console at /admin. Sending an expired admin to /login would be wrong
        // twice over — /login refuses admin credentials outright, and the
        // console's URL is deliberately not advertised from there.
        const inConsole   = path.startsWith('/admin');
        const inDashboard = path.startsWith('/dashboard');
        const loginPath   = inConsole ? '/admin' : '/login';
        // The login screens themselves must never redirect to themselves —
        // /auth/me 401ing there is the normal "no valid session" answer, not a
        // failure. '/admin' is an exact match because it IS the console's
        // login page, while '/admin/dashboard' is gated content.
        const onLoginPage = path === '/login' || path === '/admin';

        if (error.response?.status === 401 && !onLoginPage && (inDashboard || inConsole)) {
            const hadToken = !!localStorage.getItem('token');
            clearSession();
            window.location.href = hadToken ? `${loginPath}?expired=1` : loginPath;
            return new Promise(() => {});
        }

        // 402 = valid session, lapsed subscription. Only ever applies to a
        // tenant: SubscriptionAccessFilter exempts the superadmin, so a
        // console page can't produce one — and bouncing the console to a
        // tenant's renew screen would strand it there.
        if (error.response?.status === 402 && !inConsole
                && !path.startsWith('/dashboard/subscription')) {
            window.location.href = '/dashboard/subscription?locked=1';
            return new Promise(() => {});
        }

        return Promise.reject(error);
    }
);

export default api;