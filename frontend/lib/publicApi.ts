import axios from "axios";

// Public-only axios instance — never attaches an auth token. Used by the
// unauthenticated booking/demo-call/track pages, which always resolve the
// practitioner from a slug or tracking token in the URL, never from a
// logged-in session.
const publicApi = axios.create({
    baseURL: process.env.NEXT_PUBLIC_API_URL || "/api/v1",
});

export default publicApi;
