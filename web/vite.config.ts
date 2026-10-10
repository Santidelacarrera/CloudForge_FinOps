import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = { '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:3000', changeOrigin: true } };
export default defineConfig({ plugins: [react()], server: { proxy: api }, preview: { proxy: api } });
