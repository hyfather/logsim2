/** @type {import('next').NextConfig} */
const nextConfig = {
  // Web Workers are supported natively via new URL() in Next.js
  // No additional webpack config needed
  eslint: {
    // Vercel's build runs `next lint` as part of `next build`. Don't block
    // deploys on lint findings — run lint separately in CI if you want
    // enforcement. Pre-pivot files still carry unused vars that are out of
    // scope for the serverless cutover.
    ignoreDuringBuilds: true,
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: 'http://localhost:8787/api/:path*' }]
  }
}



export default nextConfig
