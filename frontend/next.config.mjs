/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  // The REST API now lives inside this app (app/api/v1/[...path]) instead of a
  // separate Spring Boot service, so there is no backend to proxy to any more.
  async rewrites() {
    return [
      // Keeps any uptime monitor that still pings the old Spring Actuator URL working.
      { source: '/actuator/health', destination: '/api/v1/health' },
    ];
  },
};

export default nextConfig;
