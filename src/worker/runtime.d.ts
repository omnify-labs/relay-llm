// Use Cloudflare's importable runtime declarations without replacing Node's Web globals.
declare module 'cloudflare:workers' {
  import { CloudflareWorkersModule } from '@cloudflare/workers-types';
  export = CloudflareWorkersModule;
}
