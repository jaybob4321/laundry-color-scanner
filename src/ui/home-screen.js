/** Home: Scan Clothing, Upload Photo, privacy note, offline/install/update status. */
import { $ } from './dom.js';

export function createHomeScreen(app) {
  $('#btn-scan').addEventListener('click', () => app.go('camera'));
  $('#btn-upload').addEventListener('click', () => app.pickFile());
  $('#btn-settings').addEventListener('click', () => app.go('settings'));
  $('#btn-apply-update').addEventListener('click', () => app.pwa.applyUpdate());
  $('#btn-install').addEventListener('click', () => app.pwa.promptInstall());

  const privacy = $('#privacy-note');
  const privacyText = app.aiEnabled
    ? 'Photos stay on this device unless you choose AI review.'
    : 'Photos are analyzed on this device and never uploaded.';
  privacy.lastChild.textContent = privacyText;

  let visited = false;
  return {
    enter() {
      app.releaseImage();
      // Move focus to the heading when returning Home (not on first load).
      if (visited) $('#home-title').focus({ preventScroll: true });
      visited = true;
    },
    cancel() {},
  };
}
