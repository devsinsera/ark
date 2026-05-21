import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Lives at sinsera.co/ark/ on HostGator (in public_html/ark/).
// base='/ark/' so all built asset URLs are prefixed with /ark/.
export default defineConfig({
  base: '/ark/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
