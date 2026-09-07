/**
 * config.js — the only file you edit to turn on accounts + Sheets export.
 *
 * Leave it exactly as-is and the app still works: everything is stored in the
 * browser on that one device ("Local" mode). Fill it in and the same progress
 * follows you between your phone and your computer.
 *
 * See README.md → "Turning on sync" for where these values come from.
 */

export const firebaseConfig = {
  apiKey: 'AIzaSyC9_QlBMHtytYK_bHlQ2eb8BN7yJY1onnI',
  authDomain: 'sat-vocab-be75a.firebaseapp.com',
  projectId: 'sat-vocab-be75a',
  appId: '1:612306725918:web:eb2649933174be68f8920f',
};

/**
 * OAuth 2.0 **Web application** client ID from the same Google Cloud project.
 * Only needed for "Export to Google Sheets".
 */
export const googleClientId = '612306725918-0kssc2nknq5o7iotdao65apq8g7gle82.apps.googleusercontent.com';

export const hasSync = () => Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);
export const hasSheets = () => Boolean(googleClientId);
