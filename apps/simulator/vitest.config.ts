import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'server', include: ['test/**/*.test.ts'], environment: 'node' }
      },
      {
        extends: true,
        test: { name: 'ui', include: ['test/**/*.test.tsx'], environment: 'jsdom', setupFiles: ['./test/setup-dom.ts'] }
      }
    ]
  }
});
