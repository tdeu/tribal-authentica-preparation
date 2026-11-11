// PRE-HACKATHON SPIKE — NOT PART OF THE SUBMISSION
import { defineConfig } from 'vite';
export default defineConfig({
  build: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } }, // libauth uses top-level await
  server: { host: true, port: 5180, strictPort: true },
});
