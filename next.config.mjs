/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // the runtime singleton (trie/buffer) should init once, not twice
  // pg and ioredis are native-ish server deps; keep them external to the bundle
  serverExternalPackages: ['pg', 'ioredis'],
};

export default nextConfig;
