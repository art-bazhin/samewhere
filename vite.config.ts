import { defineConfig } from 'vite';
import { lightingPlugin } from './scripts/lighting-plugin';

export default defineConfig({ plugins: [lightingPlugin()] });
