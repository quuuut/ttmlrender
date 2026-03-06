// ─── Entry point ─────────────────────────────────────────────────────────────
// All logic lives in main/*.js — this file just boots the app.
import { initControls } from './main/controls.js';
import { initUploads }  from './main/upload.js';
import { initRenderer } from './main/video-renderer.js';

initControls();
initUploads();
initRenderer();
